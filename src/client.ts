import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename } from 'node:path'

export const VERSION: string = createRequire(import.meta.url)('../package.json').version
const DEFAULT_BASE_URL = 'https://hirelayer.co'
const API_PREFIX = '/api/v4'
/** Keeps one client company's jobs, resumes and scores apart from another's. */
export const WORKSPACE_HEADER = 'HireLayer-Workspace'
// The API rejects resumes above 4.5 MB.
export const MAX_RESUME_BYTES = 4.5 * 1024 * 1024
// 502 and 503 are transient and never charged, so one retry is safe.
const RETRYABLE_STATUSES = new Set([502, 503])
const MAX_RETRY_DELAY_MS = 10_000

export class HireLayerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The code of the API error, such as insufficient_credits; undefined when the API sent none. */
    readonly code?: string,
    /** The input at fault, such as job.criteria, when the API names one. */
    readonly param?: string
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
  /** The resume as plain text, sent as a .txt file. */
  text?: string
}

export interface CallOptions {
  signal?: AbortSignal
}

export interface WorkspaceOptions extends CallOptions {
  /** The workspace of the call, sent as the HireLayer-Workspace header; the account's default when absent. */
  workspace?: string
}

export type Language = 'fr' | 'en'

export interface CriterionInput {
  label: string
  type?: string
  requirement?: string
  weight?: number
  threshold?: string | null
}

export type ScoreJob =
  | { text: string; job_id?: string; criteria?: CriterionInput[]; title?: string; language?: Language }
  | { job_id: string }

