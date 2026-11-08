# Release notes

**Document version:** 3.5.0

**Level:** Stable

**Last reviewed:** 2026-11-06

## Unreleased — Larger dashboard strip, full-height sidebar, clearer application steps

### Recruiter rules for resumes and cover letters

- Resumes get a one-line headline under the name (target role plus the skills the job asks for), built only from wording in your own resume.
- Key numbers are bold; the summary prefers sentences with numbers; the job's top skills must appear in the headline, summary or top of the skills list.
- Roles that ended more than 10 years ago show as one line each under Earlier Experience, and a role cut to fit one page shrinks to one line before it is dropped.
- Cover letters open with the role and company, quote up to three of your best results (numbers first) word for word, and are checked against 8 rules; a recruiter verdict (Shortlist / Maybe / Reject) with quick fixes is shown.
- Jobs show how long ago they were posted, with an apply-soon hint for the first week. Existing drafts rebuild automatically.


- **Career Ops remembers the skills you confirm:** when you say you have a missing skill on one job, it is stored (new table `job_confirmed_skills`) and used automatically for every later job that asks for it: evaluations, scans, CV match, ATS score, tailored resumes, applications and Discover ranking. The old "save to my profile" checkbox is gone because saving is now automatic. The built resume says which skills were reused from memory, and **Profile & resume → Skills you have confirmed** lists them with a **remove** link; removing one stops it being used. New endpoints `GET /api/jobs/careerops/skills` and `DELETE /api/jobs/careerops/skills/:skill`.
- **Add missing skills when CV match is under 95%:** the Check before you apply panel on each job card now shows **CV match is N% — aim for 95%** with **View missing skills**. It lists what the job asks for that your resume does not show (nothing ticked), and **Add ticked skills to my resume** adds the ones you confirm to your Skills, optionally saving them to your profile, then updates the CV match and ATS score right there. Applications below 95% have an **Add missing skills** button, the built resume shows its CV match, and the Applications list refreshes every time you open it.
- **Applications no longer go blank while Hagent is busy:** the list used to wait for every unfinished Hagent call (up to six minutes each) before showing anything, so the dashboard counted applications that the list could not yet show. The list now loads immediately and Hagent progress is checked in the background; while something is still being prepared the view refreshes itself every 15 seconds. It shows "Loading your applications…" and, on failure, an error with a **Try again** button.
- **Dashboard tiles open the right list:** **Ready to submit**, **Needs you** and **Applied** now open Applications already filtered to what they count (with a **Show everything in progress** link). Before, they all opened the same view, which could show nothing if the Applied jobs tab had been left selected.
- **Confirm missing skills to raise the ATS score:** when a job asks for skills your resume does not show, the Resume & cover letter tab now asks **Do you have any of these skills?** with every box unticked. Tick the ones you genuinely have and **Add ticked skills & rebuild** adds them to the Skills section only (never to job history or bullets), rebuilds, and shows the new score; in a test, 74 became 91. Only keywords the job actually asks for are accepted, and an option saves the ticked skills to your profile so later resumes, matches and applications use them. The inline check on each job card links to it (**I have some of these**). Career Ops still never adds a skill you did not confirm.
- **Discover shows where each job stands:** every job card now carries a **New** flag (collected or posted in the last 3 days) and your application status (**Applied** with the date, **Ready to submit**, **Needs you** or **Preparing**). The button changes to match: applied jobs show a disabled **Applied** button and in-progress ones show **View application**, so a job you already started is never tailored twice.
- **Discover filters:** **Hide applied** (on by default) and **New only**, remembered in your browser.
- **In progress split in two:** the dashboard now shows **Ready to submit** (prepared, waiting for you to send it) and **Needs you** (login, CAPTCHA, an answer or a review). The strip has six tiles.
- **Mark applied:** every application that is ready to submit or needs you has a **Mark applied** button for when you have submitted on the employer's site; the tiles update immediately. **Submit now** only appears when automatic submission is actually configured. Ready applications say what to do next.
- **Layout:** the KPI strip moved to the right, above the main content, and the sidebar now runs the full height of the window from the header down, instead of starting below the strip. On narrow screens the sidebar stacks above the strip as before.
- **Dashboard tiles:** the five tiles are larger (bigger numbers and labels, taller) and are now one bar split into five equal sections with thin dividers, running edge to edge across the content area. Still one row at every width; below about 1,000px the bar scrolls sideways.

