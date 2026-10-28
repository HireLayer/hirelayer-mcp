import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { HireLayerClient } from '../dist/client.js'
import { createServer } from '../dist/server.js'

const API = 'https://hirelayer.co/api/v4'

async function connect(fetch) {
  const server = createServer(new HireLayerClient({ apiKey: 'k', fetch, retryDelayMs: 0 }))
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

/** A client whose API answers each call with `answer` (JSON) and records the requests. */
async function recorded(answer = {}) {
  const calls = []
  const client = await connect(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, body: init.body })
    return new Response(JSON.stringify(answer))
  })
  return { client, calls }
}

const jsonBody = (call) => JSON.parse(call.body)

// The API refuses a job text under 30 characters.
const JOB = 'Senior React developer, 5 years, Lyon'

/** Calls a tool; an input the schema refuses comes back as a tool error, whichever way the SDK reports it. */
const call = (client, name, args) =>
  client.callTool({ name, arguments: args }).catch((error) => ({ isError: true, content: [{ text: error.message }] }))

const PRODUCTS = {
  parse_resume: 'Resume Parser',
  extract_job_criteria: 'Job Criteria Extractor',
  score_resumes: 'Resume Scorer',
  search_resumes: 'Talent Pool Search',
  search_jobs: 'Job Recommendations',
  normalize_skills: 'Skills Normalizer',
}

test('lists the six product tools with their product names as titles', async () => {
  const client = await connect(async () => new Response('{}'))
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(PRODUCTS).sort())
  for (const tool of tools) {
    assert.equal(tool.title, PRODUCTS[tool.name])
    assert.equal(tool.annotations.title, tool.title)
    assert.equal(tool.annotations.destructiveHint, false)
    assert.equal(tool.annotations.openWorldHint, true)
    // Every product but normalize_skills stores what it processes.
    assert.equal(tool.annotations.readOnlyHint, tool.name === 'normalize_skills', `${tool.name} readOnlyHint`)
    const properties = Object.keys(tool.inputSchema.properties)
    assert.equal(properties.includes('workspace'), tool.name !== 'normalize_skills', `${tool.name} workspace`)
  }
})

test('the old tools are gone, with no alias', async () => {
  const client = await connect(async () => new Response('{}'))
  const { tools } = await client.listTools()
  for (const name of ['match_candidate', 'rank_candidates', 'resolve_skills']) {
    assert.equal(tools.some((t) => t.name === name), false, `${name} is not listed`)
  }
})

test('ids and workspaces follow the API rule in the input schemas', async () => {
  const client = await connect(async () => new Response('{}'))
  const { tools } = await client.listTools()
  const parse = tools.find((t) => t.name === 'parse_resume')
  assert.equal(parse.inputSchema.properties.workspace.pattern, '^[A-Za-z0-9._:~-]{1,200}$')
  assert.equal(parse.inputSchema.properties.application_id.pattern, '^[A-Za-z0-9._:~-]{1,200}$')
  const score = tools.find((t) => t.name === 'score_resumes')
  assert.equal(score.inputSchema.properties.resumes.maxItems, 50)
  assert.deepEqual(score.inputSchema.required, ['resumes'])
})

test('exposes server instructions and workflow prompts', async () => {
  const client = await connect(async () => new Response('{}'))
  const instructions = client.getInstructions()
  for (const name of Object.keys(PRODUCTS)) assert.match(instructions, new RegExp(name))
  assert.doesNotMatch(instructions, /match_candidate|rank_candidates|resolve_skills/)
  const { prompts } = await client.listPrompts()
  assert.deepEqual(prompts.map((p) => p.name).sort(), ['normalize_skills_list', 'screen_candidates', 'summarize_resume'])
  const { messages } = await client.getPrompt({
    name: 'screen_candidates',
    arguments: { job_description: 'Senior React developer', resumes: '/tmp/a.pdf' },
  })
  assert.match(messages[0].content.text, /Senior React developer/)
  assert.match(messages[0].content.text, /score_resumes/)
  const skills = await client.getPrompt({ name: 'normalize_skills_list', arguments: { skills: 'Excel' } })
  assert.match(skills.messages[0].content.text, /Call normalize_skills/)
})