export type ScoreResume = { reference?: string } & (
  | { text: string; application_id?: string }
  | { application_id: string }
)

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

  /** Resume Parser: POST /resumes/parse. */
  async parseResume(
    source: ResumeSource,
    options: { applicationId?: string; doNotStoreData?: boolean } & WorkspaceOptions = {}
  ): Promise<unknown> {
    const { bytes, filename, type } = await this.loadResume(source, options.signal)
    const form = new FormData()
    form.append('file', new Blob([bytes], type ? { type } : {}), filename)
    if (options.applicationId) form.append('application_id', options.applicationId)
    if (options.doNotStoreData !== undefined) {
      form.append('do_not_store_data', String(options.doNotStoreData))
    }
    return this.request('/resumes/parse', { method: 'POST', body: form, signal: options.signal }, options.workspace)
  }

  /** Job Criteria Extractor: POST /jobs/extract-criteria. */
  extractJobCriteria(
    body: { text: string; title?: string; location?: string; language?: Language; job_id?: string },
    options: WorkspaceOptions = {}
  ): Promise<unknown> {
    return this.postJson('/jobs/extract-criteria', body, options)
  }

  /** Resume Scorer: POST /resumes/score. */
  scoreResumes(
    body: { job: ScoreJob; resumes: ScoreResume[]; precise_ranking?: boolean },
    options: WorkspaceOptions = {}
  ): Promise<unknown> {
    return this.postJson('/resumes/score', body, options)
  }

  /** Talent Pool Search: POST /resumes/search. */
  searchResumes(
    body: {
      job_id?: string
      job?: { text: string }
      limit?: number
      filters?: {
        location?: { city: string; country_code?: string; radius_km?: number }
        added_after?: string
      }
    },
    options: WorkspaceOptions = {}
  ): Promise<unknown> {
    return this.postJson('/resumes/search', body, options)
  }

  /** Job Recommendations: POST /jobs/search. */
  searchJobs(
    body: { application_id?: string; resume?: { text: string }; limit?: number },
    options: WorkspaceOptions = {}
  ): Promise<unknown> {
    return this.postJson('/jobs/search', body, options)
  }

  /** Skills Normalizer: POST /skills/normalize. Nothing is stored, so it takes no workspace. */
  normalizeSkills(text: string, language?: Language, options: CallOptions = {}): Promise<unknown> {
    return this.postJson('/skills/normalize', language ? { text, language } : { text }, options)
  }

  // JSON.stringify leaves out the fields left undefined, so the API sees only what was given.
  private postJson(path: string, body: unknown, { signal, workspace }: WorkspaceOptions): Promise<unknown> {
    return this.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      },
      workspace
    )
  }

  private async request(path: string, init: RequestInit, workspace?: string, attempt = 1): Promise<unknown> {
    const response = await this.fetch(`${this.baseUrl}${API_PREFIX}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        'X-API-Key': this.apiKey,
        'User-Agent': `hirelayer-mcp/${VERSION}`,
        ...(workspace ? { [WORKSPACE_HEADER]: workspace } : {}),
      },
    })
    if (attempt === 1 && RETRYABLE_STATUSES.has(response.status) && !init.signal?.aborted) {
      await response.body?.cancel()
      await sleep(this.retryDelay(response.headers.get('retry-after')), init.signal)
      return this.request(path, init, workspace, attempt + 1)
    }
    const text = await response.text()
    let payload: unknown = text
    try {
      payload = JSON.parse(text)
    } catch {
      // Keep the raw text: gateways can answer with HTML or plain text.
    }
    if (!response.ok) throw apiError(response.status, payload)
    return payload
  }

  private retryDelay(retryAfter: string | null): number {
    const seconds = Number(retryAfter)
    if (retryAfter && Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS)
    }
    return this.retryDelayMs
  }

  private async loadResume({ filePath, fileUrl, text }: ResumeSource, signal?: AbortSignal) {
    const given = [filePath, fileUrl, text].filter((value) => value !== undefined && value !== '')
    if (given.length !== 1) {
      throw new HireLayerError('Provide exactly one of file_path, file_url or resume_text.')
    }
    let bytes: Uint8Array<ArrayBuffer>
    let filename: string
    let type: string | undefined
    if (filePath) {
      bytes = new Uint8Array(await readFile(filePath))
      filename = basename(filePath)
    } else if (fileUrl) {
      const response = await this.fetch(fileUrl, { signal })
      if (!response.ok) {
        throw new HireLayerError(`Could not download ${fileUrl}: HTTP ${response.status}`)
      }
      bytes = new Uint8Array(await response.arrayBuffer())
      filename = basename(new URL(fileUrl).pathname) || 'resume'
    } else {
      bytes = new TextEncoder().encode(text)
      filename = 'resume.txt'
      type = 'text/plain'
    }
    if (bytes.byteLength > MAX_RESUME_BYTES) {
      throw new HireLayerError(
        `The resume is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; HireLayer accepts files under 4.5 MB.`
      )
    }
    return { bytes, filename, type }
  }
}

/**
 * The API answers errors as {"error": {"code", "message", "param", "doc_url"}}; gateways
 * in front of it can still answer with HTML or plain text, kept as they come.
 */
function apiError(status: number, payload: unknown): HireLayerError {
  const error =
    payload && typeof payload === 'object' && 'error' in payload ? (payload as { error: unknown }).error : null
  if (error && typeof error === 'object') {
    const { code, message, param } = error as { code?: unknown; message?: unknown; param?: unknown }
    const errorCode = typeof code === 'string' ? code : undefined
    const errorParam = typeof param === 'string' ? param : undefined
    const label = [errorCode, errorParam && `param ${errorParam}`].filter(Boolean).join(', ')
    const text = typeof message === 'string' ? message : JSON.stringify(error)
    return new HireLayerError(
      `HireLayer API returned ${status}${label ? ` (${label})` : ''}: ${text}${errorHint(status, errorCode, text)}`,
      status,
      errorCode,
      errorParam
    )
  }
  const detail = typeof payload === 'string' ? payload.slice(0, 500) : JSON.stringify(payload)
  return new HireLayerError(`HireLayer API returned ${status}: ${detail}${errorHint(status, undefined, detail)}`, status)
}

function errorHint(status: number, code: string | undefined, detail: string): string {
  if (status === 401) {
    return ' Check HIRELAYER_API_KEY: copy your key from https://hirelayer.co/dashboard/api-keys.'
  }
  if (code === 'insufficient_credits' || (status === 403 && !code && /credit/i.test(detail))) {
    return ' Credits reset every month; more at https://hirelayer.co/pricing.'
  }
  if (code === 'enterprise_plan_required') {
    return ' do_not_store_data needs the Enterprise plan. Without it HireLayer stores the resume: check with the user before parsing again without the option.'
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
