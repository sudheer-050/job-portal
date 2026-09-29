# Job Portal

**Product version:** 3.2.2

**Release level:** Stable

**Last reviewed:** 2026-09-29

A self-hosted job discovery application that collects postings from multiple
public job APIs and employer applicant-tracking systems, then ranks them against
each user's desired roles, location, work style, salary range, and private
resume.

**Live portal:** [myhai.org/jobs](https://myhai.org/jobs)

**Versions & updates:** [myhai.org/jobs/updates](https://myhai.org/jobs/updates)

## What this is

Job Portal is a private career-search command center. It brings job discovery, personalized matching, resume preparation, application tracking, follow-ups, and interview preparation into one workspace. Hagent can tailor application documents and independently review them for relevance, ATS readability, and truthfulness before an application proceeds.

It is designed for the candidate—not the employer. The portal keeps your verified profile and source resume as the factual foundation, shows why each job matches, and records every application stage without claiming a submission succeeded unless an employer confirmation or explicit candidate confirmation exists.

## How to use it

1. **Complete Profile & Resume.** Add your identity, desired roles, locations, salary and work preferences, qualifications, work authorization, skills, source resume, and approved screening answers.
2. **Open Discover Jobs.** Review ranked matches and the explanation for each score. Save strong possibilities, hide poor fits, or report a bad listing.
3. **Create a Focus Plan.** Select Focus for priority roles, assign the hiring stage, add recruiter/contact notes, and schedule the next follow-up.
4. **Prepare an application.** Select Tailor & Apply. Hagent prepares the resume and cover letter, then a separate reviewer checks truthfulness and quality.
5. **Follow the Action Center.** Complete login, CAPTCHA, missing-answer, or unsupported-portal steps when the application is marked Action Required.
6. **Track progress.** Use Applications for preparing, ready, action-required, and applied jobs. The portal preserves events, document versions, quality scores, links, and confirmation references.
7. **Prepare for interviews.** Build the job-specific roadmap, complete research and STAR stories, practice technical topics, write interviewer questions, and record interviews and offers.

For genuine unattended submission, configure the external submission runner and authenticated job-portal sessions. Without that connector, the portal safely prepares and reviews the application, then provides the employer link for completion.

## What's new in v3.2

- One consistent charcoal, zinc, and violet visual system across the portal and version center
- A collapsible workspace sidebar that separates Discover, Focus, Applications, Profile, Interviews, Alerts, and Inbox
- A main-area profile and resume editor with responsive desktop and mobile layouts
- Focused-job follow-up planning and a seven-step interview preparation roadmap
- An Action Center for application tasks, interview reminders, offer deadlines, and verified employer links

## What it can do

### Discover and prioritize jobs

- Collect jobs from public APIs and direct employer applicant-tracking systems
- Rank jobs against role, location, work style, salary, experience, education, sponsorship, skills, and resume content
- Explain match strengths and preference gaps
- Save, hide, report, focus, and revisit jobs and searches

### Prepare stronger applications

- Store a private source resume and structured candidate profile
- Ask Hagent to tailor a resume and cover letter to a selected job
- Run an independent truthfulness and quality review before submission
- Use only candidate-approved screening answers in automatic workflows

### Manage the complete search

- Track preparing, ready, action-required, and applied applications
- Maintain follow-up dates, recruiter/contact notes, interviews, events, offers, and company research
- Surface in-portal alerts and employer application links
- Preserve document revisions, application events, quality scores, and confirmation references

### Know the automation boundary

The portal can discover, tailor, verify, organize, and prepare applications today. Real third-party auto-submission additionally requires a configured submission runner and authenticated portal sessions. CAPTCHA, missing legal answers, and unsupported sites stop at **Action Required** rather than being reported as successfully submitted.

## Features

- Separate user accounts and private PDF/text résumé storage
- Independent lists for desired roles and preferred locations
- Personal expectations for work style, salary range, education, experience,
  employment type, visa sponsorship, and key skills
- Shared scheduled ingestion instead of repeating provider calls per user
- Direct Greenhouse, Lever, Ashby, and Workable employer-board adapters
- RemoteOK, Remotive, Arbeitnow, Jobicy, Himalayas, The Muse, Adzuna, USAJOBS,
  and Jooble adapters
- Normalization, cross-source deduplication, freshness tracking, and closed-job handling
- Explainable match scores and original provider/application links
- Full application identity, job preferences, work authorization, and Auto/Hybrid/Review modes
- Hagent resume tailoring followed by a separate, truthfulness-first quality review
- Preparing, action-required, and applied-job tracking with an auditable event history
- Central message, recruiter-update, and notification APIs
- Saved and hidden jobs, reusable searches, configurable alerts, and career dashboard analytics
- Structured experience, education, certifications, projects, languages, interviews, and offer tracking
- Candidate-approved screening-answer library for truthful auto-apply completion
- In-portal action alerts with employer/application links and read-state controls
- Focused-job follow-up plans and job-specific interview training roadmaps
- Collapsible three-line workspace sidebar with focused section views
- Submission-runner integration that requires a real employer confirmation before marking Applied
- Docker Compose deployment with PostgreSQL

Provider documentation and attribution are recorded in
[Job data sources and citations](docs/JOB_SOURCES.md).
Release history and document-control rules are recorded in
[Release notes](docs/RELEASE_NOTES.md) and [Versioning](docs/VERSIONING.md).

## Run locally

1. Copy `.env.example` to `.env`.
2. Replace `POSTGRES_PASSWORD` and `JWT_SECRET` with strong values.
3. Keep `COOKIE_SECURE=false` for local HTTP; set it to `true` behind HTTPS.
4. Optionally configure API credentials or employer board slugs.
5. Start the application:

   ```sh
   docker compose up -d --build
   ```

6. Open `http://localhost:3000`.

Keyless sources work without provider credentials. Employer ATS sources remain
disabled until their board lists are configured. Indeed and ZipRecruiter are not
enabled without approved partner/API access.

### Application automation

Configure the five `HAGENT_*` variables to enable tailored resumes and independent
quality review. In Auto mode, a passing application is handed to the optional
submission runner. The runner must return `submitted` plus a confirmation reference;
otherwise the portal records `action_required` or `needs_review` and keeps the direct
employer link visible. It never fabricates screening answers or treats an attempted
submission as successful.

### How matching works

Roles and locations are stored independently, so adding a city never creates or
duplicates a role. The ranking engine evaluates every selected role/location
combination and also considers work style, salary overlap, stated experience and
education requirements, employment type, sponsorship language, key skills,
resume overlap, and posting freshness. Missing job data is treated neutrally
rather than as a confirmed match.

## Development

```sh
npm install
npm test
npm start
```

Node.js 20 or newer and PostgreSQL 15 or newer are recommended.

For the myhai.org production host, `docker-compose.production.yml` runs only the
standalone portal service, joins the existing production database and ingress
networks, and exposes it internally as `job-portal-prod:3000`.

## License

MIT — see [LICENSE](LICENSE).
