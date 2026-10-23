import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HireLayerClient, HireLayerError, normalizeWorkspace } from '../dist/client.js'

function recorder(responses) {
  const calls = []
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const next = responses.shift()
    return new Response(next.body, { status: next.status ?? 200 })
  }
  return { calls, fetch }
}

test('JSON calls send the API key and body to the right endpoint', async () => {
  const { calls, fetch } = recorder([{ body: '{"matching_criteria":[]}' }])
  const client = new HireLayerClient({ apiKey: 'k1', baseUrl: 'https://api.test/', fetch })
  const result = await client.extractJobCriteria('React developer')
  assert.deepEqual(result, { matching_criteria: [] })
  assert.equal(calls[0].url, 'https://api.test/api/v1/jobs/extract-criteria')
  assert.equal(calls[0].init.headers['X-API-Key'], 'k1')
  assert.deepEqual(JSON.parse(calls[0].init.body), { job_text: 'React developer' })
})

test('resolveSkills omits language when not given', async () => {
  const { calls, fetch } = recorder([{ body: '{}' }, { body: '{}' }])
  const client = new HireLayerClient({ apiKey: 'k', fetch })
  await client.resolveSkills('Excel')
  await client.resolveSkills('Excel', 'en')
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: 'Excel' })
  assert.deepEqual(JSON.parse(calls[1].init.body), { text: 'Excel', language: 'en' })
})

test('API errors become HireLayerError with the status', async () => {
  const { fetch } = recorder([{ status: 401, body: '{"error":"Invalid API key"}' }])
  const client = new HireLayerClient({ apiKey: 'bad', fetch })
  await assert.rejects(client.resolveSkills('Excel'), (error) => {
    assert.ok(error instanceof HireLayerError)
    assert.equal(error.status, 401)
    assert.match(error.message, /Invalid API key/)
    return true
  })
})

test('parseResume uploads a local file as multipart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hl-'))
  const path = join(dir, 'cv.txt')
  await writeFile(path, 'Jane Doe, React developer')
  const { calls, fetch } = recorder([{ body: '{"info_resume":{}}' }])
  const client = new HireLayerClient({ apiKey: 'k', fetch })
  await client.parseResume({ filePath: path }, { doNotStoreData: true })
  const form = calls[0].init.body
  assert.ok(form instanceof FormData)
  assert.equal(form.get('file').name, 'cv.txt')
  assert.equal(form.get('do_not_store_data'), 'true')
  assert.equal(calls[0].url, 'https://hirelayer.co/api/v3/parser')
})

test('parseResume sends the workspace header, trimmed and lowercased', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hl-'))
  const path = join(dir, 'cv.txt')
  await writeFile(path, 'Jane Doe')
  const { calls, fetch } = recorder([{ body: '{}' }, { body: '{}' }])
  const client = new HireLayerClient({ apiKey: 'k', fetch })
  await client.parseResume({ filePath: path }, { workspace: '  Acme-Corp ' })
  await client.parseResume({ filePath: path })
  assert.equal(calls[0].init.headers['HireLayer-Workspace'], 'acme-corp')
  assert.equal(calls[0].init.headers['X-API-Key'], 'k')
  assert.equal('HireLayer-Workspace' in calls[1].init.headers, false)
})

test('the client workspace applies when a call names none, and the call wins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hl-'))
  const path = join(dir, 'cv.txt')
  await writeFile(path, 'Jane Doe')
  const { calls, fetch } = recorder([{ body: '{}' }, { body: '{}' }, { body: '{}' }])
  const client = new HireLayerClient({ apiKey: 'k', fetch, workspace: 'Client-A' })
  await client.parseResume({ filePath: path })
  await client.parseResume({ filePath: path }, { workspace: 'client-b' })
  assert.equal(calls[0].init.headers['HireLayer-Workspace'], 'client-a')
  assert.equal(calls[1].init.headers['HireLayer-Workspace'], 'client-b')
  // The other endpoints keep no data, so they get no workspace.
  await client.extractJobCriteria('React developer')
  assert.equal('HireLayer-Workspace' in calls[2].init.headers, false)
})

test('an invalid workspace is rejected before any request', async () => {
  const { calls, fetch } = recorder([])
  const client = new HireLayerClient({ apiKey: 'k', fetch })
  await assert.rejects(
    client.parseResume({ fileUrl: 'https://x.test/cv.pdf' }, { workspace: 'acme corp' }),
    (error) => error instanceof HireLayerError && /workspace must contain letters, digits/.test(error.message)
  )
  assert.equal(calls.length, 0)
  assert.throws(() => new HireLayerClient({ apiKey: 'k', workspace: 'a/b' }), HireLayerError)
})

test('normalizeWorkspace follows the API rule for workspace ids', () => {
  assert.equal(normalizeWorkspace(undefined), undefined)
  assert.equal(normalizeWorkspace('   '), undefined)
  assert.equal(normalizeWorkspace('Agency.Client_1:EU~prod-2'), 'agency.client_1:eu~prod-2')
  assert.equal(normalizeWorkspace('a'.repeat(200)), 'a'.repeat(200))
  for (const bad of ['a'.repeat(201), 'acme corp', 'a/b', 'café', 'a@b']) {
    assert.throws(() => normalizeWorkspace(bad), /workspace must contain/, bad)
  }
})

test('parseResume requires exactly one source', async () => {
  const client = new HireLayerClient({ apiKey: 'k', fetch: async () => new Response('{}') })
  await assert.rejects(client.parseResume({}), /exactly one/)
  await assert.rejects(client.parseResume({ filePath: 'a', fileUrl: 'https://x.test/a.pdf' }), /exactly one/)
})

test('retries once on 502 and 503, never on 4xx', async () => {
  const { calls, fetch } = recorder([
    { status: 503, body: 'busy' },
    { body: '{"skills":[]}' },
    { status: 400, body: '{"error":"bad"}' },
  ])
  const client = new HireLayerClient({ apiKey: 'k', fetch, retryDelayMs: 0 })
  assert.deepEqual(await client.resolveSkills('Excel'), { skills: [] })
  assert.equal(calls.length, 2)
  await assert.rejects(client.resolveSkills('Excel'), /400/)
  assert.equal(calls.length, 3)
})

test('a second 502 is reported, not retried again', async () => {
  const { calls, fetch } = recorder([
    { status: 502, body: 'down' },
    { status: 502, body: 'still down' },
  ])
  const client = new HireLayerClient({ apiKey: 'k', fetch, retryDelayMs: 0 })
  await assert.rejects(client.extractJobCriteria('x'), (error) => error.status === 502)
  assert.equal(calls.length, 2)
})
