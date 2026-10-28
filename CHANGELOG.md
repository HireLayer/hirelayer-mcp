# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org).

## 2.0.0 - Unreleased

The server now calls the HireLayer API v4 (`https://hirelayer.co/api/v4`), where each HireLayer product has one endpoint. The v1 endpoints that 1.x called are retired, so 1.x stops working once they are switched off: update to 2.0.0.

**Breaking changes**

- `match_candidate` and `rank_candidates` are replaced by `score_resumes` (Resume Scorer): 1 to 50 resumes against one job in one call, each with a score from 0 to 1, a verdict, a summary, the required criteria missing or to verify, and the evidence for each criterion, best first. `precise_ranking: true` re-ranks the 10 best against each other with a `ranking_reason`, for 1 credit more per call. When the evaluations outlast the API's wait (`202`), the tool reads the call's results until every resume is scored. `language` goes with `job_text` only: a stored job keeps its own. Give the job as `job_text` (criteria extracted on the way, or your own `criteria`) or as a stored `job_id`, and each resume as `text` or as a stored `application_id`.
- `resolve_skills` is renamed `normalize_skills` (Skills Normalizer), same input: skills written in any language, names returned in French or English.
- The prompt `normalize_skills` is renamed `normalize_skills_list`, so that clients do not mistake it for the tool.
- `extract_job_criteria` sends the job as `job_text` (with optional `title`, `location`, `language`, `job_id`) and returns typed criteria: `criterion_id`, `label`, `type`, `requirement` (`required`, `preferred` or `bonus`), `weight` from 0 to 3 and `threshold`, plus the `job_id` the job is stored under. It is free, except a new text sent under the `job_id` of a job already scored: its stored scores are evaluated again, 1 credit each.
- `parse_resume` returns the v4 shape: `application_id`, `stored`, `already_stored`, `warnings`, `credits_used`, and the parsed resume in `resume` (full text in `resume.info_resume.text`). A file already stored costs 0 credits. `do_not_store_data` needs the Enterprise plan.
- The text HireLayer writes (criteria, summaries, explanations) is in the job's language, French or English, instead of always French; `language` overrides it.
- No tool is read-only any more except `normalize_skills`: HireLayer keeps the resumes, jobs and scores in your account, as the REST API does. No tool deletes anything.
- API errors read `HireLayer API returned <status> (<code>): <message>`, with the v4 error `code` (such as `insufficient_credits`), the input at fault when the API names one, and the `request_id` to quote to support.

**New**

- `search_resumes` (Talent Pool Search): the stored resumes closest to a job, with optional city, radius and date filters.
- `search_jobs` (Job Recommendations): the stored open jobs closest to a resume.
- `parse_resume` also takes the resume as plain text (`resume_text`) and accepts HTML and Markdown files.
- Every tool except `normalize_skills` takes an optional `workspace`, sent as the `HireLayer-Workspace` header, to keep each client company's jobs, resumes and scores apart.
- Tool annotation titles are the product names: Resume Parser, Job Criteria Extractor, Resume Scorer, Talent Pool Search, Job Recommendations and Skills Normalizer.
- The `screen_candidates` prompt scores every resume in one `score_resumes` call with the precise ranking.

## 1.1.2 - 2026-10-22

- `rank_candidates` takes `candidates[].application_id` and returns `rankings[].application_id`, as the Rank API now expects: calls with `id` were rejected.

## 1.1.1 - 2026-10-06

- Tool annotations carry a human-readable `title`, as the Claude and ChatGPT directories expect.
- ChatGPT plugin package in `chatgpt-plugin/` and a sample PDF resume in `examples/`.

## 1.1.0 - 2026-10-06

- Hosted server at `https://hirelayer.co/mcp`: connect Claude, ChatGPT, Cursor, VS Code or Codex with the URL and a HireLayer sign-in (OAuth), no API key needed. Listed as a remote in the MCP Registry.
- README and one-click installs point to the hosted server; the npx server stays available for local files.

## 1.0.0 - 2026-10-06

First public release.

- Tools: `parse_resume`, `extract_job_criteria`, `match_candidate`, `rank_candidates` and `resolve_skills`.
- Prompts: `screen_candidates`, `summarize_resume` and `normalize_skills`.
- Server instructions that describe the screening workflow to the model.
- Progress notifications during long calls, so clients don't time out while a resume is parsed.
- One automatic retry on `502` and `503`, and cancellation of in-flight calls.
- Tool descriptions and instructions that tell the model the analysis text is in French.
- Error messages that say how to fix an invalid key or exhausted credits.
