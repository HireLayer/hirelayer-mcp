import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url))

test('an invalid HIRELAYER_WORKSPACE stops the server with a clear message', () => {
  const result = spawnSync(process.execPath, [entry], {
    env: { ...process.env, HIRELAYER_API_KEY: 'k', HIRELAYER_WORKSPACE: 'acme corp' },
    encoding: 'utf8',
    input: '',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /HIRELAYER_WORKSPACE must contain letters, digits/)
})
