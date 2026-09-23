# Job Portal

A self-hosted job discovery application that collects postings from multiple
public job APIs and employer applicant-tracking systems, then ranks them against
each user's desired roles, location, work style, salary range, and private
resume.

## Features

- Separate user accounts and private PDF/text résumé storage
- Multiple tracked roles with location, remote/hybrid/on-site, and salary filters
- Shared scheduled ingestion instead of repeating provider calls per user
- Direct Greenhouse, Lever, Ashby, and Workable employer-board adapters
- RemoteOK, Remotive, Arbeitnow, Jobicy, Himalayas, The Muse, Adzuna, USAJOBS,
  and Jooble adapters
- Normalization, cross-source deduplication, freshness tracking, and closed-job handling
- Explainable match scores and original provider/application links
- Docker Compose deployment with PostgreSQL

Provider documentation and attribution are recorded in
[Job data sources and citations](docs/JOB_SOURCES.md).

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

## Development

```sh
npm install
npm test
npm start
```

Node.js 20 or newer and PostgreSQL 15 or newer are recommended.

## License

MIT — see [LICENSE](LICENSE).
