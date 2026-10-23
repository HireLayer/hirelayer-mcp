#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { HireLayerClient, VERSION, WORKSPACE_PATTERN, WORKSPACE_RULE } from './client.js'
import { createServer } from './server.js'

if (process.argv.includes('--version')) {
  console.log(VERSION)
  process.exit(0)
}

const apiKey = process.env.HIRELAYER_API_KEY
if (!apiKey) {
  console.error(
    'HIRELAYER_API_KEY is not set. Create a free key (50 credits a month) at https://hirelayer.co and pass it in the server env.'
  )
  process.exit(1)
}

const workspace = process.env.HIRELAYER_WORKSPACE?.trim()
if (workspace && !WORKSPACE_PATTERN.test(workspace)) {
  console.error(
    `HIRELAYER_WORKSPACE must contain ${WORKSPACE_RULE}. Fix it in the server env, or remove it to use the default workspace.`
  )
  process.exit(1)
}

const server = createServer(
  new HireLayerClient({ apiKey, baseUrl: process.env.HIRELAYER_BASE_URL, workspace })
)
await server.connect(new StdioServerTransport())
