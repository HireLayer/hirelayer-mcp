# HireLayer MCP server

[![npm](https://img.shields.io/npm/v/hirelayer-mcp)](https://www.npmjs.com/package/hirelayer-mcp) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server for the [HireLayer](https://hirelayer.co) recruiting APIs. It lets Claude, Cursor, VS Code and any other MCP client parse resumes, turn job descriptions into criteria, then match and rank candidates.

| Tool | What it does | HireLayer API |
|---|---|---|
| `parse_resume` | Parses a resume file (PDF, DOC, DOCX, ODT, PPT, PPTX, ODP, XLS, RTF, TXT, JPG, PNG, BMP, under 4.5 MB) into structured JSON: contact details, experience, education, languages, skills and the full text | [CV Extract](https://hirelayer.co/api-docs) |
| `extract_job_criteria` | Turns a job description into weighted matching criteria | Job Extract |
| `match_candidate` | Scores one candidate against a job, criterion by criterion (score from 0 to 1) | Match |
| `rank_candidates` | Ranks up to 10 candidates for the same job | Rank |
| `resolve_skills` | Maps free-text skills (French or English) to skills of the HireLayer taxonomy | Skills |

Each successful tool call costs one HireLayer credit. The free plan includes 50 credits a month, no card required.

## Setup

1. Create an account at [hirelayer.co](https://hirelayer.co) and copy your API key from the dashboard.
2. Add the server to your MCP client.

### Claude Desktop, Cursor, Windsurf and other JSON configs

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

### Claude Code

```bash
claude mcp add hirelayer --env HIRELAYER_API_KEY=your-api-key -- npx -y hirelayer-mcp
```

### VS Code

```json
{
  "servers": {
    "hirelayer": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "hirelayer-mcp"],
      "env": { "HIRELAYER_API_KEY": "your-api-key" }
    }
  }
}
```

## Example prompts

- "Parse ~/Downloads/jane-doe.pdf and summarize her experience."
- "Extract the criteria from this job description, then score the three resumes in ~/candidates against it."
- "Rank these candidates for the Senior React role and explain the top pick."
- "Normalize this skills section: Pack Office (Word, Excel), React.js, anglais courant."

`parse_resume` reads local files, so the server runs on your machine with stdio. Set `do_not_store_data: true` in a call if HireLayer should not keep the resume file.

## Configuration

| Variable | Required | Default |
|---|---|---|
| `HIRELAYER_API_KEY` | Yes | |
| `HIRELAYER_BASE_URL` | No | `https://hirelayer.co` |

## Development

```bash
npm install
npm test
HIRELAYER_API_KEY=your-api-key npx @modelcontextprotocol/inspector node dist/index.js
```

## Links

- API reference: [hirelayer.co/api-docs](https://hirelayer.co/api-docs)
- OpenAPI: [hirelayer.co/openapi.json](https://hirelayer.co/openapi.json)
- Docs for agents: [hirelayer.co/llms.txt](https://hirelayer.co/llms.txt)

## License

MIT
