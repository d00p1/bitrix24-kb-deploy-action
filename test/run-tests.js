'use strict'

/**
 * Integration test: runs dist/index.js against a mock Bitrix24 REST 3.0 server.
 * Covers: create hierarchy, idempotent re-run, update, delete-removed, 429 retry.
 */

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

const DIST = path.join(__dirname, '..', 'dist', 'index.js')
const PORT = 18321
const WEBHOOK = `http://127.0.0.1:${PORT}/rest/api/1/testtoken`

let nextDocId = 100
const docs = new Map() // id -> doc
const collections = new Map() // id -> {id,title}
let collectionsAdded = 0
let flakyMode = false
let flakyCallsLeft = 0

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const payload = JSON.parse(body || '{}')
    const method = req.url.replace(/^\/rest\/api\/1\/testtoken\//, '')
    res.setHeader('Content-Type', 'application/json')

    // Flaky endpoint: first call fails with 429, second succeeds
    if (flakyMode && method === 'note.document.get' && flakyCallsLeft > 0) {
      flakyCallsLeft -= 1
      res.writeHead(429).end(JSON.stringify({ error: { code: 'QUERY_LIMIT_EXCEEDED', message: 'slow down' } }))
      return
    }

    const ok = (result) => res.end(JSON.stringify({ result }))
    const fail = (code, msg) => res.writeHead(400).end(JSON.stringify({ error: { code, message: msg } }))

    switch (method) {
      case 'note.collection.list':
        return ok({ items: [...collections.values()] })
      case 'note.collection.add': {
        collectionsAdded += 1
        const id = collectionsAdded
        collections.set(id, { id, title: payload.fields.title })
        return ok({ item: { id, ...payload.fields } })
      }
      case 'note.document.add': {
        const id = ++nextDocId
        const doc = { id, state: 'live', ...payload.fields }
        docs.set(id, doc)
        return ok({ item: doc })
      }
      case 'note.document.get': {
        const doc = docs.get(payload.id)
        return doc ? ok({ item: doc }) : fail('BITRIX_REST_V3_EXCEPTION_ENTITYNOTFOUNDEXCEPTION', 'not found')
      }
      case 'note.document.update': {
        const doc = docs.get(payload.id)
        if (!doc) return fail('BITRIX_REST_V3_EXCEPTION_ENTITYNOTFOUNDEXCEPTION', 'not found')
        Object.assign(doc, payload.fields)
        return ok({ item: doc })
      }
      case 'note.document.archive': {
        const doc = docs.get(payload.id)
        if (!doc) return fail('BITRIX_REST_V3_EXCEPTION_ENTITYNOTFOUNDEXCEPTION', 'not found')
        doc.state = 'archived'
        return ok({})
      }
      default:
        return fail('ERROR_METHOD_NOT_FOUND', method)
    }
  })
})

async function runAction(workspace, extraEnv = {}) {
  const env = {
    ...process.env,
    'INPUT_WEBHOOK-URL': WEBHOOK,
    'INPUT_COLLECTION-TITLE': 'Test KB',
    'INPUT_CONTENT-DIR': 'docs',
    'INPUT_MANIFEST-PATH': '.kb-manifest.json',
    'INPUT_DELETE-REMOVED': 'true',
    ...Object.fromEntries(
      Object.entries(extraEnv).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])
    ),
  }
  const { stdout } = await execFileAsync(process.execPath, [DIST], {
    cwd: workspace,
    env,
    encoding: 'utf8',
  })
  return stdout
}

function write(workspace, rel, content) {
  const abs = path.join(workspace, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

function readManifest(workspace) {
  return JSON.parse(fs.readFileSync(path.join(workspace, '.kb-manifest.json'), 'utf8'))
}

async function main() {
  await new Promise((resolve) => server.listen(PORT, resolve))
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-deploy-test-'))

  try {
    // --- 1. Initial deploy: hierarchy -------------------------------------
    write(workspace, 'docs/index.md', '# Welcome\n\nRoot page.\n')
    write(workspace, 'docs/guide/index.md', '# Guide\n')
    write(workspace, 'docs/guide/install.md', '---\ntitle: Installation\n---\n\nRun the installer.\n')

    let out = await runAction(workspace)
    assert.match(out, /Found knowledge base #1|Created knowledge base #1/)
    let manifest = readManifest(workspace)
    assert.ok(manifest.nodes['index.md'], 'root index page')
    assert.ok(manifest.nodes['guide/'], 'guide dir page')
    assert.ok(manifest.nodes['guide/install.md'], 'install page')
    assert.strictEqual(docs.size, 3, '3 documents created')

    const guidePage = docs.get(manifest.nodes['guide/'].id)
    const installPage = docs.get(manifest.nodes['guide/install.md'].id)
    assert.strictEqual(installPage.parentId, guidePage.id, 'install page nested under guide')
    assert.strictEqual(guidePage.parentId, null, 'guide page is top-level')
    assert.strictEqual(installPage.title, 'Installation', 'title from front matter')

    // --- 2. Idempotent re-run: everything unchanged ------------------------
    out = await runAction(workspace)
    assert.match(out, /Done: 0 created, 0 updated, 0 archived, 3 unchanged/)
    assert.strictEqual(docs.size, 3, 'no duplicates created')

    // --- 3. Update one file, add one file ----------------------------------
    write(workspace, 'docs/guide/install.md', '---\ntitle: Installation\n---\n\nNew content.\n')
    write(workspace, 'docs/faq.md', '# FAQ\n')
    out = await runAction(workspace)
    assert.match(out, /Done: 1 created, 1 updated, 0 archived, 2 unchanged/)
    assert.strictEqual(docs.get(installPage.id).markdown.includes('New content.'), true, 'update hit the same document')

    // --- 4. Remove a file -> archived --------------------------------------
    fs.unlinkSync(path.join(workspace, 'docs/faq.md'))
    out = await runAction(workspace)
    assert.match(out, /Done: 0 created, 0 updated, 1 archived, 3 unchanged/)
    const faqId = [...docs.values()].find((d) => d.title === 'faq').id
    assert.strictEqual(docs.get(faqId).state, 'archived')

    // --- 5. Manifest id pointing to a deleted doc -> recreated -------------
    const manifestBefore = readManifest(workspace)
    docs.delete(manifestBefore.nodes['guide/'].id) // simulate external deletion
    out = await runAction(workspace)
    assert.match(out, /recreating/)
    const manifestAfter = readManifest(workspace)
    assert.notStrictEqual(
      manifestAfter.nodes['guide/'].id,
      manifestBefore.nodes['guide/'].id,
      'new id after recreate'
    )

    // --- 6. 429 retry on note.document.get ---------------------------------
    flakyMode = true
    flakyCallsLeft = 1
    out = await runAction(workspace)
    assert.match(out, /unchanged/)
    flakyMode = false

    console.log('All tests passed ✔')
  } finally {
    server.close()
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
