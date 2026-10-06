# Changelog

All notable changes to this project are documented here. The project follows [Semantic Versioning](https://semver.org).

## 1.0.0 - 2026-10-06

First public release.

- Tools: `parse_resume`, `extract_job_criteria`, `match_candidate`, `rank_candidates` and `resolve_skills`.
- Prompts: `screen_candidates`, `summarize_resume` and `normalize_skills`.
- Server instructions that describe the screening workflow to the model.
- Progress notifications during long calls, so clients don't time out while a resume is parsed.
- One automatic retry on `502` and `503`, and cancellation of in-flight calls.
- Tool descriptions and instructions that tell the model the analysis text is in French.
- Error messages that say how to fix an invalid key or exhausted credits.
