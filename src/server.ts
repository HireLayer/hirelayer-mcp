import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { HireLayerClient, HireLayerError, VERSION } from './client.js'
import type { CriterionInput, Language, ScoreJob, ScoreResume } from './client.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

// Clients drop calls that stay silent too long (often after 60 s); parsing takes about
// 30 s, scans needing OCR and scoring 50 resumes longer, so long calls report progress at this interval.
const PROGRESS_INTERVAL_MS = 10_000

const INSTRUCTIONS = `HireLayer gives you recruiting tools, one per product: Resume Parser (parse_resume), Job Criteria Extractor (extract_job_criteria), Resume Scorer (score_resumes), Talent Pool Search (search_resumes), Job Recommendations (search_jobs) and Skills Normalizer (normalize_skills).

Typical workflows:
- Screen candidates for a job: score_resumes with the job description (job_text) and the resumes (their text, or the application_id of resumes already parsed). It extracts the job's criteria on the way and returns every resume scored, best first. Set precise_ranking to re-rank the 10 best against each other, with a one-sentence reason each.
- Review or edit the criteria first: extract_job_criteria, then score_resumes with the job_id it returned, or with job_text and your edited criteria.
- Read a resume: parse_resume returns contact details, experience, education, languages, skills and the full text in resume.info_resume.text, stored under application_id.
- Find candidates already in the user's resume database for a job: search_resumes, then score_resumes on the application_ids it returns.
- Find stored open jobs for a candidate: search_jobs.
- Normalize skills: normalize_skills maps free text in French or English to taxonomy skills.

Resume input:
- parse_resume reads a local file (file_path, an absolute path), downloads a public file_url, or takes the resume text as resume_text.
- score_resumes and search_jobs take resume text directly: when you can already read the resume, pass its text instead of parsing it first. For a resume file, parse it with parse_resume and pass the application_id it returns.

Notes:
- Criteria, summaries and explanations are written in the job's language (French or English) unless language says otherwise; evidence quotes the resume in its own language.
- Job and resume texts are accepted up to 50,000 characters each: truncate longer ones. score_resumes takes up to 50 resumes per call.
- HireLayer keeps the jobs, resumes and scores in the user's account, as the REST API does, unless the workspace runs without storage. A pair already scored is not evaluated again and costs nothing.
- Pass do_not_store_data: true to parse_resume when the user does not want HireLayer to keep the resume (Enterprise plan). Such a resume gets no application_id: score it by its text.
- When the user recruits for several client companies, pass the client's workspace id so each client's jobs and candidates stay apart. Reuse the exact id the user gives: a new id creates a new workspace.
- Credits: parse_resume 1 (0 for a file already stored), extract_job_criteria free, score_resumes 1 per resume evaluated, search_resumes and search_jobs 1 per search, normalize_skills 1. A parse takes about 30 seconds; scoring 50 resumes about a minute.
- Scores support human hiring decisions; they never replace them.`

// The ids HireLayer accepts for resumes, jobs and workspaces.
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:~-]{1,200}$/
const CLIENT_ID_RULE = 'letters, digits and . _ : ~ -, up to 200 characters'
const isClientId = (value: string) => CLIENT_ID_PATTERN.test(value) && !/^\.\.?$/.test(value)

const APPLICATION_ID_MESSAGE = `application_id must contain ${CLIENT_ID_RULE}`
const WORKSPACE_MESSAGE = `workspace must contain ${CLIENT_ID_RULE}`
const JOB_ID_MESSAGE = `job_id must contain ${CLIENT_ID_RULE}`

const APPLICATION_ID_RULE = z
  .string()
  .regex(CLIENT_ID_PATTERN, APPLICATION_ID_MESSAGE)
  .refine(isClientId, APPLICATION_ID_MESSAGE)
const JOB_ID_RULE = z.string().regex(CLIENT_ID_PATTERN, JOB_ID_MESSAGE).refine(isClientId, JOB_ID_MESSAGE)