test('parse_resume uploads resume text to /resumes/parse in the workspace', async () => {
  const { client, calls } = await recorded({ application_id: 'cand-1', stored: true })
  const result = await client.callTool({
    name: 'parse_resume',
    arguments: { resume_text: 'Jane Doe, React developer', application_id: 'cand-1', workspace: 'acme-corp' },
  })
  assert.equal(result.isError, undefined)
  assert.equal(JSON.parse(result.content[0].text).application_id, 'cand-1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `${API}/resumes/parse`)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['HireLayer-Workspace'], 'acme-corp')
  const form = calls[0].body
  assert.equal(form.get('file').name, 'resume.txt')
  assert.equal(await form.get('file').text(), 'Jane Doe, React developer')
  assert.equal(form.get('application_id'), 'cand-1')
  assert.equal(form.has('do_not_store_data'), false)
})

test('parse_resume reads a local file and passes do_not_store_data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hl-'))
  const path = join(dir, 'jane.pdf')
  await writeFile(path, 'PDF bytes')
  const { client, calls } = await recorded()
  await client.callTool({ name: 'parse_resume', arguments: { file_path: path, do_not_store_data: true } })
  assert.equal(calls[0].url, `${API}/resumes/parse`)
  assert.equal(calls[0].body.get('file').name, 'jane.pdf')
  assert.equal(calls[0].body.get('do_not_store_data'), 'true')
  assert.equal('HireLayer-Workspace' in calls[0].headers, false)
})

test('extract_job_criteria posts the job as text to /jobs/extract-criteria', async () => {
  const { client, calls } = await recorded({ job_id: 'job_1', criteria: [] })
  await client.callTool({
    name: 'extract_job_criteria',
    arguments: {
      job_text: JOB,
      title: 'Senior React developer',
      location: 'Lyon',
      language: 'de',
      job_id: 'req-42',
      workspace: 'acme-corp',
    },
  })
  assert.equal(calls[0].url, `${API}/jobs/extract-criteria`)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['HireLayer-Workspace'], 'acme-corp')
  assert.deepEqual(jsonBody(calls[0]), {
    text: JOB,
    title: 'Senior React developer',
    location: 'Lyon',
    language: 'de',
    job_id: 'req-42',
  })
})

test('score_resumes sends the job text, its criteria and mixed resumes to /resumes/score', async () => {
  const { client, calls } = await recorded({ scores: [{ rank: 1, application_id: 'cand-1', score: 0.9 }] })
  const result = await client.callTool({
    name: 'score_resumes',
    arguments: {
      job_text: JOB,
      job_id: 'req-42',
      criteria: [
        { label: 'React', type: 'skill', requirement: 'required', weight: 3, threshold: '3 years', criterion_id: 'crit_1', source: 'extracted' },
      ],
      language: 'pt',
      resumes: [{ text: 'Jane Doe, React developer', reference: 'jane' }, { application_id: 'cand-1' }],
      precise_ranking: true,
      workspace: 'acme-corp',
    },
  })
  assert.equal(result.isError, undefined)
  assert.equal(JSON.parse(result.content[0].text).scores[0].application_id, 'cand-1')
  assert.equal(calls[0].url, `${API}/resumes/score`)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['HireLayer-Workspace'], 'acme-corp')
  assert.deepEqual(jsonBody(calls[0]), {
    job: {
      text: JOB,
      job_id: 'req-42',
      // criterion_id and source, ignored by the API, are not sent back.
      criteria: [{ label: 'React', type: 'skill', requirement: 'required', weight: 3, threshold: '3 years' }],
      language: 'pt',
    },
    resumes: [{ text: 'Jane Doe, React developer', reference: 'jane' }, { application_id: 'cand-1' }],
    precise_ranking: true,
  })
})

