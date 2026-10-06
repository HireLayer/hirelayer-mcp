import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { HireLayerClient, VERSION } from './client.js'

const criterion = z.object({
  id: z.string().min(1).describe('Criterion ID, e.g. crit_1 from extract_job_criteria.'),
  label: z.string().min(1).describe('What is evaluated, in a short phrase.'),
  weight: z.number().int().min(1).max(3).describe('3 essential, 2 important, 1 nice to have.'),
  is_mandatory: z.boolean().describe('Whether the job states it as a hard requirement.'),
  rationale: z.string().min(1).describe('Why the criterion matters for the job.'),
})

const readOnly = { readOnlyHint: true, openWorldHint: true } as const

export function createServer(client: HireLayerClient): McpServer {
  const server = new McpServer({ name: 'hirelayer', version: VERSION })

  const run = async (call: () => Promise<unknown>) => {
    try {
      const result = await call()
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text' as const, text: message }], isError: true }
    }
  }

  server.registerTool(
    'parse_resume',
    {
      title: 'Parse a resume',
      description:
        'Parse a resume (PDF, DOC, DOCX, ODT, PPT, PPTX, ODP, XLS, RTF, TXT, JPG, PNG or BMP, under 4.5 MB) into structured JSON: contact details, work experience, education, languages, skills and the full resume text in info_resume.text. Pass a local file_path or a public file_url. Costs 1 HireLayer credit.',
      inputSchema: {
        file_path: z.string().optional().describe('Absolute path of a local resume file.'),
        file_url: z.string().url().optional().describe('Public URL of a resume file to download.'),
        application_id: z.string().optional().describe('Your own reference, echoed back in the result.'),
        do_not_store_data: z
          .boolean()
          .optional()
          .describe('true: HireLayer does not keep the file after parsing.'),
      },
      annotations: readOnly,
    },
    ({ file_path, file_url, application_id, do_not_store_data }) =>
      run(() =>
        client.parseResume(
          { filePath: file_path, fileUrl: file_url },
          { applicationId: application_id, doNotStoreData: do_not_store_data }
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
      annotations: readOnly,
    },
    ({ job_text }) => run(() => client.extractJobCriteria(job_text))
  )

  server.registerTool(
    'match_candidate',
    {
      title: 'Match a candidate to a job',
      description:
        'Score one candidate against a job: returns a score between 0 and 1 and an evaluation of each criterion. Use the criteria from extract_job_criteria and the resume text from parse_resume (info_resume.text). Costs 1 HireLayer credit.',
      inputSchema: {
        job_text: z.string().min(1).max(50000).describe('Job description.'),
        candidate_text: z.string().min(1).max(50000).describe('Resume as plain text.'),
        matching_criteria: z
          .array(criterion)
          .default([])
          .describe('Criteria to evaluate, usually from extract_job_criteria.'),
      },
      annotations: readOnly,
    },
    (args) => run(() => client.matchCandidate(args))
  )

  server.registerTool(
    'rank_candidates',
    {
      title: 'Rank candidates for a job',
      description:
        'Rank up to 10 candidates against the same job description, from their resume texts. Costs 1 HireLayer credit per call.',
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
      annotations: readOnly,
    },
    (args) => run(() => client.rankCandidates(args))
  )

  server.registerTool(
    'resolve_skills',
    {
      title: 'Resolve skills',
      description:
        'Map free-text skills in French or English (one skill, a compound string or a whole skills section) to skills of the HireLayer taxonomy, with their IDs. Costs 1 HireLayer credit.',
      inputSchema: {
        text: z.string().min(1).max(5000).describe('Free text containing one or more skills.'),
        language: z.enum(['fr', 'en']).optional().describe('Language of the labels returned: fr (default) or en.'),
      },
      annotations: readOnly,
    },
    ({ text, language }) => run(() => client.resolveSkills(text, language))
  )

  return server
}
