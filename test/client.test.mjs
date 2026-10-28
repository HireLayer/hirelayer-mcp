import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HireLayerClient, HireLayerError, VERSION } from '../dist/client.js'

function recorder(responses) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const next = responses.shift()
    return new Response(next.body, { status: next.status ?? 200, headers: next.headers })
  }
  return { calls, fetch }
}

const v4Error = (code, message, param) =>
  JSON.stringify({ error: { code, message, param, doc_url: `https://hirelayer.co/api-docs/errors#${code}` } })

test('JSON calls go to /api/v4 with the API key, the body and the workspace header', async () => {
  const { calls, fetch } = recorder([{ body: '{"job_id":"job_1","criteria":[]}' }, { body: '{}' }])
  const client = new HireLayerClient({ apiKey: 'k1', baseUrl: 'https://api.test/', fetch })
  const result = await client.extractJobCriteria(
    { text: 'React developer', language: 'en', title: undefined },
    { workspace: 'acme-corp' }
  )
  assert.deepEqual(result, { job_id: 'job_1', criteria: [] })
  assert.equal(calls[0].url, 'https://api.test/api/v4/jobs/extract-criteria')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['X-API-Key'], 'k1')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.equal(calls[0].init.headers['User-Agent'], `hirelayer-mcp/${VERSION}`)
  assert.equal(calls[0].init.headers['HireLayer-Workspace'], 'acme-corp')
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'React developer', language: 'en' })

  await client.extractJobCriteria({ text: 'React developer' })
  assert.equal('HireLayer-Workspace' in calls[1].init.headers, false)
})

test('normalizeSkills calls /api/v4/skills/normalize and omits language when not given', async () => {
  const { calls, fetch } = recorder([{ body: '{}' }, { body: '{}' }])
  const client = new HireLayerClient({ apiKey: 'k', fetch })
  await client.normalizeSkills('Excel')
  await client.normalizeSkills('Excel', 'en')
  assert.equal(calls[0].url, 'https://hirelayer.co/api/v4/skills/normalize')
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'Excel' })
  assert.deepEqual(JSON.parse(calls[1].init.body), { text: 'Excel', language: 'en' })
  assert.equal('HireLayer-Workspace' in calls[0].init.headers, false)
})

test('scoreResumes, searchResumes and searchJobs post to their v4 paths', async () => {
  const { calls, fetch } = recorder([{ body: '{}' }, { body: '{}' }, { body: '{}' }])
  const client = new HireLayerClient({ apiKey: 'k', fetch })
  await client.scoreResumes({ job: { job_id: 'job_1' }, resumes: [{ application_id: 'cand-1' }] })
  await client.searchResumes({ job_id: 'job_1', limit: 20 })
  await client.searchJobs({ application_id: 'cand-1' }, { workspace: 'acme' })
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://hirelayer.co/api/v4/resumes/score',
      'https://hirelayer.co/api/v4/resumes/search',
      'https://hirelayer.co/api/v4/jobs/search',
    ]
  )
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    job: { job_id: 'job_1' },
    resumes: [{ application_id: 'cand-1' }],
  })
  assert.equal(calls[2].init.headers['HireLayer-Workspace'], 'acme')
})

test('v4 errors become HireLayerError with the status, code and param', async () => {
  const { fetch } = recorder([
    { status: 400, body: v4Error('invalid_request', 'job.criteria needs job.text or job.file', 'job.criteria') },
  ])
  const client = new HireLayerClient({ apiKey: 'k', fetch })
  await assert.rejects(client.scoreResumes({ job: { job_id: 'job_1' }, resumes: [{ text: 'cv' }] }), (error) => {
    assert.ok(error instanceof HireLayerError)
    assert.equal(error.status, 400)
    assert.equal(error.code, 'invalid_request')
    assert.equal(error.param, 'job.criteria')
    assert.equal(
      error.message,
      'HireLayer API returned 400 (invalid_request, param job.criteria): job.criteria needs job.text or job.file'
    )
    return true
  })
})

