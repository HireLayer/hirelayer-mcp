import assert from 'node:assert/strict'
import { test } from 'node:test'
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

test('tool calls return the API JSON, and API errors as tool errors', async () => {
  const responses = [
    new Response('{"rankings":[{"rank":1,"candidate_id":"c1","score":0.9}]}'),
    new Response('{"error":"Insufficient credits"}', { status: 403 }),
  ]
  const client = await connect(async () => responses.shift())
  const ok = await client.callTool({
    name: 'rank_candidates',
    arguments: { job_text: 'React', candidates: [{ id: 'c1', candidate_text: 'React dev' }] },
  })
  assert.equal(ok.isError, undefined)
  assert.equal(JSON.parse(ok.content[0].text).rankings[0].candidate_id, 'c1')
  const failed = await client.callTool({ name: 'resolve_skills', arguments: { text: 'Excel' } })
  assert.equal(failed.isError, true)
  assert.match(failed.content[0].text, /403.*Insufficient credits/)
})
