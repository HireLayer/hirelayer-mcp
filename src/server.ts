import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { HireLayerClient, VERSION } from './client.js'

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

// Clients drop calls that stay silent too long (often after 60 s); parsing takes about
// 35 s and scans needing OCR take longer, so long calls report progress at this interval.
const PROGRESS_INTERVAL_MS = 10_000

const INSTRUCTIONS = `HireLayer gives you recruiting tools: resume (CV) parsing, job criteria extraction, candidate matching, candidate ranking and skills normalization.

Typical workflows:
- Screen candidates for a job: extract_job_criteria on the job description, parse_resume on each resume, then match_candidate for each one (pass the criteria and info_resume.text). Use rank_candidates to order up to 10 candidates in one call.
- Read a resume: parse_resume returns contact details, experience, education, languages, skills and the full text.
- Normalize skills: resolve_skills maps free text in French or English to taxonomy skills.

Notes:
- info_resume.text can reach 100,000 characters; match_candidate and rank_candidates accept 50,000 characters per resume, so truncate longer texts.
- Pass do_not_store_data: true to parse_resume when the user does not want HireLayer to keep the file.
- Every successful tool call costs 1 HireLayer credit. Resume parsing usually takes about 35 seconds.`

const criterion = z.object({
  id: z.string().min(1).describe('Criterion ID, e.g. crit_1 from extract_job_criteria.'),
  label: z.string().min(1).describe('What is evaluated, in a short phrase.'),
  weight: z.number().int().min(1).max(3).describe('3 essential, 2 important, 1 nice to have.'),
  is_mandatory: z.boolean().describe('Whether the job states it as a hard requirement.'),
  rationale: z.string().min(1).describe('Why the criterion matters for the job.'),
})

// The tools only read and analyse data; they never change anything in the user's systems.
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const

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
      title: 'Parse a resume',
      description:
        'Parse a resume / CV (PDF, DOC, DOCX, ODT, PPT, PPTX, ODP, XLS, RTF, TXT, JPG, PNG or BMP, under 4.5 MB) into structured JSON: contact details, work experience, education, languages, skills and the full resume text in info_resume.text. Pass a local file_path or a public file_url. Takes about 35 seconds. Costs 1 HireLayer credit.',
      inputSchema: {
        file_path: z.string().optional().describe('Absolute path of a local resume file.'),
        file_url: z.string().url().optional().describe('Public URL of a resume file to download.'),
        application_id: z.string().optional().describe('Your own reference, echoed back in the result.'),
        do_not_store_data: z
          .boolean()
          .optional()
          .describe('true: HireLayer does not keep the file after parsing.'),
      },
      annotations,
    },
    ({ file_path, file_url, application_id, do_not_store_data }, extra) =>
      run(extra, (signal) =>
        client.parseResume(
          { filePath: file_path, fileUrl: file_url },
          { applicationId: application_id, doNotStoreData: do_not_store_data, signal }
        )
      )
  )

  server.registerTool(
    'extract_job_criteria',
    {
      title: 'Extract job criteria',
      description:
        'Turn a job description (any language) into weighted matching criteria (matching_criteria[]), each with a weight from 1 to 3, a mandatory flag and a rationale. Feed the result to match_candidate. Costs 1 HireLayer credit.',
      inputSchema: {
        job_text: z.string().min(1).max(50000).describe('Full job description.'),
      },
      annotations,
    },
    ({ job_text }, extra) => run(extra, (signal) => client.extractJobCriteria(job_text, { signal }))
  )

  server.registerTool(
    'match_candidate',
    {
      title: 'Match a candidate to a job',
      description:
        'Score one candidate against a job: returns a score between 0 and 1, a summary and an explained evaluation of each criterion. Use the criteria from extract_job_criteria and the resume text from parse_resume (info_resume.text). Costs 1 HireLayer credit.',
      inputSchema: {
        job_text: z.string().min(1).max(50000).describe('Job description.'),
        candidate_text: z.string().min(1).max(50000).describe('Resume as plain text.'),
        matching_criteria: z
          .array(criterion)
          .default([])
          .describe('Criteria to evaluate, usually from extract_job_criteria.'),
      },
      annotations,
    },
    (args, extra) => run(extra, (signal) => client.matchCandidate(args, { signal }))
  )

  server.registerTool(
    'rank_candidates',
    {
      title: 'Rank candidates for a job',
      description:
        'Rank up to 10 candidates against the same job description, from their resume texts: returns each candidate with a rank, a score between 0 and 1 and a rationale. Costs 1 HireLayer credit per call, whatever the number of candidates.',
      inputSchema: {
        job_text: z.string().min(1).max(50000).describe('Job description.'),
        candidates: z
          .array(
            z.object({
              id: z.string().min(1).describe('Your candidate ID, unique in the request.'),
              candidate_text: z.string().min(1).max(50000).describe('Resume as plain text.'),
            })
          )
          .min(1)
          .max(10),
      },
      annotations,
    },
    (args, extra) => run(extra, (signal) => client.rankCandidates(args, { signal }))
  )

  server.registerTool(
    'resolve_skills',
    {
      title: 'Resolve skills',
      description:
        'Map free-text skills in French or English (one skill, a compound string or a whole skills section) to skills of the HireLayer taxonomy, with their IDs, families and domains. Unmatched parts are listed in unresolved. Costs 1 HireLayer credit.',
      inputSchema: {
        text: z.string().min(1).max(5000).describe('Free text containing one or more skills.'),
        language: z.enum(['fr', 'en']).optional().describe('Language of the labels returned: fr (default) or en.'),
      },
      annotations,
    },
    ({ text, language }, extra) => run(extra, (signal) => client.resolveSkills(text, language, { signal }))
  )

  server.registerPrompt(
    'screen_candidates',
    {
      title: 'Screen candidates for a job',
      description: 'Parse resumes, score each candidate against a job description and build a shortlist.',
      argsSchema: {
        job_description: z.string().describe('The job description, or the path of a file that contains it.'),
        resumes: z.string().describe('Resume file paths or URLs, one per line, or a folder that holds them.'),
      },
    },
    ({ job_description, resumes }) =>
      userPrompt(`Screen these candidates for the job below with the HireLayer tools.

1. Call extract_job_criteria on the job description.
2. Call parse_resume on each resume.
3. Call match_candidate for each candidate with the criteria and info_resume.text.
4. Present a shortlist table sorted by score: candidate, score, mandatory criteria met, main gaps. Then recommend who to interview and why.

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
        resume: z.string().describe('Path or URL of the resume file.'),
      },
    },
    ({ resume }) =>
      userPrompt(`Parse this resume with parse_resume, then write a recruiter summary: current role, years of experience, key skills, education, languages, location and availability. Flag missing contact details.

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
      userPrompt(`Call resolve_skills on the text below (language en), then list the normalized skills grouped by domain and the parts that could not be resolved.

${skills}`)
  )

  return server
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
