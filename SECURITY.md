# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report vulnerabilities privately through [GitHub security advisories](https://github.com/hirelayer/hirelayer-mcp/security/advisories/new) or by email to [contact@hirelayer.co](mailto:contact@hirelayer.co).

Include the version, the steps to reproduce and the impact. We acknowledge reports within 3 business days and keep you informed until the fix is released.

## Supported versions

Security fixes go into the latest release. Update with `npx -y hirelayer-mcp@latest`.

## How the server handles data

- The server runs locally over stdio and sends requests only to the HireLayer API (`https://hirelayer.co` by default) over HTTPS. It has no telemetry.
- Your API key is read from the `HIRELAYER_API_KEY` environment variable and sent only in the `X-API-Key` header to the HireLayer API.
- `parse_resume` reads the local file passed in `file_path`, or downloads the URL passed in `file_url`, and uploads it to HireLayer for parsing. Set `do_not_store_data: true` to keep HireLayer from storing the file.
- Treat your API key as a secret: keep it out of version control and revoke it in the HireLayer dashboard if it leaks.
