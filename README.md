# Job Portal

**Product version:** 3.1.2

**Release level:** Stable

**Last reviewed:** 2026-09-29

A self-hosted job discovery application that collects postings from multiple
public job APIs and employer applicant-tracking systems, then ranks them against
each user's desired roles, location, work style, salary range, and private
resume.

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
