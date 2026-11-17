import * as core from '@actions/core'
import {
  Bitrix24Client,
  BitrixApiError,
  assertDocumentLimits,
  Document,
} from './bitrix'
import {
  buildLocalTree,
  loadManifest,
  saveManifest,
  sha256,
  Manifest,
  ManifestEntry,
} from './content'
import { commitManifest } from './git'

const ENTITY_NOT_FOUND = 'BITRIX_REST_V3_EXCEPTION_ENTITYNOTFOUNDEXCEPTION'

interface Stats {
  created: number
  updated: number
  archived: number
  unchanged: number
}

async function main(): Promise<void> {
  const webhookUrl = core.getInput('webhook-url', { required: true })
  const collectionIdInput = core.getInput('collection-id')
  const collectionTitle = core.getInput('collection-title')
  const contentDir = core.getInput('content-dir') || 'docs'
  const manifestPath = core.getInput('manifest-path') || '.kb-manifest.json'
  const deleteRemoved = core.getInput('delete-removed') !== 'false'
  const maxRetries = parseInt(core.getInput('max-retries') || '5', 10)

  const client = new Bitrix24Client(webhookUrl, { maxRetries })

  // 1. Resolve the target knowledge base
  let collectionId = collectionIdInput ? Number(collectionIdInput) : null
  if (!collectionId) {
    core.info(`Looking up knowledge base "${collectionTitle}"...`)
    const existing = await client.findCollectionByTitle(collectionTitle)
    if (existing) {
      collectionId = existing.id
      core.info(`Found knowledge base #${collectionId}`)
    } else {
      core.info('Not found, creating...')
      const created = await client.createCollection(collectionTitle)
      collectionId = created.id
      core.info(`Created knowledge base #${collectionId}`)
    }
  }

  // 2. Build the desired page tree from the repo
  const localNodes = buildLocalTree(contentDir)
  core.info(`Content: ${localNodes.length} page(s) under "${contentDir}"`)
  if (localNodes.length === 0) {
    core.warning(`No markdown pages found in "${contentDir}" — nothing to deploy.`)
  }

  const manifest: Manifest = loadManifest(manifestPath)
  const stats: Stats = { created: 0, updated: 0, archived: 0, unchanged: 0 }
  const localKeys = new Set(localNodes.map((n) => n.key))

  // 3. Create / update pages top-down (parents always precede children)
  for (const node of localNodes) {
    assertDocumentLimits(node.title, node.markdown, node.key)
    const hash = sha256(node.markdown)
    const parentEntry: ManifestEntry | undefined = node.parentKey
      ? manifest.nodes[node.parentKey]
      : undefined
    const parentId = node.parentKey ? (parentEntry?.id ?? null) : null
    const existing = manifest.nodes[node.key]

    if (existing?.id) {
      let remote: Document | null = null
      try {
        remote = await client.getDocument(existing.id)
      } catch (err) {
        if (!(err instanceof BitrixApiError) || err.code !== ENTITY_NOT_FOUND) throw err
        core.info(`"${node.key}": document #${existing.id} no longer exists, recreating`)
      }

      if (remote && remote.state === 'live' && existing.sha === hash) {
        stats.unchanged += 1
        continue
      }

      if (remote && remote.state === 'live') {
        await client.updateDocument(existing.id, {
          title: node.title,
          markdown: node.markdown,
        })
        manifest.nodes[node.key] = { id: existing.id, sha: hash }
        stats.updated += 1
        core.info(`Updated "${node.key}" (#${existing.id})`)
      } else {
        // Document was archived/trashed or disappeared: create a fresh one
        const created = await client.addDocument({
          collectionId,
          title: node.title,
          parentId,
          markdown: node.markdown,
        })
        manifest.nodes[node.key] = { id: created.id, sha: hash }
        stats.created += 1
        core.info(`Re-created "${node.key}" (#${created.id})`)
      }
    } else {
      const created = await client.addDocument({
        collectionId,
        title: node.title,
        parentId,
        markdown: node.markdown,
      })
      manifest.nodes[node.key] = { id: created.id, sha: hash }
      stats.created += 1
      core.info(`Created "${node.key}" (#${created.id})`)
    }
  }

  // 4. Archive pages removed from the repo (works on the whole subtree)
  if (deleteRemoved) {
    for (const [key, entry] of Object.entries(manifest.nodes)) {
      if (localKeys.has(key)) continue
      try {
        await client.archiveDocument(entry.id)
        stats.archived += 1
        core.info(`Archived removed page "${key}" (#${entry.id})`)
      } catch (err) {
        if (err instanceof BitrixApiError && err.code === ENTITY_NOT_FOUND) {
          core.info(`Removed page "${key}" (#${entry.id}) already gone`)
        } else {
          throw err
        }
      }
      delete manifest.nodes[key]
    }
  }

  // 5. Persist manifest + outputs + job summary
  saveManifest(manifestPath, manifest)

  // Commit the manifest back so IDs stay stable between runs
  try {
    await commitManifest(manifestPath, core.getInput('github-token'))
  } catch (err) {
    core.warning(
      `Manifest was not committed back: ${(err as Error).message}. ` +
        'Next run may recreate existing pages — check the "github-token" permissions (contents: write).'
    )
  }

  core.setOutput('collection-id', String(collectionId))
  core.setOutput('created', String(stats.created))
  core.setOutput('updated', String(stats.updated))
  core.setOutput('archived', String(stats.archived))
  core.setOutput('unchanged', String(stats.unchanged))

  try {
    await core.summary
      .addHeading('Bitrix24 Knowledge Base 2.0 deploy')
      .addTable([
        [{ data: 'Metric', header: true }, { data: 'Count', header: true }],
        ['Created', String(stats.created)],
        ['Updated', String(stats.updated)],
        ['Archived', String(stats.archived)],
        ['Unchanged', String(stats.unchanged)],
      ])
      .addLink('Knowledge base in Bitrix24', webhookUrl.replace(/\/rest\/api\/.*$/, '/kb/'))
      .write()
  } catch {
    // Job summaries are unavailable outside the GitHub Actions runner — not fatal
  }

  core.info(
    `Done: ${stats.created} created, ${stats.updated} updated, ${stats.archived} archived, ${stats.unchanged} unchanged.`
  )
}

main()
  .then(() => {
    // fetch keeps keep-alive sockets open; exit explicitly once work is done
    process.exit(0)
  })
  .catch((err: unknown) => {
    core.setFailed(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
