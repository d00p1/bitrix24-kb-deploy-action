import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

const INDEX_FILES = ['index.md', 'README.md']

/** A page derived from the repository (file or directory). */
export interface LocalNode {
  /** Repo-relative key. Directories end with "/". */
  key: string
  title: string
  markdown: string
  /** Key of the parent page, null for top-level pages. */
  parentKey: string | null
}

export interface ManifestEntry {
  id: number
  sha: string
}

export interface Manifest {
  version: 1
  nodes: Record<string, ManifestEntry>
}

/**
 * Builds the desired page tree from the content directory.
 *
 * Rules:
 * - every directory under contentDir becomes a page (title = dir name,
 *   content = its index.md / README.md if present, otherwise empty)
 * - every other .md file becomes a page (title = front matter `title:` or
 *   the file name without extension)
 * - parent of a page = the page of the nearest ancestor directory
 *
 * Parents always precede children in the returned array.
 */
export function buildLocalTree(contentDir: string): LocalNode[] {
  const root = path.resolve(contentDir)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`content-dir not found or not a directory: ${contentDir}`)
  }

  const nodes: LocalNode[] = []

  function walk(dirAbs: string, dirKey: string): void {
    const entries = fs
      .readdirSync(dirAbs, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))

    // The directory itself is a page (except the synthetic root, key '')
    const indexEntry = entries.find(
      (e) => e.isFile() && INDEX_FILES.includes(e.name.toLowerCase())
    )

    if (dirKey !== '') {
      const { title, markdown } = indexEntry
        ? readMarkdownFile(path.join(dirAbs, indexEntry.name), dirKey)
        : { title: path.basename(dirKey.replace(/\/$/, '')), markdown: '' }
      nodes.push({ key: dirKey, title, markdown, parentKey: parentKeyOf(dirKey) })
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dirAbs, entry.name), `${dirKey}${entry.name}/`)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        // Inside a directory, index.md/README.md is the directory page content;
        // at the root there is no directory page, so index.md is a regular page.
        if (dirKey !== '' && indexEntry && entry.name === indexEntry.name) continue
        const key = `${dirKey}${entry.name}`
        const { title, markdown } = readMarkdownFile(path.join(dirAbs, entry.name), key)
        nodes.push({
          key,
          title,
          markdown,
          parentKey: dirKey === '' ? null : dirKey,
        })
      }
    }
  }

  walk(root, '')
  return nodes
}

function parentKeyOf(dirKey: string): string | null {
  // "a/b/" -> "a/"
  const trimmed = dirKey.replace(/\/$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx === -1 ? null : trimmed.slice(0, idx + 1)
}

/** Reads a markdown file and extracts an optional `title:` from YAML front matter. */
function readMarkdownFile(
  absPath: string,
  key: string
): { title: string; markdown: string } {
  const raw = fs.readFileSync(absPath, 'utf8')
  const frontMatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (frontMatter) {
    const titleMatch = /^title:\s*["']?(.+?)["']?\s*$/m.exec(frontMatter[1]!)
    if (titleMatch) {
      return { title: titleMatch[1]!, markdown: raw.slice(frontMatter[0].length) }
    }
  }
  const stem = path.basename(key.replace(/\/$/, '')).replace(/\.md$/i, '')
  return { title: stem, markdown: raw }
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

// --- Manifest (repo path -> document id + content hash) ----------------------

export function loadManifest(manifestPath: string): Manifest {
  if (!fs.existsSync(manifestPath)) return { version: 1, nodes: {} }
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<Manifest>
    return { version: 1, nodes: data.nodes ?? {} }
  } catch (err) {
    throw new Error(`Cannot parse manifest ${manifestPath}: ${(err as Error).message}`)
  }
}

export function saveManifest(manifestPath: string, manifest: Manifest): void {
  fs.mkdirSync(path.dirname(path.resolve(manifestPath)), { recursive: true })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}