test('error messages say how to fix a bad key, missing credits or a plan limit', async () => {
  const { fetch } = recorder([
    { status: 401, body: v4Error('invalid_api_key', 'Invalid API key') },
    { status: 403, body: v4Error('insufficient_credits', 'Not enough credits: 1 needed, 0 available.') },
    { status: 403, body: v4Error('enterprise_plan_required', 'do_not_store_data needs the Enterprise plan.') },
  ])
  const client = new HireLayerClient({ apiKey: 'bad', fetch })
  await assert.rejects(client.normalizeSkills('Excel'), (error) => {
    assert.equal(error.code, 'invalid_api_key')
    assert.match(error.message, /^HireLayer API returned 401 \(invalid_api_key\): Invalid API key/)
    assert.match(error.message, /HIRELAYER_API_KEY/)
    return true
  })
  await assert.rejects(client.normalizeSkills('Excel'), (error) => {
    assert.equal(error.code, 'insufficient_credits')
    assert.match(error.message, /403 \(insufficient_credits\): Not enough credits/)
    assert.match(error.message, /hirelayer\.co\/pricing/)
    return true
  })
  await assert.rejects(client.parseResume({ text: 'Jane Doe' }, { doNotStoreData: true }), (error) => {
    assert.equal(error.code, 'enterprise_plan_required')
    assert.match(error.message, /check with the user/)
    return true
  })
})

test('error messages carry the request_id of the failed call', async () => {
  const { fetch } = recorder([
    {
      status: 500,
      body: JSON.stringify({
        error: { code: 'internal_error', message: 'Internal error: retry later.', param: null, doc_url: null },
        request_id: 'req_1',
      }),
    },
    { status: 502, body: '<html>Bad gateway</html>', headers: { 'HireLayer-Request-Id': 'req_2' } },
    { status: 502, body: '<html>Bad gateway</html>', headers: { 'HireLayer-Request-Id': 'req_2' } },
  ])
  const client = new HireLayerClient({ apiKey: 'k', fetch, retryDelayMs: 0 })
  await assert.rejects(client.normalizeSkills('Excel'), (error) => {
    assert.equal(error.requestId, 'req_1')
    assert.match(error.message, /Internal error: retry later\. \(request_id req_1\)$/)
    return true
  })
  await assert.rejects(client.normalizeSkills('Excel'), (error) => {
    assert.equal(error.requestId, 'req_2')
    assert.match(error.message, /\(request_id req_2\)$/)
    return true
  })
})

test('scoreResumes reads results_url until no score is pending after a 202', async () => {
  const pending = {
    status: 'pending',
    request_id: 'req_1',
    job_id: 'job_1',
    resumes_count: 2,
    webhook_url: null,
    results_url: 'https://hirelayer.co/api/v4/jobs/job_1/scores?request_id=req_1',
  }
  const running = { job_id: 'job_1', data: [{ application_id: 'a', evaluation_status: 'completed' }, { application_id: 'b', evaluation_status: 'pending' }] }
  const done = { job_id: 'job_1', data: [{ application_id: 'a', evaluation_status: 'completed' }, { application_id: 'b', evaluation_status: 'completed' }] }
  const { calls, fetch } = recorder([
    { status: 202, body: JSON.stringify(pending) },
    { body: JSON.stringify(running) },
    { body: JSON.stringify(done) },
  ])
  const client = new HireLayerClient({ apiKey: 'k', baseUrl: 'http://localhost:3000', fetch, pollIntervalMs: 0 })
  const result = await client.scoreResumes(
    { job: { job_id: 'job_1' }, resumes: [{ application_id: 'a' }, { application_id: 'b' }] },
    { workspace: 'acme' }
  )
  assert.deepEqual(result, done)
  // Read through the client's own base URL, in the same workspace.
  assert.equal(calls[1].url, 'http://localhost:3000/api/v4/jobs/job_1/scores?request_id=req_1')
  assert.equal(calls[1].init.method, 'GET')
  assert.equal(calls[2].init.headers['HireLayer-Workspace'], 'acme')
  assert.equal(calls.length, 3)
})

test('non-JSON error bodies from gateways are kept as text', async () => {
  const { fetch } = recorder([{ status: 504, body: '<html>Gateway Timeout</html>' }])
  const client = new HireLayerClient({ apiKey: 'k', fetch })
  await assert.rejects(client.normalizeSkills('Excel'), (error) => {
    assert.ok(error instanceof HireLayerError)
    assert.equal(error.status, 504)
    assert.equal(error.code, undefined)
    assert.match(error.message, /504: <html>Gateway Timeout<\/html>/)
    return true
  })
})

