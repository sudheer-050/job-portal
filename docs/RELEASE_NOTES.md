# Release notes

**Document version:** 3.2.2

**Level:** Stable

**Last reviewed:** 2026-09-29

## Unreleased â€” Career Ops

- Added a Career Ops workspace: Aâ€“G job evaluation with a 1â€“5 score, posting-legitimacy and liveness checks, a fact-checked tailored resume and cover-letter draft, canonical pipeline states with follow-up cadence, and outcome insights. See [CAREER_OPS.md](CAREER_OPS.md).
- Added an ATS score with an optimiser that rebuilds the resume in rounds toward a target (default 90) using only truthful changes, and reports the honest maximum when a job needs skills the resume does not show.
- Added optional AI bullet rewording behind hard, code-enforced rules (`CAREEROPS_AI_KEY`); off by default and opt-in per request.
- Redesigned the whole application with a light, professional theme: slate neutrals, white surfaces, one indigo accent, segmented tabs, a refined sidebar and stat tiles. Styles moved from inline blocks to `app.css` and `updates.css`; contrast meets WCAG AA and there is no horizontal scroll from 320px up.
- Added an Evaluate button to every match card.
- New tables `job_evaluations` and `job_followups` are created automatically; no manual migration is needed.
- Version number and release date are intentionally unchanged until this is released.

## 3.2.2 â€” Product onboarding guide

- Added a plain-language explanation of what the Job Portal is and who it serves.
- Added a seven-step usage guide covering setup, discovery, focus plans, Hagent preparation, action-required tasks, tracking, and interview readiness.
- Clarified when the external submission runner is required.

## 3.2.1 â€” Product capability guide

- Added clear What's New and What It Can Do sections to the GitHub README.
- Added an in-product capability overview covering discovery, AI preparation, organization, and interview readiness.
- Clarified which workflow stages are operational and which require the external submission runner.

## 3.2.0 â€” Unified violet visual system

- Applied the Versions & Updates page's charcoal, zinc, and violet design system across the full portal.
- Unified backgrounds, glass surfaces, cards, borders, inputs, buttons, active navigation, and scrollbars.
- Adjusted violet controls to use dark foreground text for stronger contrast and readability.

## 3.1.2 â€” Main profile workspace

- Moved the complete profile and resume experience from beneath the navigation into the main workspace.
- Extended the glass navigation sidebar to the full available screen height.
- Added a responsive two-column profile/resume layout that stacks cleanly on narrower screens.

## 3.1.1 â€” Focused workspace navigation

- Replaced the long all-in-one workspace with a collapsible three-line sidebar.
- Split Discover, Focus, Applications, Profile, Interviews, Action Center, and Inbox into focused views.
- Preserved deep links and added a compact mobile navigation state.

## 3.1.0 â€” Focus, follow-up, and interview readiness

- Added an in-portal Action Center for application actions, interview reminders, offer deadlines, and verified employer links.
- Added focused-job plans with hiring stages, priority, recruiter/contact notes, and scheduled follow-ups.
- Added a job-specific interview preparation roadmap with research, requirements mapping, STAR stories, technical practice, questions, mock interviews, and logistics.
- Completed update and removal controls for interviews, offers, events, company notes, and screening answers.
- Added visible Hagent and external submission-runner readiness status.

## 3.0.0 â€” Career command center

- Redesigned the portal with a responsive navy, teal, and sky visual system and WCAG-aware focus states.
- Added saved and hidden jobs, saved searches, alert preferences, and dashboard analytics.
- Added structured career-profile sections for experience, education, certifications, projects, languages, volunteering, and references.
- Added interview scheduling, offer tracking, and an approved answer library for truthful auto-apply.
- Added reporting and expanded application data supplied to the Hagent recruiter.

## 2.0.1 â€” Public version-center route

- Published the version register under `/jobs/updates` so it follows the production portal routing boundary.

## 2.0.0 â€” Application operating system

- Added expanded candidate identity and preferences.
- Added Auto, Hybrid, and Review modes.
- Integrated Hagent recruiter and independent resume reviewer agents.
- Added tracked application stages, audit events, quality scores, and confirmation references.
- Added messages and notifications APIs and inbox interface.
- Added source, tailored-resume, and cover-letter revisions.
- Added the in-product Versions & Updates register.

## 1.1.0 â€” Multi-source discovery

- Added direct ATS and aggregator sources, normalized matching, deduplication, provider health, and freshness tracking.

## 1.0.0 â€” Initial portal

- Added accounts, role and location preferences, private resume storage, and personalized recommendations.
