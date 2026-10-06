import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

export const VERSION = '0.1.0'
const DEFAULT_BASE_URL = 'https://hirelayer.co'
// The API rejects resumes above 4.5 MB.
export const MAX_RESUME_BYTES = 4.5 * 1024 * 1024

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
}

export interface ResumeSource {
  filePath?: string
  fileUrl?: string
}

export class HireLayerClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetch: typeof fetch

  constructor({ apiKey, baseUrl, fetch: fetchImpl }: ClientOptions) {
    this.apiKey = apiKey
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetch = fetchImpl ?? globalThis.fetch
  }

  async parseResume(
    source: ResumeSource,
    options: { applicationId?: string; doNotStoreData?: boolean } = {}
  ): Promise<unknown> {
    const { bytes, filename } = await this.loadResume(source)
    const form = new FormData()
    form.append('file', new Blob([bytes]), filename)
    if (options.applicationId) form.append('application_id', options.applicationId)
    if (options.doNotStoreData !== undefined) {
      form.append('do_not_store_data', String(options.doNotStoreData))
    }
    return this.request('/api/v3/parser', { method: 'POST', body: form })
  }

  extractJobCriteria(jobText: string): Promise<unknown> {
    return this.postJson('/api/v1/jobs/extract-criteria', { job_text: jobText })
  }

  matchCandidate(body: {
    job_text: string
    candidate_text: string
    matching_criteria: unknown[]
  }): Promise<unknown> {
    return this.postJson('/api/v1/matching/job-candidate', body)
  }

  rankCandidates(body: {
    job_text: string
    candidates: { id: string; candidate_text: string }[]
  }): Promise<unknown> {
    return this.postJson('/api/v1/matching/job-candidates/rank', body)
  }

  resolveSkills(text: string, language?: 'fr' | 'en'): Promise<unknown> {
    return this.postJson('/api/v1/skills/resolve', language ? { text, language } : { text })
  }

  private postJson(path: string, body: unknown): Promise<unknown> {
    return this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        'X-API-Key': this.apiKey,
        'User-Agent': `hirelayer-mcp/${VERSION}`,
      },
    })
    const text = await response.text()
    let payload: unknown = text
    try {
      payload = JSON.parse(text)
    } catch {
      // Keep the raw text: gateways can answer with HTML or plain text.
    }
    if (!response.ok) {
      throw new HireLayerError(
        `HireLayer API returned ${response.status}: ${typeof payload === 'string' ? payload.slice(0, 500) : JSON.stringify(payload)}`,
        response.status
      )
    }
    return payload
  }

  private async loadResume({ filePath, fileUrl }: ResumeSource) {
    if (Boolean(filePath) === Boolean(fileUrl)) {
      throw new HireLayerError('Provide exactly one of file_path or file_url.')
    }
    let bytes: Uint8Array<ArrayBuffer>
    let filename: string
    if (filePath) {
      bytes = new Uint8Array(await readFile(filePath))
      filename = basename(filePath)
    } else {
      const response = await this.fetch(fileUrl!)
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
