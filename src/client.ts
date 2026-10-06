import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename } from 'node:path'

export const VERSION: string = createRequire(import.meta.url)('../package.json').version
const DEFAULT_BASE_URL = 'https://hirelayer.co'
// The API rejects resumes above 4.5 MB.
export const MAX_RESUME_BYTES = 4.5 * 1024 * 1024
// 502 and 503 are transient and never charged, so one retry is safe.
const RETRYABLE_STATUSES = new Set([502, 503])
const MAX_RETRY_DELAY_MS = 10_000

export class HireLayerError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'HireLayerError'
  }
}

export interface ClientOptions {
  apiKey: string
  baseUrl?: string
  fetch?: typeof fetch
  /** Delay before retrying a 502 or 503 when the API sends no Retry-After. */
  retryDelayMs?: number
}

export interface ResumeSource {
  filePath?: string
  fileUrl?: string
}

export interface CallOptions {
  signal?: AbortSignal
}

export class HireLayerClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetch: typeof fetch
  private readonly retryDelayMs: number

  constructor({ apiKey, baseUrl, fetch: fetchImpl, retryDelayMs }: ClientOptions) {
    this.apiKey = apiKey
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetch = fetchImpl ?? globalThis.fetch
    this.retryDelayMs = retryDelayMs ?? 2_000
  }

  async parseResume(
    source: ResumeSource,
    options: { applicationId?: string; doNotStoreData?: boolean } & CallOptions = {}
  ): Promise<unknown> {
    const { bytes, filename } = await this.loadResume(source, options.signal)
    const form = new FormData()
    form.append('file', new Blob([bytes]), filename)
    if (options.applicationId) form.append('application_id', options.applicationId)
    if (options.doNotStoreData !== undefined) {
      form.append('do_not_store_data', String(options.doNotStoreData))
    }
    return this.request('/api/v3/parser', { method: 'POST', body: form, signal: options.signal })
  }

  extractJobCriteria(jobText: string, options: CallOptions = {}): Promise<unknown> {
    return this.postJson('/api/v1/jobs/extract-criteria', { job_text: jobText }, options)
  }

  matchCandidate(
    body: {
      job_text: string
      candidate_text: string
      matching_criteria: unknown[]
    },
    options: CallOptions = {}
  ): Promise<unknown> {
    return this.postJson('/api/v1/matching/job-candidate', body, options)
  }

  rankCandidates(
    body: {
      job_text: string
      candidates: { id: string; candidate_text: string }[]
    },
    options: CallOptions = {}
  ): Promise<unknown> {
    return this.postJson('/api/v1/matching/job-candidates/rank', body, options)
  }

  resolveSkills(text: string, language?: 'fr' | 'en', options: CallOptions = {}): Promise<unknown> {
    return this.postJson('/api/v1/skills/resolve', language ? { text, language } : { text }, options)
  }

  private postJson(path: string, body: unknown, { signal }: CallOptions): Promise<unknown> {
    return this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  }

  private async request(path: string, init: RequestInit, attempt = 1): Promise<unknown> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        'X-API-Key': this.apiKey,
        'User-Agent': `hirelayer-mcp/${VERSION}`,
      },
    })
    if (attempt === 1 && RETRYABLE_STATUSES.has(response.status) && !init.signal?.aborted) {
      await response.body?.cancel()
      await sleep(this.retryDelay(response.headers.get('retry-after')), init.signal)
      return this.request(path, init, attempt + 1)
    }
    const text = await response.text()
    let payload: unknown = text
    try {
      payload = JSON.parse(text)
    } catch {
      // Keep the raw text: gateways can answer with HTML or plain text.
    }
    if (!response.ok) {
      const detail = typeof payload === 'string' ? payload.slice(0, 500) : JSON.stringify(payload)
      throw new HireLayerError(
        `HireLayer API returned ${response.status}: ${detail}${errorHint(response.status, detail)}`,
        response.status
      )
    }
    return payload
  }

  private retryDelay(retryAfter: string | null): number {
    const seconds = Number(retryAfter)
    if (retryAfter && Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
    }
    return this.retryDelayMs
  }

  private async loadResume({ filePath, fileUrl }: ResumeSource, signal?: AbortSignal) {
    if (Boolean(filePath) === Boolean(fileUrl)) {
      throw new HireLayerError('Provide exactly one of file_path or file_url.')
    }
    let bytes: Uint8Array<ArrayBuffer>
    let filename: string
    if (filePath) {
      bytes = new Uint8Array(await readFile(filePath))
      filename = basename(filePath)
    } else {
      const response = await this.fetch(fileUrl!, { signal })
      if (!response.ok) {
        throw new HireLayerError(`Could not download ${fileUrl}: HTTP ${response.status}`)
      }
      bytes = new Uint8Array(await response.arrayBuffer())
      filename = basename(new URL(fileUrl!).pathname) || 'resume'
    }
    if (bytes.byteLength > MAX_RESUME_BYTES) {
      throw new HireLayerError(
        `The resume is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; HireLayer accepts files under 4.5 MB.`
      )
    }
    return { bytes, filename }
  }
}

function errorHint(status: number, detail: string): string {
  if (status === 401) {
    return ' Check HIRELAYER_API_KEY: copy your key from https://hirelayer.co/dashboard/api-keys.'
  }
  if (status === 403 && /credit/i.test(detail)) {
    return ' Credits reset every month; see https://hirelayer.co/#pricing for more.'
  }
  return ''
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}
