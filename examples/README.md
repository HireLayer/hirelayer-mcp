# Examples

Sample files to try the HireLayer MCP server in two minutes. Everything here is fictional.

| File | What it is |
|---|---|
| [`job-senior-react-developer.md`](job-senior-react-developer.md) | A job description |
| [`resume-alex-morgan.txt`](resume-alex-morgan.txt), [`.pdf`](resume-alex-morgan.pdf) | Strong match: 8 years of React and TypeScript, team lead (also as a PDF to test file attachments) |
| [`resume-camille-durand.txt`](resume-camille-durand.txt) | Partial match: senior front end, but Vue.js rather than React (in French) |
| [`resume-sam-lee.txt`](resume-sam-lee.txt) | Weak match: back-end profile with some React |

Clone the repository (or download the files), then ask your AI assistant:

> Screen the three resumes in `examples/` against `examples/job-senior-react-developer.md` and give me a shortlist.

The assistant scores the three resumes against the job in one `score_resumes` call (the job's criteria are extracted on the way, for free) and explains the ranking. The run uses 3 to 6 of the 50 free monthly credits: 1 per resume scored, plus 1 per resume file the assistant parses with `parse_resume` rather than reading it itself. Asking again for the same job and resumes costs nothing.
