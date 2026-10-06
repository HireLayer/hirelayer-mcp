#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { HireLayerClient, VERSION } from './client.js'
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

const server = createServer(
  new HireLayerClient({ apiKey, baseUrl: process.env.HIRELAYER_BASE_URL })
)
await server.connect(new StdioServerTransport())
