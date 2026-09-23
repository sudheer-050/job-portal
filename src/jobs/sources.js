'use strict';

const { normalizeJob, parseAnnualSalary, tokens } = require('./core');

const USER_AGENT = 'JobPortal/1.0';

async function fetchJson(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(options.headers || {}) },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

function wordsMatch(role, ...values) {
    const wanted = [...tokens(role)];
    if (!wanted.length) return true;
    const haystack = `${values.filter(Boolean).join(' ')}`.toLowerCase();
    return wanted.some(word => haystack.includes(word));
}

function validJobs(items) {
    return items.map(normalizeJob).filter(Boolean);
}

function parseTargets(value) {
    return String(value || '').split(/[\n,]+/).map(entry => entry.trim()).filter(Boolean).map(entry => {
        const [slug, ...companyParts] = entry.split('|').map(part => part.trim());
        return { slug, company: companyParts.join('|') || slug.replace(/[-_]/g, ' ') };
    }).filter(target => /^[a-z0-9._-]+$/i.test(target.slug));
}

function createSearchSources(env = process.env) {
    return [
        {
            name: 'adzuna', enabled: Boolean(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY),
            fetch: async (role, location) => {
                const params = new URLSearchParams({ app_id: env.ADZUNA_APP_ID, app_key: env.ADZUNA_APP_KEY, results_per_page: '30', what: role });
                if (location && !/^(remote|any|hybrid|on-?site)$/i.test(location)) params.set('where', location);
                const data = await fetchJson(`https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`);
                return validJobs((data.results || []).map(j => ({ source: 'adzuna', sourceId: j.id, title: j.title, company: j.company?.display_name, location: j.location?.display_name, salaryMin: j.salary_min, salaryMax: j.salary_max, description: j.description, applyUrl: j.redirect_url, postedAt: j.created })));
            },
        },
        {
            name: 'remoteok', enabled: true,
            fetch: async role => {
                const data = await fetchJson('https://remoteok.com/api');
                return validJobs((Array.isArray(data) ? data : []).filter(j => j?.id && wordsMatch(role, j.position, ...(j.tags || []))).slice(0, 40).map(j => ({ source: 'remoteok', sourceId: j.id, title: j.position, company: j.company, location: j.location || 'Remote', salaryMin: j.salary_min, salaryMax: j.salary_max, remote: true, description: j.description, applyUrl: j.url || j.apply_url, postedAt: j.date })));
            },
        },
        {
            name: 'remotive', enabled: true,
            fetch: async role => {
                const data = await fetchJson(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(role)}&limit=40`);
                return validJobs((data.jobs || []).map(j => ({ source: 'remotive', sourceId: j.id, title: j.title, company: j.company_name, location: j.candidate_required_location || 'Remote', remote: true, description: j.description, applyUrl: j.url, postedAt: j.publication_date })));
            },
        },
        {
            name: 'arbeitnow', enabled: true,
            fetch: async role => {
                const data = await fetchJson('https://www.arbeitnow.com/api/job-board-api');
                return validJobs((data.data || []).filter(j => wordsMatch(role, j.title, ...(j.tags || []))).slice(0, 40).map(j => ({ source: 'arbeitnow', sourceId: j.slug, title: j.title, company: j.company_name, location: j.location, remote: Boolean(j.remote), description: j.description, applyUrl: j.url, postedAt: j.created_at ? new Date(j.created_at * 1000) : null })));
            },
        },
        {
            name: 'jobicy', enabled: true,
            fetch: async role => {
                const data = await fetchJson(`https://jobicy.com/api/v2/remote-jobs?count=40&tag=${encodeURIComponent(role)}`);
                return validJobs((data.jobs || []).map(j => ({ source: 'jobicy', sourceId: j.id, title: j.jobTitle, company: j.companyName, location: j.jobGeo || 'Remote', remote: true, description: j.jobExcerpt, applyUrl: j.url, postedAt: j.pubDate })));
            },
        },
        {
            name: 'himalayas', enabled: true,
            fetch: async role => {
                const data = await fetchJson('https://himalayas.app/jobs/api?limit=100');
                return validJobs((data.jobs || []).filter(j => wordsMatch(role, j.title, ...(j.categories || []))).slice(0, 40).map(j => ({ source: 'himalayas', sourceId: j.guid || j.applicationLink, title: j.title, company: j.companyName, location: (j.locationRestrictions || []).join(', ') || 'Remote', salaryMin: j.minSalary, salaryMax: j.maxSalary, remote: true, description: j.description, applyUrl: j.applicationLink, postedAt: j.pubDate })));
            },
        },
        {
            name: 'themuse', enabled: true,
            fetch: async role => {
                const data = await fetchJson('https://www.themuse.com/api/public/jobs?page=1');
                return validJobs((data.results || []).filter(j => wordsMatch(role, j.name, ...(j.categories || []).map(c => c.name))).slice(0, 40).map(j => ({ source: 'themuse', sourceId: j.id, title: j.name, company: j.company?.name, location: (j.locations || []).map(l => l.name).join('; '), remote: (j.locations || []).some(l => /remote|flexible/i.test(l.name || '')), description: j.contents, applyUrl: j.refs?.landing_page, postedAt: j.publication_date })));
            },
        },
        {
            name: 'usajobs', enabled: Boolean(env.USAJOBS_API_KEY && env.USAJOBS_USER_AGENT),
            fetch: async (role, location) => {
                const params = new URLSearchParams({ Keyword: role, ResultsPerPage: '30' });
                if (location && !/^(remote|any|hybrid|on-?site)$/i.test(location)) params.set('LocationName', location);
                const data = await fetchJson(`https://data.usajobs.gov/api/search?${params}`, { headers: { Host: 'data.usajobs.gov', 'User-Agent': env.USAJOBS_USER_AGENT, 'Authorization-Key': env.USAJOBS_API_KEY } });
                return validJobs((data.SearchResult?.SearchResultItems || []).map(item => {
                    const j = item.MatchedObjectDescriptor || {}; const pay = (j.PositionRemuneration || [])[0] || {};
                    return { source: 'usajobs', sourceId: j.PositionID || item.MatchedObjectId, title: j.PositionTitle, company: j.OrganizationName, location: j.PositionLocationDisplay, salaryMin: pay.MinimumRange, salaryMax: pay.MaximumRange, description: j.UserArea?.Details?.JobSummary, applyUrl: j.PositionURI, postedAt: j.PublicationStartDate };
                }));
            },
        },
        {
            name: 'jooble', enabled: Boolean(env.JOOBLE_API_KEY),
            fetch: async (role, location) => {
                const data = await fetchJson(`https://jooble.org/api/${env.JOOBLE_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keywords: role, location: location || '' }) });
                return validJobs((data.jobs || []).slice(0, 40).map(j => ({ source: 'jooble', sourceId: j.id || j.link, title: j.title, company: j.company, location: j.location, description: j.snippet, applyUrl: j.link, postedAt: j.updated })));
            },
        },
    ];
}

function createBoardSources(env = process.env) {
    return [
        {
            name: 'greenhouse', targets: parseTargets(env.JOB_GREENHOUSE_BOARDS),
            fetch: async target => {
                const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.slug)}/jobs?content=true`);
                return validJobs((data.jobs || []).map(j => ({ source: 'greenhouse', sourceId: `${target.slug}:${j.id}`, title: j.title, company: target.company, location: j.location?.name, description: j.content, applyUrl: j.absolute_url, postedAt: j.updated_at, metadata: { board: target.slug, departments: (j.departments || []).map(d => d.name) } })));
            },
        },
        {
            name: 'lever', targets: parseTargets(env.JOB_LEVER_SITES),
            fetch: async target => {
                const data = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(target.slug)}?mode=json&limit=500`);
                return validJobs((Array.isArray(data) ? data : []).map(j => ({ source: 'lever', sourceId: `${target.slug}:${j.id}`, title: j.text, company: target.company, location: j.categories?.location || (j.categories?.allLocations || []).join(', '), workplaceType: j.workplaceType, description: j.descriptionPlain || j.description, applyUrl: j.applyUrl || j.hostedUrl, postedAt: j.createdAt ? new Date(j.createdAt) : null, metadata: { board: target.slug, team: j.categories?.team, commitment: j.categories?.commitment } })));
            },
        },
        {
            name: 'ashby', targets: parseTargets(env.JOB_ASHBY_BOARDS),
            fetch: async target => {
                const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(target.slug)}?includeCompensation=true`);
                return validJobs((data.jobs || []).filter(j => j.isListed !== false).map(j => {
                    const salary = parseAnnualSalary(j.compensation);
                    return { source: 'ashby', sourceId: `${target.slug}:${j.jobUrl || j.applyUrl}`, title: j.title, company: target.company, location: [j.location, ...(j.secondaryLocations || []).map(l => l.location)].filter(Boolean).join('; '), workplaceType: j.workplaceType, remote: j.isRemote, salaryMin: salary.min, salaryMax: salary.max, description: j.descriptionPlain || j.descriptionHtml, applyUrl: j.applyUrl || j.jobUrl, postedAt: j.publishedAt, metadata: { board: target.slug, department: j.department, team: j.team, employmentType: j.employmentType } };
                }));
            },
        },
        {
            name: 'workable', targets: parseTargets(env.JOB_WORKABLE_ACCOUNTS),
            fetch: async target => {
                const data = await fetchJson(`https://www.workable.com/api/accounts/${encodeURIComponent(target.slug)}?details=true`);
                return validJobs((data.jobs || []).map(j => ({ source: 'workable', sourceId: `${target.slug}:${j.shortcode || j.code}`, title: j.title, company: target.company || data.name, location: [j.city, j.state, j.country].filter(Boolean).join(', '), workplaceType: j.workplace_type, remote: j.telecommuting, description: j.description, applyUrl: j.url || j.application_url || j.shortlink, postedAt: j.published_on || j.created_at, metadata: { board: target.slug, department: j.department, employmentType: j.employment_type } })));
            },
        },
    ];
}

module.exports = { createBoardSources, createSearchSources, fetchJson, parseTargets };
