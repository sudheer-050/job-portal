# Job data sources and citations

The Job Portal normalizes job advertisements from the sources below. Every
result retains its provider name and original application URL in the user
interface. Operators are responsible for following each provider's current
terms, rate limits, registration requirements, and attribution rules.

## Direct employer ATS APIs

- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html) — public
  published-job `GET` endpoints; board tokens are configured by the operator.
- [Lever Postings API](https://github.com/lever/postings-api) — public published
  postings for configured Lever sites.
- [Ashby Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api)
  — published postings and optional compensation for configured job boards.
- [Workable public jobs API](https://workable.readme.io/reference/jobs-1) — public
  jobs for configured Workable accounts.

## Search and aggregator APIs

- [Adzuna Search API](https://developer.adzuna.com/docs/search)
- [USAJOBS Search API](https://developer.usajobs.gov/api-reference/get-api-search)
- [Jooble REST API](https://help.jooble.org/en/support/solutions/articles/60001448238)
- [RemoteOK API](https://remoteok.com/api)
- [Remotive Remote Jobs API](https://remotive.com/remote-jobs/api)
- [Arbeitnow Job Board API](https://www.arbeitnow.com/blog/job-board-api)
- [Jobicy Remote Jobs API](https://jobicy.com/jobs-rss-feed)
- [Himalayas Jobs API](https://himalayas.app/jobs/api)
- [The Muse API](https://www.themuse.com/developers/api/v2) and
  [API terms](https://www.themuse.com/developers/api/v2/terms)

Some providers require credentials. They remain disabled when the corresponding
environment variables are absent. See `.env.example`.

## Design reference

The provider survey and architectural review considered
[venomez-viper/Job-Search-Automation-for-Solutions-Engineer-roles](https://github.com/venomez-viper/Job-Search-Automation-for-Solutions-Engineer-roles)
as a research reference (reviewed September 2026). That repository did not
declare a software license when reviewed, so its source code, company-board
lists, personal profile, and job logs were not copied into this project. The
adapters, database model, ranking, tests, and user interface were implemented
independently under this repository's MIT license using the providers' public
interfaces and official documentation cited above.

Indeed and ZipRecruiter are intentionally not represented as active sources.
They should be enabled only through approved partner/API access and their
applicable agreements.
