# Career Ops

Career Ops is the portal's evidence-based job evaluation and application-quality workspace (sidebar → **Career Ops**). It is deterministic and needs no AI service: every result is computed from the posting, your saved profile, and your own uploaded resume.

## What it does

| Capability | What you get |
|---|---|
| **A–G evaluation** | A role summary, CV match, level fit, compensation, personalisation, interview prep, and a posting-legitimacy check, rolled into a **1–5 score** with a verdict. |
| **The 4.0 bar** | Below 4.0/5 the portal recommends against applying. Hard blockers (sponsorship you need but the employer refuses, pay below your minimum, a suspicious posting) cap the score. |
| **Legitimacy (Block G)** | Scores whether the posting looks real: employer ATS hosting, published pay, posting age, hidden employer, payment/Telegram/gift-card language, free-mail recruiters, aggregator-only listings. Text aimed at an AI reviewer is quoted as an anomaly and ignored. |
| **Liveness check** | Fetches the posting and reports `active`, `expired` or `uncertain`. Public `https` hosts only; private/internal addresses and redirects to them are refused. |
| **Tailored resume** | Reorders and trims *your own* resume lines by relevance to the job (chronology is preserved). Output is a single-column, ATS-safe resume in Markdown and print-ready HTML. |
| **Fact gate** | Every output line is matched back to your source resume or saved profile. A line that cannot be traced fails the check. Job keywords you do not have are listed as not evidenced and are **never** added. |
| **ATS score & optimiser** | An estimated 0–100 ATS-readiness score (structure 25, job keywords 45, content quality 20, title alignment 10). The builder rebuilds in rounds until it reaches your target (default 90): list skills you already evidence, keep more relevant bullets, optional AI wording. It stops at the **honest maximum** when a job needs skills your resume does not show, and tells you which ones. It never adds a keyword you cannot evidence. |
| **AI bullet rewording (optional)** | Off unless the server sets `CAREEROPS_AI_KEY`. You opt in each time because your resume bullets and the job description go to the AI provider. Suggestions are checked in code before you see them: no new numbers, tools, titles, credentials, leadership or authorship; metrics kept; a JD term is allowed only if the same role already evidences it. Rejected suggestions keep your original line, you pick which to accept, and the server re-validates them on rebuild. |
| **Cover letter draft** | Built only from verbatim resume lines that evidence the job's requirements. Nothing is sent. |
| **Pipeline & follow-ups** | Maps portal data to canonical states (Evaluated, Applied, Responded, Interview, Offer, Hired…). Cadence: one follow-up after 7 days, one more 7 days later, then stop. Interview thank-you reminders. Drafts are yours to send. |
| **Insights** | Funnel and conversion, advance rate by fit score / role type / source, and the skills that keep showing up as missing. Small samples are labelled. |

## Using it

1. Upload your resume and complete your profile (years of experience, salary range, skills, sponsorship).
2. Open **Career Ops → Evaluate a job**. Pick a saved job, or paste a posting (optionally add it to your pipeline). The **Evaluate** button on any match card jumps straight here.
3. Read the verdict. If it says apply, open **Resume & cover letter**, review the changes and fact check, then copy or print to PDF.
4. Apply yourself (or through the existing Tailor & Apply flow), then use **Pipeline & follow-ups** to stay on cadence.

## Principles

- **Nothing is invented.** The resume builder reorders and trims; it never rewrites or adds claims.
- **Nothing is submitted for you.** Cover letters and follow-ups are drafts.
- **Posting text is data, not instructions.**
- **Quality over volume.** The score exists to steer you toward fewer, better applications.

## API

All routes require a signed-in session and live under `/api/jobs/careerops`.

| Route | Purpose |
|---|---|
| `POST /evaluate` | `{jobId}` or `{title, description, company?, location?, url?, save?}` → evaluation |
| `GET /evaluations`, `GET /evaluations/:jobId` | Saved evaluations |
| `POST /liveness` | `{jobId}` → `active` / `expired` / `uncertain` (rate limited) |
| `POST /resume` | `{jobId}` or pasted fields, plus optional `targetScore`, `aiConsent`, `rewrites` → tailored resume, ATS score and rounds, cover letter, fact check |
| `GET /ai` | Whether AI rewording is configured |
| `POST /rewrite` | `{jobId}` or pasted fields, `consent: true` → validated per-bullet suggestions (rate limited) |
| `GET /resume/:jobId/html` | Print-ready HTML of the last tailored resume |
| `GET /pipeline` | Pipeline rows with canonical state and next follow-up |
| `POST /followups` | `{jobId, channel?, note?}` log a follow-up you sent |
| `GET /patterns` | Funnel and pattern analysis |

Tables `job_evaluations` and `job_followups` are created automatically on start-up. Code lives in `src/careerops/`; run the tests with `npm test`.