## Unreleased — Missing skills where you can see them

- **Pick missing skills right on the row:** each application below 95% CV match now lists its missing skills with tick boxes directly under the Career Ops score, with **Add ticked skills to my resume** beside them; the CV match updates in place. The Discover check panel shows the same list open by default (it can still be collapsed). The Career Ops tab, when opened for a job, builds the resume straight away so its question is on screen.

## Unreleased — Applications rewrite themselves

- **The experience section is read correctly:** a resume uploaded as a PDF has every line wrapped, and the reader mistook the wrapped lines for new jobs (for example "SQL, processing 1M+ records…" and "CLIs" became role headings), read your whole projects section as work experience because headings such as "PROJECTS & PORTFOLIO" and "CERTIFICATIONS & PROFESSIONAL DEVELOPMENT" were not recognised, and then dropped your real jobs to fit one page. The reader (new `src/careerops/parse.js`) now understands capitals-only headings, joins wrapped lines (including ones that start with a capital letter or an acronym, a blank line in the middle of a bullet, and a word split by a hyphen), finds each role from its dates, treats a lone word such as "License" at the end of a wrapped sentence as text and not a heading, reads projects and certifications as their own sections, and puts roles in date order by month. Every bullet of every role now stays, most relevant first, and the one-page rule alone decides what has to go (the summary is kept ahead of a role's third bullet; projects are ranked by how well they fit the job).
- **Drafts built by the old reader are rebuilt automatically:** each Career Ops draft now records which version of the reader built it, and any draft that was not built by the current one is rebuilt from your stored resume text the next time you open Applications (shown as "Career Ops is rewriting", no re-upload needed). A rebuilt draft keeps its status and the reason it was rebuilt is recorded. Applications already marked Applied are never touched.
- **See how your resume was read:** the Career Ops tab shows **How your resume was read**: every role with its dates and bullets, project and certification counts, and a **Please check** list when something looks wrong (a role with no dates, a role heading that reads like a sentence, a role with no bullets, a very short bullet that may be a broken line). The same warnings appear on each built resume. New endpoint `GET /api/jobs/careerops/resume-reading`.
- **Resumes follow the standard resume rules (hard rules):** on top of one page, every resume Career Ops builds now follows the rules recruiters and applicant tracking systems agree on. **The summary is at most 4 lines** (about 60 words): a longer summary is cut back to your own whole sentences, preferring ones that mention what the job asks for and leaving out sentences with "I", "my" or filler such as "results-driven". Also enforced by removing or reordering only: roles newest first, at most 5 bullets for each of the two newest roles and 4 for older ones, at most 20 skills, and no references line, hobbies or personal details (these sections used to be absorbed into Education). Rules that need your own words are reported with the exact lines to change: bullets over two lines, no action verb, "responsible for" and "helped with", no real number, repeated opening verbs, missing contact details. The Career Ops tab shows **Resume rules: N of 18 followed** with what to fix, and the "How to improve" panel lists rules not yet followed. Nothing is ever written for you, so the fact check still passes (a kept summary is checked sentence by sentence). Existing ready drafts whose summary runs past four lines are rebuilt automatically, and Hagent is given the same rules and its reviewer fails a resume that breaks them. A new test parses every server and page script so a typo can no longer reach production unnoticed.
- **The one-page rule now covers applications waiting on you too:** applications in **Needs you** because the employer portal needs a login or a submission connector were skipped, so their long Hagent drafts stayed at three pages. They are now rebuilt to one page like the rest. Such an application keeps its status and its reason (for example "needs a supported submission connector"); only the resume and cover letter change. Any application with a resume over one page also shows a **Rewrite with Career Ops** button.
- **Every resume is one page (hard rule):** the resume Career Ops builds is measured with the same layout the PDF uses and, while it runs past a page, the least valuable content is left out one piece at a time: the deepest bullets of the oldest roles first, then old roles, projects, extra certifications and skills. Whatever still fits is then put back, most valuable first, so the page is used fully. The newest role keeps at least three bullets and education and contact details are never cut. Content is only ever removed, never added or reworded, so the resume stays true and passes the same fact check. The result says what was left out, the Career Ops tab shows a **1 page** badge, and the download button says "Download resume v2 · 1 page". A draft that cannot be brought to one page is never swapped in, and the reason is shown. Existing ready drafts that run past a page are rebuilt automatically the next time you open Applications (shown as "Career Ops is rewriting"). Hagent is now told the rule too, and its reviewer fails a longer resume. The ATS length check now gives full marks to 200 to 700 words instead of penalising a one-page resume.
- **New deploys reach everyone straight away:** the page now stamps every script and stylesheet link with the build id (so a cached copy can never run with new code, which browsers and the CDN otherwise keep for hours), is never cached, and an open tab checks every minute and whenever it is shown again whether a newer version is live, showing **A newer version of the portal is available. Reload now**. New endpoint `GET /api/jobs/version`. This fixes new features (such as the PDF and Word download menu) appearing to be missing in a tab opened before a deploy.
- **Download your resume and cover letter as PDF, Word or Markdown:** every **Download resume** and **Download cover letter** button on Applications is now a menu offering **PDF**, **Word (.docx)** and **Markdown (.md)**, and the Career Ops tab has the same Download menu on the resume and the cover letter (it exports the text as shown, so edits to the cover letter are kept). Files are named like "Jordan Rivera - Resume - Northwind - v2.pdf". Documents are single column with standard headings, no tables or graphics, so applicant tracking systems read them cleanly. They are generated on the server with no new dependencies. Existing download links still return Markdown; add `?format=pdf`, `docx` or `md` to the application endpoints, or `POST /api/jobs/careerops/export` for text that is not saved yet.
- **How to improve this score:** every application that is not applied yet has a **How to improve this score** button. It shows the ATS estimate, the most the resume can honestly reach as it stands, and how high it could go if you truly have the missing skills; where the points are lost; **What I need from you** (the missing skills as unticked boxes, with an Add button); and **What to add or change in your resume**, naming the exact lines that need a real number, a stronger verb or less first-person wording, and the roles with fewer than three bullets. **Rebuild with everything I know** rebuilds the draft. When a row's number is Hagent's review score, the panel says it is a different measure. New endpoint `GET /api/jobs/careerops/improve/:jobId`; rebuilding a ready draft from the row is now allowed.
- **You are told when scores are not final:** a banner at the top of the page appears whenever resumes or cover letters are being prepared or rewritten, or scores are being recalculated after you add skills ("Scores may change until this message goes away"), and it clears by itself when the work is done. Each application being worked on is marked "updating", dimmed, and explains what is happening (preparing, being reviewed, or being rewritten by Career Ops). The Applications list reports this through new `processing` and `scoring` fields.
- **Raise your scores across all your jobs:** Profile & resume now has a **Raise your scores across all your jobs** list of the skills your scored jobs ask for most often that your resume and profile do not show, with how many jobs ask for each. Tick the ones you genuinely have (nothing is ticked for you) and press **I have these — add and re-score**: they are remembered, every scored job is recalculated, and unsent applications are rebuilt. New endpoints `GET /api/jobs/careerops/skill-gaps`, `POST /api/jobs/careerops/skills/bulk` and `POST /api/jobs/careerops/refresh-drafts`.
- **Everything updates when it is done:** confirming a skill anywhere (job card, application row, Career Ops tab or the new list) now re-scores all your jobs and rebuilds your unsent Career Ops drafts, then refreshes Discover, Applications and the dashboard tiles on screen without a reload. The result states the change, for example average CV match 45% to 73% and average ATS 51 to 81.
- Function words from Dutch, German, French and Spanish postings (such as voor, niet, und, pour) are no longer treated as skills.
- **Automatic rewrite:** an application that failed Hagent's review (needs review), or that Hagent has not finished after 30 minutes, is rewritten by Career Ops in the background the next time the Applications list loads. The new resume and cover letter use the same fact check as any other Career Ops draft; only a draft that passes replaces the old one, and the application moves to **Ready to submit** (resume and cover letter versions go up by one). Nothing is ever submitted automatically. Rows say they were rewritten and why, one notification summarises a batch, and an application that cannot be rewritten (for example no resume uploaded) shows the reason once and is not retried. Applications waiting on a login or CAPTCHA are left alone. A **Rewrite with Career Ops** button on Needs you rows does it on demand (POST /api/jobs/applications/:id/rewrite).

## Unreleased — Separate application tabs

- **Applications now has four tabs:** **Preparing**, **Ready to submit**, **Needs you** and **Applied**, each with a count. They replace the combined "Preparing / ready" tab, so what is waiting for you is no longer mixed with what is still being prepared. The dashboard tiles open the matching tab, and the old "Showing only" filter line is gone.

## 3.5.0 — Inline apply check and a compact dashboard

Released 2026-11-06.

- **Check before you apply** now sits on each job card directly under the Tailor & apply buttons, as a same-size button. It opens a fuller check: a clear recommendation, role summary, skills and requirements against your resume, fit and approach, keywords to feature, gaps to address honestly, and questions to ask the employer. The warning dialog for low-fit or suspicious jobs is unchanged.
- **Dashboard tiles:** the strip is now a single row of five tiles (Strong matches, Saved, In progress, Applied, Follow-ups due). Interviews, Offers and Unread were removed from it; those items remain in their own sections. On very narrow screens the row scrolls sideways instead of wrapping. The tiles are now compact: the number sits beside its label, so each tile is about half its previous height.

## 3.4.0 — Profile sources, Career Ops in every step, forgot password

Released 2026-11-06.

### Profile sources and a clearer dashboard

- **Keep your profile up to date:** suggest projects, experience and skills from your public GitHub repositories (your own, non-fork), your portfolio website, and your LinkedIn data export. Suggestions wait in a review list; nothing reaches your resume or skills until you approve it, dismissed items never return, and approved items create a new resume version that Career Ops uses on its next scan. GitHub and the portfolio are checked about weekly (switch-off available) with a quiet notification when something new appears. New endpoints under `/api/jobs/profile-sources`; new tables `job_profile_sources` and `job_source_findings`; optional `GITHUB_TOKEN`.
- **Dashboard tiles:** the KPI strip now lines up exactly with the content below it (it was inset twice), uses equal-size tiles that divide evenly at every width (8, then 4 + 4, then 2 × 4), and each tile links to its section. Two Career Ops tiles were added: **Strong matches** (4.0+ jobs you have not started) and **Follow-ups due**.
- Fixed a phone-width overflow in the Profile view.

### Career Ops inside the portal's steps

- **Discover:** matches are scanned automatically against your resume; each job card shows its Career Ops score, verdict, legitimacy and CV coverage, with sorting by score and an option to hide jobs below 4.0 or flagged as suspicious.
- **Tailor & apply:** a check before applying warns about low-fit or suspicious jobs (Cancel is the default; "Apply anyway" is always available). Strong jobs proceed with no extra click.
- **Applications:** every application is evaluated when it starts and shows its result.
- **Action Center:** due and overdue follow-ups raise alerts.
- New endpoints `POST /api/jobs/careerops/scan` and `GET /api/jobs/careerops/scores`.
- **Skills analysis in Discover:** a "Why this score" panel on each scanned job card shows the skills you evidence and are missing, each requirement with your resume line as evidence, level and pay fit, and posting warnings.
- **Tailor & apply works without Hagent:** Career Ops prepares a fact-checked, ATS-optimised resume and cover letter and leaves the application "ready to submit" for you to review and send. It is never submitted automatically.
- **Apply & track tab:** apply to one job from start to finish (check, prepare, start, open the employer page, mark applied) with a follow-up reminder afterwards. New endpoint `POST /api/jobs/careerops/apply`.
- Application rows from Career Ops show "ATS n/100" and link to the print-ready resume.

### Forgot password

- Added a **Forgot password?** link to the log-in page with a secure email reset flow: single-use 30-minute tokens (only a hash is stored), identical responses for every input, per-IP and per-account limits, and a standalone `/jobs/reset` page that keeps the token in the URL fragment.
- Added SMTP settings (`SMTP_*`, `PUBLIC_BASE_URL`) to the compose files and `.env.example`. Without SMTP no email is sent; `PASSWORD_RESET_LOG_LINKS=true` prints links to the server log for owner-assisted resets.
- Added the `nodemailer` dependency and a `job_password_resets` table, created automatically.

## 3.3.0 — Career Ops, ATS optimiser, and light redesign

- Added a Career Ops workspace: A–G job evaluation with a 1–5 score, posting-legitimacy and liveness checks, a fact-checked tailored resume and cover-letter draft, canonical pipeline states with follow-up cadence, and outcome insights. See [CAREER_OPS.md](CAREER_OPS.md).
- Added an ATS score with an optimiser that rebuilds the resume in rounds toward a target (default 90) using only truthful changes, and reports the honest maximum when a job needs skills the resume does not show.
- Added optional AI bullet rewording behind hard, code-enforced rules (`CAREEROPS_AI_KEY`); off by default and opt-in per request.
- Redesigned the whole application with a light, professional theme: slate neutrals, white surfaces, one indigo accent, segmented tabs, a refined sidebar and stat tiles. Styles moved from inline blocks to `app.css` and `updates.css`; contrast meets WCAG AA and there is no horizontal scroll from 320px up.
- Added an Evaluate button to every match card.
- New tables `job_evaluations` and `job_followups` are created automatically; no manual migration is needed.
- Released November 6, 2026. Set `CAREEROPS_AI_KEY` to enable optional AI rewording; everything else works without it.

## 3.2.2 — Product onboarding guide

- Added a plain-language explanation of what the Job Portal is and who it serves.
- Added a seven-step usage guide covering setup, discovery, focus plans, Hagent preparation, action-required tasks, tracking, and interview readiness.
- Clarified when the external submission runner is required.

## 3.2.1 — Product capability guide

- Added clear What's New and What It Can Do sections to the GitHub README.
- Added an in-product capability overview covering discovery, AI preparation, organization, and interview readiness.
- Clarified which workflow stages are operational and which require the external submission runner.

## 3.2.0 — Unified violet visual system

- Applied the Versions & Updates page's charcoal, zinc, and violet design system across the full portal.
- Unified backgrounds, glass surfaces, cards, borders, inputs, buttons, active navigation, and scrollbars.
- Adjusted violet controls to use dark foreground text for stronger contrast and readability.

## 3.1.2 — Main profile workspace

- Moved the complete profile and resume experience from beneath the navigation into the main workspace.
- Extended the glass navigation sidebar to the full available screen height.
- Added a responsive two-column profile/resume layout that stacks cleanly on narrower screens.

## 3.1.1 — Focused workspace navigation

- Replaced the long all-in-one workspace with a collapsible three-line sidebar.
- Split Discover, Focus, Applications, Profile, Interviews, Action Center, and Inbox into focused views.
- Preserved deep links and added a compact mobile navigation state.

## 3.1.0 — Focus, follow-up, and interview readiness

- Added an in-portal Action Center for application actions, interview reminders, offer deadlines, and verified employer links.
- Added focused-job plans with hiring stages, priority, recruiter/contact notes, and scheduled follow-ups.
- Added a job-specific interview preparation roadmap with research, requirements mapping, STAR stories, technical practice, questions, mock interviews, and logistics.
- Completed update and removal controls for interviews, offers, events, company notes, and screening answers.
- Added visible Hagent and external submission-runner readiness status.

## 3.0.0 — Career command center

- Redesigned the portal with a responsive navy, teal, and sky visual system and WCAG-aware focus states.
- Added saved and hidden jobs, saved searches, alert preferences, and dashboard analytics.
- Added structured career-profile sections for experience, education, certifications, projects, languages, volunteering, and references.
- Added interview scheduling, offer tracking, and an approved answer library for truthful auto-apply.
- Added reporting and expanded application data supplied to the Hagent recruiter.

## 2.0.1 — Public version-center route

- Published the version register under `/jobs/updates` so it follows the production portal routing boundary.

## 2.0.0 — Application operating system

- Added expanded candidate identity and preferences.
- Added Auto, Hybrid, and Review modes.
- Integrated Hagent recruiter and independent resume reviewer agents.
- Added tracked application stages, audit events, quality scores, and confirmation references.
- Added messages and notifications APIs and inbox interface.
- Added source, tailored-resume, and cover-letter revisions.
- Added the in-product Versions & Updates register.

## 1.1.0 — Multi-source discovery

- Added direct ATS and aggregator sources, normalized matching, deduplication, provider health, and freshness tracking.

## 1.0.0 — Initial portal

- Added accounts, role and location preferences, private resume storage, and personalized recommendations.
