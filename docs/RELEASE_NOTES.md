# Release notes

**Document version:** 3.5.0

**Level:** Stable

**Last reviewed:** 2026-11-06

## Unreleased — Larger dashboard strip, full-height sidebar, clearer application steps

- **Confirm missing skills to raise the ATS score:** when a job asks for skills your resume does not show, the Resume & cover letter tab now asks **Do you have any of these skills?** with every box unticked. Tick the ones you genuinely have and **Add ticked skills & rebuild** adds them to the Skills section only (never to job history or bullets), rebuilds, and shows the new score; in a test, 74 became 91. Only keywords the job actually asks for are accepted, and an option saves the ticked skills to your profile so later resumes, matches and applications use them. The inline check on each job card links to it (**I have some of these**). Career Ops still never adds a skill you did not confirm.
- **Discover shows where each job stands:** every job card now carries a **New** flag (collected or posted in the last 3 days) and your application status (**Applied** with the date, **Ready to submit**, **Needs you** or **Preparing**). The button changes to match: applied jobs show a disabled **Applied** button and in-progress ones show **View application**, so a job you already started is never tailored twice.
- **Discover filters:** **Hide applied** (on by default) and **New only**, remembered in your browser.
- **In progress split in two:** the dashboard now shows **Ready to submit** (prepared, waiting for you to send it) and **Needs you** (login, CAPTCHA, an answer or a review). The strip has six tiles.
- **Mark applied:** every application that is ready to submit or needs you has a **Mark applied** button for when you have submitted on the employer's site; the tiles update immediately. **Submit now** only appears when automatic submission is actually configured. Ready applications say what to do next.
- **Layout:** the KPI strip moved to the right, above the main content, and the sidebar now runs the full height of the window from the header down, instead of starting below the strip. On narrow screens the sidebar stacks above the strip as before.
- **Dashboard tiles:** the five tiles are larger (bigger numbers and labels, taller) and are now one bar split into five equal sections with thin dividers, running edge to edge across the content area. Still one row at every width; below about 1,000px the bar scrolls sideways.

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