test('parseResume uploads a local file as multipart to /api/v4/resumes/parse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hl-'))
  const path = join(dir, 'cv.txt')
  await writeFile(path, 'Jane Doe, React developer')
  const { calls, fetch } = recorder([{ body: '{"application_id":"cand-1","resume":{}}' }])
  const client = new HireLayerClient({ apiKey: 'k', fetch })
  await client.parseResume(
    { filePath: path },
    { applicationId: 'cand-1', doNotStoreData: false, workspace: 'acme-corp' }
  )
  assert.equal(calls[0].url, 'https://hirelayer.co/api/v4/resumes/parse')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['HireLayer-Workspace'], 'acme-corp')
  const form = calls[0].init.body
  assert.ok(form instanceof FormData)
  assert.equal(form.get('file').name, 'cv.txt')
  assert.equal(await form.get('file').text(), 'Jane Doe, React developer')
  assert.equal(form.get('application_id'), 'cand-1')
  assert.equal(form.get('do_not_store_data'), 'false')
})

test('parseResume sends resume text as a .txt file and leaves out unset options', async () => {
  const { calls, fetch } = recorder([{ body: '{}' }])
  const client = new HireLayerClient({ apiKey: 'k', fetch })
  await client.parseResume({ text: 'Jane Doe\nReact developer' })
  const form = calls[0].init.body
  assert.equal(form.get('file').name, 'resume.txt')
  assert.equal(form.get('file').type, 'text/plain')
  assert.equal(await form.get('file').text(), 'Jane Doe\nReact developer')
  assert.equal(form.has('application_id'), false)
  assert.equal(form.has('do_not_store_data'), false)
  assert.equal('HireLayer-Workspace' in calls[0].init.headers, false)
})

test('parseResume downloads a file_url before uploading it', async () => {
  const { calls, fetch } = recorder([{ body: 'PDF bytes' }, { body: '{}' }])
  const client = new HireLayerClient({ apiKey: 'k', fetch })
  await client.parseResume({ fileUrl: 'https://files.test/cvs/jane.pdf' })
  assert.equal(calls[0].url, 'https://files.test/cvs/jane.pdf')
  assert.equal(calls[0].init.headers, undefined, 'the API key never goes to the file host')
  assert.equal(calls[1].url, 'https://hirelayer.co/api/v4/resumes/parse')
  assert.equal(calls[1].init.body.get('file').name, 'jane.pdf')
})

test('parseResume requires exactly one source', async () => {
  const client = new HireLayerClient({ apiKey: 'k', fetch: async () => new Response('{}') })
  await assert.rejects(client.parseResume({}), /exactly one/)
  await assert.rejects(client.parseResume({ filePath: 'a', fileUrl: 'https://x.test/a.pdf' }), /exactly one/)
  await assert.rejects(client.parseResume({ fileUrl: 'https://x.test/a.pdf', text: 'Jane' }), /exactly one/)
})

test('retries once on 502 and 503, never on 4xx', async () => {
  const { calls, fetch } = recorder([
    { status: 503, body: v4Error('internal_error', 'Briefly unavailable') },
    { body: '{"skills":[]}' },
    { status: 400, body: v4Error('invalid_request', 'bad') },
  ])
  const client = new HireLayerClient({ apiKey: 'k', fetch, retryDelayMs: 0 })
  assert.deepEqual(await client.normalizeSkills('Excel'), { skills: [] })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, calls[0].url)
  await assert.rejects(client.normalizeSkills('Excel'), /400 \(invalid_request\)/)
  assert.equal(calls.length, 3)
})

test('the retry keeps the workspace header and waits for Retry-After', async () => {
  const { calls, fetch } = recorder([
    { status: 503, body: v4Error('internal_error', 'Briefly unavailable'), headers: { 'Retry-After': '0' } },
    { body: '{}' },
  ])
  const client = new HireLayerClient({ apiKey: 'k', fetch, retryDelayMs: 60_000 })
  await client.searchJobs({ application_id: 'cand-1' }, { workspace: 'acme' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].init.headers['HireLayer-Workspace'], 'acme')
})

test('a second 502 is reported, not retried again', async () => {
  const { calls, fetch } = recorder([
    { status: 502, body: v4Error('model_unavailable', 'The model did not answer') },
    { status: 502, body: v4Error('model_unavailable', 'The model did not answer') },
  ])
  const client = new HireLayerClient({ apiKey: 'k', fetch, retryDelayMs: 0 })
  await assert.rejects(client.extractJobCriteria({ text: 'x' }), (error) => {
    assert.equal(error.status, 502)
    assert.equal(error.code, 'model_unavailable')
    return true
  })
  assert.equal(calls.length, 2)
})