test('score_resumes sends a stored job by its job_id alone', async () => {
  const { client, calls } = await recorded()
  await client.callTool({
    name: 'score_resumes',
    arguments: { job_id: 'job_1', resumes: [{ application_id: 'cand-1' }] },
  })
  assert.deepEqual(jsonBody(calls[0]), { job: { job_id: 'job_1' }, resumes: [{ application_id: 'cand-1' }] })
  assert.equal('HireLayer-Workspace' in calls[0].headers, false)
})

test('search_resumes posts the job and its filters to /resumes/search', async () => {
  const { client, calls } = await recorded({ results: [] })
  await client.callTool({
    name: 'search_resumes',
    arguments: {
      job_text: JOB,
      limit: 20,
      city: 'Lyon',
      country_code: 'FR',
      radius_km: 50,
      added_after: '2026-09-01T00:00:00Z',
      workspace: 'acme-corp',
    },
  })
  await client.callTool({ name: 'search_resumes', arguments: { job_id: 'job_1' } })
  assert.equal(calls[0].url, `${API}/resumes/search`)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['HireLayer-Workspace'], 'acme-corp')
  assert.deepEqual(jsonBody(calls[0]), {
    job: { text: JOB },
    limit: 20,
    filters: {
      location: { city: 'Lyon', country_code: 'FR', radius_km: 50 },
      added_after: '2026-09-01T00:00:00Z',
    },
  })
  assert.deepEqual(jsonBody(calls[1]), { job_id: 'job_1' })
})

test('search_jobs posts the resume to /jobs/search', async () => {
  const { client, calls } = await recorded({ results: [] })
  await client.callTool({
    name: 'search_jobs',
    arguments: { application_id: 'cand-1', limit: 5, workspace: 'acme-corp' },
  })
  await client.callTool({ name: 'search_jobs', arguments: { resume_text: 'Jane Doe, React developer' } })
  assert.equal(calls[0].url, `${API}/jobs/search`)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['HireLayer-Workspace'], 'acme-corp')
  assert.deepEqual(jsonBody(calls[0]), { application_id: 'cand-1', limit: 5 })
  assert.deepEqual(jsonBody(calls[1]), { resume: { text: 'Jane Doe, React developer' } })
})

test('normalize_skills posts to /skills/normalize without a workspace', async () => {
  const { client, calls } = await recorded({ skills: [] })
  await client.callTool({ name: 'normalize_skills', arguments: { text: 'Excel', language: 'en' } })
  assert.equal(calls[0].url, `${API}/skills/normalize`)
  assert.equal(calls[0].method, 'POST')
  assert.equal('HireLayer-Workspace' in calls[0].headers, false)
  assert.deepEqual(jsonBody(calls[0]), { text: 'Excel', language: 'en' })
})