// The rule of the HireLayer-Workspace header, which the API also checks before any work.
const workspaceArg = z
  .string()
  .regex(CLIENT_ID_PATTERN, WORKSPACE_MESSAGE)
  .optional()
  .describe(
    `The client company this call belongs to, when the user recruits for several companies: its HireLayer workspace id (${CLIENT_ID_RULE}), e.g. acme-corp. Jobs, resumes and scores stay apart from other clients'. A new id creates a new workspace, so reuse the exact id. Omit it for the user's default workspace.`
  )

const languageArg = z
  .enum(['fr', 'en'])
  .optional()
  .describe("Language of the criteria, summaries and explanations: fr or en. Defaults to the job's language.")

const jobText = z.string().min(1).max(50000)
const resumeText = z.string().min(1).max(50000)

// The format extract_job_criteria returns; criterion_id and source, sent back, are ignored by the API.
const criterion = z.object({
  label: z.string().min(1).max(300).describe('What is evaluated.'),
  type: z
    .enum(['skill', 'experience', 'education', 'language', 'certification', 'location', 'soft_skill', 'other'])
    .optional(),
  requirement: z
    .enum(['required', 'preferred', 'bonus'])
    .optional()
    .describe(
      'required: a resume that clearly lacks it loses 25 % of its score. preferred and bonus count through their weight only.'
    ),
  weight: z.number().int().min(0).max(3).optional().describe('3 essential, 2 important, 1 nice to have, 0 off.'),
  threshold: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .describe('Minimum level in short text, such as 3 years or B2.'),
})

// The tools read and analyse the data they receive and call the HireLayer API (open world).
// Every product but normalize_skills stores what it processes in the user's HireLayer account,
// as the REST API does, unless the workspace runs without storage: they are not read-only.
// No tool deletes anything.
const hints = { destructiveHint: false, idempotentHint: false, openWorldHint: true } as const

// Directories (Claude, ChatGPT) read the human-readable name from annotations.title.
function annotations(title: string, options: { writes?: boolean } = {}) {
  return { title, readOnlyHint: !options.writes, ...hints }
}

