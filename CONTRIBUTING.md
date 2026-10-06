# Contributing

Thanks for helping improve the HireLayer MCP server. Issues and pull requests are welcome.

## Set up

```bash
git clone https://github.com/hirelayer/hirelayer-mcp.git
cd hirelayer-mcp
npm install
npm test
```

`npm test` builds the TypeScript sources and runs the tests with a mocked HireLayer API, so it needs no API key and uses no credits.

To try your changes in a real client, build and point the client at your checkout:

```bash
npm run build
HIRELAYER_API_KEY=your-api-key npx @modelcontextprotocol/inspector node dist/index.js
```

## Code layout

| Path | Contents |
|---|---|
| `src/client.ts` | HTTP client for the HireLayer REST API |
| `src/server.ts` | MCP tools, prompts and server instructions |
| `src/index.ts` | stdio entry point |
| `test/` | Tests run with `node --test` |

## Pull requests

- Keep tool names stable: clients and prompts depend on them.
- Write tool descriptions for the model: say what the tool returns, when to use it and what it costs.
- Add or update tests, and note user-facing changes in `CHANGELOG.md`.

## Releases

Maintainers bump `version` in `package.json` and in both places in `server.json`, update `CHANGELOG.md`, then push a `vX.Y.Z` tag. The release workflow publishes to npm and the MCP Registry.

## ChatGPT plugin package

`chatgpt-plugin/` holds the package uploaded to the ChatGPT plugin directory (`plugin.json` with the listing, review test cases and release notes, `mcp.json` with the hosted server URL, and icons). Keep its `version` in line with `package.json`, then build the ZIP from inside the folder:

```bash
cd chatgpt-plugin && zip -r ../hirelayer-chatgpt-plugin.zip . -x '.*'
```