test('inconsistent inputs are refused before any API call', async () => {
  const { client, calls } = await recorded()
  const cases = [
    ['parse_resume', { file_url: 'https://x.test/a.pdf', resume_text: 'Jane' }, /exactly one/],
    ['score_resumes', { job_id: 'job_1', criteria: [{ label: 'React' }], resumes: [{ text: 'cv' }] }, /criteria go with job_text/],
    ['score_resumes', { resumes: [{ text: 'cv' }] }, /job_text or job_id/],
    ['score_resumes', { job_id: 'job_1', language: 'en', resumes: [{ text: 'cv' }] }, /a stored job keeps its own language/],
    ['score_resumes', { job_text: JOB, resumes: [{ reference: 'jane' }] }, /resumes\[0\] needs text or application_id/],
    ['search_resumes', { job_id: 'job_1', job_text: JOB }, /exactly one of job_id or job_text/],
    ['search_resumes', { job_id: 'job_1', radius_km: 10 }, /radius_km needs city/],
    ['search_jobs', {}, /exactly one of application_id or resume_text/],
  ]
  for (const [name, args, message] of cases) {
    const result = await client.callTool({ name, arguments: args })
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`)
    assert.match(result.content[0].text, message)
  }
  assert.equal(calls.length, 0)
})

test('a workspace or id outside the API rule is refused', async () => {
  const { client, calls } = await recorded()
  for (const args of [
    { job_text: JOB, workspace: 'acme corp' },
    { job_text: JOB, job_id: '..' },
  ]) {
    const result = await call(client, 'extract_job_criteria', args)
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /must contain letters, digits/)
  }
  assert.equal(calls.length, 0)
})

test('jobs take five languages and a text of 30 characters or more; skills keep French and English', async () => {
  const client = await connect(async () => new Response('{}'))
  const { tools } = await client.listTools()
  const tool = (name) => tools.find((t) => t.name === name)
  for (const name of ['extract_job_criteria', 'score_resumes']) {
    assert.deepEqual(tool(name).inputSchema.properties.language.enum, ['en', 'fr', 'de', 'es', 'pt'], name)
  }
  for (const name of ['extract_job_criteria', 'score_resumes', 'search_resumes']) {
    assert.equal(tool(name).inputSchema.properties.job_text.minLength, 30, name)
  }
  assert.deepEqual(tool('normalize_skills').inputSchema.properties.language.enum, ['fr', 'en'])
  assert.match(client.getInstructions(), /English, French, German, Spanish or Portuguese/)
  assert.match(client.getInstructions(), /at least one resume of 30 characters or more/)
})

test('a job text under 30 characters or another job language is refused before any API call', async () => {
  const { client, calls } = await recorded()
  const cases = [
    ['extract_job_criteria', { job_text: 'React developer' }, /at least 30 characters/],
    // Spaces around the text do not count.
    ['extract_job_criteria', { job_text: `${' '.repeat(10)}React developer, Lyon${' '.repeat(10)}` }, /at least 30 characters/],
    ['score_resumes', { job_text: 'React developer', resumes: [{ text: 'Jane Doe, React developer' }] }, /at least 30 characters/],
    ['search_resumes', { job_text: 'React developer' }, /at least 30 characters/],
    ['extract_job_criteria', { job_text: JOB, language: 'it' }, /language/],
    ['score_resumes', { job_text: JOB, language: 'it', resumes: [{ text: 'Jane Doe, React developer' }] }, /language/],
    ['normalize_skills', { text: 'Excel', language: 'de' }, /language/],
  ]
  for (const [name, args, message] of cases) {
    const result = await call(client, name, args)
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`)
    assert.match(result.content[0].text, message)
  }
  assert.equal(calls.length, 0)
})

test('score_resumes and extract_job_criteria name what costs credits', async () => {
  const client = await connect(async () => new Response('{}'))
  const { tools } = await client.listTools()
  const tool = (name) => tools.find((t) => t.name === name)
  assert.match(tool('score_resumes').description, /1 more with precise_ranking/)
  assert.match(tool('score_resumes').inputSchema.properties.precise_ranking.description, /1 credit more for the call/)
  assert.match(tool('extract_job_criteria').description, /Free, except a new text sent under the job_id of a job already scored/)
})

test('API errors come back as tool errors with the code and a hint', async () => {
  const responses = [
    new Response(
      JSON.stringify({
        error: {
          code: 'insufficient_credits',
          message: 'Not enough credits: 3 needed, 1 available.',
          doc_url: 'https://hirelayer.co/api-docs/errors#insufficient_credits',
        },
      }),
      { status: 403 }
    ),
    new Response(
      JSON.stringify({
        error: { code: 'not_found', message: 'No job job_9 in the workspace.', param: 'job.job_id', doc_url: 'https://hirelayer.co/api-docs/errors#not_found' },
      }),
      { status: 404 }
    ),
  ]
  const client = await connect(async () => responses.shift())
  const credits = await client.callTool({
    name: 'score_resumes',
    arguments: { job_text: JOB, resumes: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] },
  })
  assert.equal(credits.isError, true)
  assert.match(credits.content[0].text, /403 \(insufficient_credits\): Not enough credits/)
  assert.match(credits.content[0].text, /Credits reset every month/)
  const missing = await client.callTool({ name: 'search_resumes', arguments: { job_id: 'job_9' } })
  assert.equal(missing.isError, true)
  assert.match(missing.content[0].text, /404 \(not_found, param job\.job_id\): No job job_9/)
})
