# Installing the HireLayer MCP server (instructions for AI agents)

1. Ask the user for their HireLayer API key. If they don't have one, tell them to sign up at https://hirelayer.co/auth/signup (free plan, 50 credits a month, no card) and copy the key from Dashboard → API keys.
2. Add this entry to the MCP settings file, under `mcpServers`, with the key in place of `your-api-key`:

```json
{
  "mcpServers": {
    "hirelayer": {
      "command": "npx",
      "args": ["-y", "hirelayer-mcp"],
      "env": { "HIRELAYER_API_KEY": "your-api-key" }
    }
  }
}
```

3. The server needs Node.js 20 or later. Check with `node --version`.
4. To confirm it works, call `resolve_skills` with `{"text": "React, TypeScript, anglais courant", "language": "en"}`. It costs 1 credit and returns taxonomy skills.

Tools: `parse_resume` (resume file to JSON), `extract_job_criteria`, `match_candidate`, `rank_candidates` (up to 10 candidates) and `resolve_skills`. Pass absolute paths to `parse_resume`.
