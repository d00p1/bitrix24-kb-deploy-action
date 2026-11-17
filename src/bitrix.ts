export const MARKDOWN_LIMIT = 1_048_576 // NOTE_MARKDOWN_TOO_LARGE
export const TITLE_LIMIT = 255

/** Document state in Knowledge Base 2.0 */
export type DocumentState = 'live' | 'archived' | 'trashed'

export interface KnowledgeBase {
  id: number
  title: string
  state?: DocumentState
}

export interface Document {
  id: number
  collectionId: number
  parentId: number | null
  title: string
  markdown: string
  state: DocumentState
}

export interface RestError {
  code: string
  message: string
}

interface RestResponse<T> {
  result?: T
  error?: RestError
}

export class BitrixApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message)
    this.name = 'BitrixApiError'
  }
}

export interface ClientOptions {
  maxRetries?: number
}

/**
 * Minimal REST 3.0 client for Bitrix24 (note.* methods).
 * Calls go to {webhookUrl}/{method} with a JSON body.
 */
export class Bitrix24Client {
  private readonly webhookUrl: string
  private readonly maxRetries: number

  constructor(webhookUrl: string, { maxRetries = 5 }: ClientOptions = {}) {
    const url = (webhookUrl || '').trim().replace(/\/+$/, '')
    const isHttps = /^https:\/\/[^/]+\/rest\/api\/\d+\/[^/]+$/i.test(url)
    const isLocal =
      /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/rest\/api\/\d+\/[^/]+$/i.test(url)
    if (!isHttps && !isLocal) {
      throw new Error(
        `webhook-url must look like https://portal.bitrix24.ru/rest/api/{user_id}/{token}, got: ${url}`
      )
    }
    this.webhookUrl = url
    this.maxRetries = maxRetries
  }

  async call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.webhookUrl}/${method}`
    let attempt = 0

    for (;;) {
      attempt += 1
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        })
      } catch (err) {
        // Network level error (DNS, timeout, etc.)
        if (attempt > this.maxRetries) throw err
        await sleep(backoffMs(attempt))
        continue
      }

      const text = await response.text()
      let data: RestResponse<T> | null = null
      try {
        data = text ? (JSON.parse(text) as RestResponse<T>) : null
      } catch {
        data = null
      }

      if (response.ok) {
        if (data && data.error) {
          throw new BitrixApiError(data.error.code, data.error.message, response.status)
        }
        return (data ? data.result : undefined) as T
      }

      // Retryable: rate limit and transient server errors
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt > this.maxRetries) {
        const code = data && data.error ? data.error.code : `HTTP_${response.status}`
        const message =
          data && data.error
            ? data.error.message
            : `HTTP ${response.status}: ${text.slice(0, 300)}`
        throw new BitrixApiError(code, message, response.status)
      }

      const retryAfter = Number(response.headers.get('retry-after'))
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoffMs(attempt)
      )
    }
  }

  // --- Knowledge bases -----------------------------------------------------

  async listCollections(): Promise<KnowledgeBase[]> {
    const result = await this.call<{ items?: KnowledgeBase[] } | KnowledgeBase[]>(
      'note.collection.list',
      {}
    )
    return Array.isArray(result) ? result : (result.items ?? [])
  }

  async findCollectionByTitle(title: string): Promise<KnowledgeBase | null> {
    const collections = await this.listCollections()
    return (
      collections.find(
        (c) => c.title === title && (!c.state || c.state === 'live')
      ) ?? null
    )
  }

  async createCollection(title: string): Promise<KnowledgeBase> {
    const result = await this.call<{ item: KnowledgeBase }>('note.collection.add', {
      fields: { title },
    })
    return result.item
  }

  // --- Documents ------------------------------------------------------------

  async addDocument(
    fields: Pick<Document, 'collectionId' | 'title'> & Partial<Document>
  ): Promise<Document> {
    const result = await this.call<{ item: Document }>('note.document.add', { fields })
    return result.item
  }

  async updateDocument(id: number, fields: Partial<Document>): Promise<Document> {
    const result = await this.call<{ item: Document }>('note.document.update', {
      id,
      fields,
    })
    return result.item
  }

  async getDocument(id: number): Promise<Document> {
    const result = await this.call<{ item: Document }>('note.document.get', { id })
    return result.item
  }

  async archiveDocument(id: number): Promise<void> {
    await this.call('note.document.archive', { id })
  }
}

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s, 8s, 16s ...
  return Math.min(1000 * 2 ** (attempt - 1), 30000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Throws if the payload violates KB 2.0 limits before we hit the API. */
export function assertDocumentLimits(
  title: string,
  markdown: string,
  location: string
): void {
  if (!title || !title.trim()) {
    throw new Error(
      `Empty title for "${location}". Set a "title:" in front matter or use a non-empty file name.`
    )
  }
  if (title.length > TITLE_LIMIT) {
    throw new Error(
      `Title exceeds ${TITLE_LIMIT} characters for "${location}": "${title.slice(0, 60)}..."`
    )
  }
  const size = Buffer.byteLength(markdown || '', 'utf8')
  if (size > MARKDOWN_LIMIT) {
    throw new Error(
      `Markdown exceeds ${MARKDOWN_LIMIT} bytes in "${location}" (${size} bytes). Split the page.`
    )
  }
}