export function createServer(client: HireLayerClient): McpServer {
  const server = new McpServer(
    {
      name: 'hirelayer',
      title: 'HireLayer',
      version: VERSION,
      websiteUrl: 'https://hirelayer.co',
      icons: [{ src: 'https://hirelayer.co/favicon/android-chrome-512x512.png', mimeType: 'image/png', sizes: ['512x512'] }],
    },
    { instructions: INSTRUCTIONS }
  )

  const run = async (extra: Extra, call: (signal: AbortSignal) => Promise<unknown>) => {
    const stopProgress = reportProgress(extra)
    try {
      const result = await call(extra.signal)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text' as const, text: message }], isError: true }
    } finally {
      stopProgress()
    }
  }

  server.registerTool(
    'parse_resume',
    {
      title: 'Resume Parser',
      description:
        "Parse a resume / CV (PDF, DOC, DOCX, ODT, PPT, PPTX, ODP, XLS, RTF, TXT, HTML, Markdown, JPG, PNG or BMP, under 4.5 MB) into structured JSON, in resume: contact details, work experience, education, languages, skills and the full resume text in resume.info_resume.text. Give exactly one input: file_path (a local file), file_url (a public URL) or resume_text. HireLayer keeps the resume in the user's resume database under application_id, unless do_not_store_data is set. Takes about 30 seconds. Costs 1 HireLayer credit, 0 for a file already stored.",
      inputSchema: {
        file_path: z.string().optional().describe('Absolute path of a local resume file.'),
        file_url: z.string().url().optional().describe('Public URL of a resume file to download.'),
        resume_text: z
          .string()
          .min(1)
          .max(100000)
          .optional()
          .describe('Resume as plain text, when no file is available.'),
        application_id: APPLICATION_ID_RULE.optional().describe(
          `Your id for this resume, such as the application or candidate id of your ATS (${CLIENT_ID_RULE}). The resume is stored under it, replacing a resume stored under the same id. Omit it when you have no such id: the resume is stored under an id drawn from the file.`
        ),
        do_not_store_data: z
          .boolean()
          .optional()
          .describe(
            'true: HireLayer keeps nothing of this parse and application_id comes back null. Enterprise plan only.'
          ),
        workspace: workspaceArg,
      },
      annotations: annotations('Resume Parser', { writes: true }),
    },
    ({ file_path, file_url, resume_text, application_id, do_not_store_data, workspace }, extra) =>
      run(extra, (signal) =>
        client.parseResume(
          { filePath: file_path, fileUrl: file_url, text: resume_text },
          { applicationId: application_id, doNotStoreData: do_not_store_data, workspace, signal }
        )
      )
  )

  server.registerTool(
    'extract_job_criteria',
    {
      title: 'Job Criteria Extractor',
      description:
        'Turn a job description (any language) into its typed criteria (usually 4 to 10), each with a criterion_id, a label, a type, a requirement (required, preferred or bonus), a weight from 0 to 3 and an optional threshold. The job is stored under job_id, so score_resumes can reuse it. Free.',
      inputSchema: {
        job_text: jobText.describe('Full job description, as published.'),
        title: z.string().max(300).optional().describe('Job title.'),
        location: z.string().max(300).optional().describe('Where the job is based.'),
        language: languageArg,
        job_id: JOB_ID_RULE.optional().describe(
          `Your id for this job (${CLIENT_ID_RULE}). Omit it: the job is stored under an id drawn from its text.`
        ),
        workspace: workspaceArg,
      },
      annotations: annotations('Job Criteria Extractor', { writes: true }),
    },
    ({ job_text, title, location, language, job_id, workspace }, extra) =>
      run(extra, (signal) =>
        client.extractJobCriteria({ text: job_text, title, location, language, job_id }, { workspace, signal })
      )
  )

  server.registerTool(
    'score_resumes',
    {
      title: 'Resume Scorer',
      description:
        'Evaluate 1 to 50 resumes against a job, criterion by criterion, and return them best first: for each, a score between 0 and 1, a verdict (highly_relevant, relevant, marginally_relevant or not_relevant), a summary, the required criteria missing or to verify, and the evidence for each criterion. Give the job as job_text (its criteria are extracted on the way, or pass your own criteria) or as the job_id of a stored job. Give each resume as text or as the application_id of a stored resume. With precise_ranking, the 10 best are re-ranked against each other, each with a ranking_reason. The result is decision support for a human recruiter, not an automated hiring decision. Costs 1 HireLayer credit per resume evaluated; a pair already scored costs 0.',
      inputSchema: {
        job_text: jobText.optional().describe('The job description. Give job_text or job_id.'),
        job_id: JOB_ID_RULE.optional().describe(
          'Alone: a job already stored, such as the job_id extract_job_criteria returned. With job_text: store the job under your own id.'
        ),
        criteria: z
          .array(criterion)
          .min(1)
          .max(20)
          .optional()
          .describe(
            "The job's own criteria, in the format extract_job_criteria returns; they replace the extraction. Only with job_text."
          ),
        language: languageArg,
        resumes: z
          .array(
            z.object({
              text: resumeText.optional().describe('The resume as plain text.'),
              application_id: APPLICATION_ID_RULE.optional().describe(
                'Alone: a resume already stored, such as the application_id parse_resume returned. With text: store the resume under your own id.'
              ),
              reference: z.string().max(200).optional().describe('Your label for this resume, returned as is.'),
            })
          )
          .min(1)
          .max(50)
          .describe('The resumes to score. Each needs text or application_id.'),
        precise_ranking: z
          .boolean()
          .optional()
          .describe(
            'Re-rank the 10 best against each other and explain each place in ranking_reason. Included in the price.'
          ),
        workspace: workspaceArg,
      },
      annotations: annotations('Resume Scorer', { writes: true }),
    },
    (args, extra) =>
      run(extra, async (signal) => {
        const job = scoreJob(args)
        const resumes = args.resumes.map((resume, index): ScoreResume => {
          if (resume.text !== undefined) {
            return { text: resume.text, application_id: resume.application_id, reference: resume.reference }
          }
          if (resume.application_id !== undefined) {
            return { application_id: resume.application_id, reference: resume.reference }
          }
          throw new HireLayerError(`resumes[${index}] needs text or application_id.`)
        })
        return client.scoreResumes(
          { job, resumes, precise_ranking: args.precise_ranking },
          { workspace: args.workspace, signal }
        )
      })
  )

  server.registerTool(
    'search_resumes',
    {
      title: 'Talent Pool Search',
      description:
        "Find the resumes of the user's resume database closest to a job, by proximity only: application_ids with a similarity between 0 and 1, best first, and whether each is already scored for the job. No evaluation: pass the ones worth it to score_resumes. Give the job as the job_id of a stored job or as job_text (the job is then stored). Costs 1 HireLayer credit per search.",
      inputSchema: {
        job_id: JOB_ID_RULE.optional().describe('A stored job. Give job_id or job_text.'),
        job_text: jobText.optional().describe('A job description not stored yet.'),
        limit: z.number().int().min(1).max(500).optional().describe('How many resumes to return, 50 by default.'),
        city: z
          .string()
          .min(1)
          .optional()
          .describe('Keep the resumes located around this city. Resumes without a known location are left out.'),
        country_code: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .optional()
          .describe("The city's country, ISO 3166-1 alpha-2 such as FR."),
        radius_km: z.number().int().min(1).max(500).optional().describe('Around the city, 30 km by default.'),
        added_after: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe('Keep the resumes added after this date (ISO 8601).'),
        workspace: workspaceArg,
      },
      annotations: annotations('Talent Pool Search', { writes: true }),
    },
    (args, extra) =>
      run(extra, async (signal) => {
        if ((args.job_id === undefined) === (args.job_text === undefined)) {
          throw new HireLayerError('Give exactly one of job_id or job_text.')
        }
        if (args.city === undefined && args.radius_km !== undefined) {
          throw new HireLayerError('radius_km needs city.')
        }
        const location =
          args.city === undefined
            ? undefined
            : { city: args.city, country_code: args.country_code, radius_km: args.radius_km }
        const filters = location || args.added_after ? { location, added_after: args.added_after } : undefined
        return client.searchResumes(
          {
            job_id: args.job_id,
            job: args.job_text === undefined ? undefined : { text: args.job_text },
            limit: args.limit,
            filters,
          },
          { workspace: args.workspace, signal }
        )
      })
  )

  server.registerTool(
    'search_jobs',
    {
      title: 'Job Recommendations',
      description:
        "Find the user's stored open jobs closest to a resume, by proximity only: job_ids with their title and a similarity between 0 and 1, best first, and whether the resume is already scored for each. No evaluation: score the ones worth it with score_resumes. Give the resume as the application_id of a stored resume or as resume_text (the resume is then stored). Costs 1 HireLayer credit per search.",
      inputSchema: {
        application_id: APPLICATION_ID_RULE.optional().describe('A stored resume. Give application_id or resume_text.'),
        resume_text: resumeText.optional().describe('A resume not stored yet, as plain text.'),
        limit: z.number().int().min(1).max(100).optional().describe('How many jobs to return, 10 by default.'),
        workspace: workspaceArg,
      },
      annotations: annotations('Job Recommendations', { writes: true }),
    },
    (args, extra) =>
      run(extra, async (signal) => {
        if ((args.application_id === undefined) === (args.resume_text === undefined)) {
          throw new HireLayerError('Give exactly one of application_id or resume_text.')
        }
        return client.searchJobs(
          {
            application_id: args.application_id,
            resume: args.resume_text === undefined ? undefined : { text: args.resume_text },
            limit: args.limit,
          },
          { workspace: args.workspace, signal }
        )
      })
  )

  server.registerTool(
    'normalize_skills',
    {
      title: 'Skills Normalizer',
      description:
        'Map free-text skills in French or English (one skill, a compound string or a whole skills section) to skills of the HireLayer taxonomy, with their IDs, families and domains. Unmatched parts are listed in unresolved. Costs 1 HireLayer credit.',
      inputSchema: {
        text: z.string().min(1).max(5000).describe('Free text containing one or more skills.'),
        language: z.enum(['fr', 'en']).optional().describe('Language of the labels returned: fr (default) or en.'),
      },
      annotations: annotations('Skills Normalizer'),
    },
    ({ text, language }, extra) => run(extra, (signal) => client.normalizeSkills(text, language, { signal }))
  )

  server.registerPrompt(
    'screen_candidates',
    {
      title: 'Screen candidates for a job',
      description: 'Score each candidate against a job description and build a shortlist.',
      argsSchema: {
        job_description: z.string().describe('The job description, or the path of a file that contains it.'),
        resumes: z
          .string()
          .describe('Resume file paths or URLs, one per line, a folder that holds them, or resume texts separated by ---.'),
      },
    },
    ({ job_description, resumes }) =>
      userPrompt(`Screen these candidates for the job below with the HireLayer tools.

1. For each resume given as a file path or URL, call parse_resume and keep its application_id; use resume texts as they are.
2. Call score_resumes once, with the job description as job_text, every resume (text or application_id) and precise_ranking set to true.
3. Present a shortlist table in the order returned: candidate, score, verdict, required criteria missing, main gaps. Then recommend who to interview and why.

Job description:
${job_description}

Resumes:
${resumes}`)
  )

  server.registerPrompt(
    'summarize_resume',
    {
      title: 'Summarize a resume',
      description: 'Parse one resume and write a short recruiter-style candidate summary.',
      argsSchema: {
        resume: z.string().describe('Path or URL of the resume file, or the resume text.'),
      },
    },
    ({ resume }) =>
      userPrompt(`Parse this resume with parse_resume (file_path for a local file, file_url for a URL, resume_text for text), then write a recruiter summary: current role, years of experience, key skills, education, languages, location and availability. Flag missing contact details.

Resume: ${resume}`)
  )

  server.registerPrompt(
    'normalize_skills',
    {
      title: 'Normalize a skills list',
      description: 'Map a free-text skills section to standard taxonomy skills.',
      argsSchema: {
        skills: z.string().describe('Free-text skills, e.g. a resume skills section.'),
      },
    },
    ({ skills }) =>
      userPrompt(`Call normalize_skills on the text below (language en), then list the normalized skills grouped by domain and the parts that could not be resolved.

${skills}`)
  )

  return server
}

/** The job of score_resumes: its text (with criteria) or a stored job_id. */
function scoreJob(args: {
  job_text?: string
  job_id?: string
  criteria?: CriterionInput[]
  language?: Language
}): ScoreJob {
  if (args.job_text !== undefined) {
    return { text: args.job_text, job_id: args.job_id, criteria: args.criteria, language: args.language }
  }
  if (args.criteria !== undefined) {
    throw new HireLayerError('criteria go with job_text, never alone.')
  }
  if (args.job_id === undefined) {
    throw new HireLayerError('Give job_text or job_id.')
  }
  return { job_id: args.job_id }
}

function userPrompt(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] }
}

function reportProgress(extra: Extra): () => void {
  const progressToken = extra._meta?.progressToken
  if (progressToken === undefined) return () => {}
  let progress = 0
  const timer = setInterval(() => {
    progress += 1
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress, message: 'Waiting for HireLayer…' },
      })
      .catch(() => {})
  }, PROGRESS_INTERVAL_MS)
  return () => clearInterval(timer)
}
