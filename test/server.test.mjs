import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { HireLayerClient } from '../dist/client.js'
import { createServer } from '../dist/server.js'

async function connect(fetch) {
  const server = createServer(new HireLayerClient({ apiKey: 'k', fetch, retryDelayMs: 0 }))
  const client = new Client({ name: 'test', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

test('lists the five tools as read-only, non-destructive tools', async () => {
  const client = await connect(async () => new Response('{}'))
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'extract_job_criteria',
    'match_candidate',
    'parse_resume',
    'rank_candidates',
    'resolve_skills',
  ])
  for (const tool of tools) {
    assert.ok(tool.title, `${tool.name} has a title`)
    assert.equal(tool.annotations.title, tool.title)
    assert.equal(tool.annotations.readOnlyHint, true)
    assert.equal(tool.annotations.destructiveHint, false)
  }
})

test('exposes server instructions and workflow prompts', async () => {
  const client = await connect(async () => new Response('{}'))
  assert.match(client.getInstructions(), /extract_job_criteria/)
  const { prompts } = await client.listPrompts()
  assert.deepEqual(prompts.map((p) => p.name).sort(), ['normalize_skills', 'screen_candidates', 'summarize_resume'])
  const { messages } = await client.getPrompt({
    name: 'screen_candidates',
    arguments: { job_description: 'Senior React developer', resumes: '/tmp/a.pdf' },
  })
  assert.match(messages[0].content.text, /Senior React developer/)
})

test('only parse_resume takes a workspace, sent as the HireLayer-Workspace header', async () => {
  const calls = []
  const client = await connect(async (url, init) => {
    calls.push(init)
    return new Response('{"info_resume":{}}')
  })
  const { tools } = await client.listTools()
  const withWorkspace = tools.filter((t) => 'workspace' in t.inputSchema.properties).map((t) => t.name)
  assert.deepEqual(withWorkspace, ['parse_resume'])
  const schema = tools.find((t) => t.name === 'parse_resume').inputSchema.properties.workspace
  assert.equal(schema.pattern, '^[A-Za-z0-9._:~-]{1,200}$')
  assert.match(schema.description, /client workspace to keep this resume in.*omit for the default workspace/)

  const ok = await client.callTool({
    name: 'parse_resume',
    arguments: { file_path: fileURLToPath(import.meta.url), workspace: ' Acme-Corp ' },
  })
  assert.equal(ok.isError, undefined)
  assert.equal(calls[0].headers['HireLayer-Workspace'], 'acme-corp')

  const invalid = await client.callTool({
    name: 'parse_resume',
    arguments: { file_path: fileURLToPath(import.meta.url), workspace: 'acme corp' },
  })
  assert.equal(invalid.isError, true)
  assert.match(invalid.content[0].text, /workspace must contain/)
  assert.equal(calls.length, 1)
})

test('tool calls return the API JSON, and API errors as tool errors', async () => {
  const responses = [
    new Response('{"rankings":[{"rank":1,"application_id":"c1","score":0.9}]}'),
    new Response('{"error":"Insufficient credits"}', { status: 403 }),
  ]
  const client = await connect(async () => responses.shift())
  const ok = await client.callTool({
    name: 'rank_candidates',
    arguments: { job_text: 'React', candidates: [{ application_id: 'c1', candidate_text: 'React dev' }] },
  })
  assert.equal(ok.isError, undefined)
  assert.equal(JSON.parse(ok.content[0].text).rankings[0].application_id, 'c1')
  const failed = await client.callTool({ name: 'resolve_skills', arguments: { text: 'Excel' } })
  assert.equal(failed.isError, true)
  assert.match(failed.content[0].text, /403.*Insufficient credits/)
})
