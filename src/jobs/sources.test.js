'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBoardSources, parseTargets } = require('./sources');

test('parseTargets accepts slug and optional display name', () => {
    assert.deepEqual(parseTargets('acme|Acme Corp, second-board'), [
        { slug: 'acme', company: 'Acme Corp' },
        { slug: 'second-board', company: 'second board' },
    ]);
});
test('direct ATS adapters normalize Greenhouse, Lever, Ashby, and Workable responses', async t => {
    const originalFetch = global.fetch;
    t.after(() => { global.fetch = originalFetch; });
    const fixtures = {
        greenhouse: { jobs: [{ id: 1, title: 'Data Engineer', location: { name: 'Remote' }, content: '<p>SQL pipelines</p>', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', updated_at: '2026-09-20T00:00:00Z' }] },
        lever: [{ id: '2', text: 'Solutions Engineer', categories: { location: 'Chicago, IL', team: 'Sales Engineering' }, workplaceType: 'hybrid', descriptionPlain: 'APIs and cloud', applyUrl: 'https://jobs.lever.co/acme/2/apply', createdAt: 1789862400000 }],
        ashby: { jobs: [{ title: 'ML Engineer', location: 'New York', isListed: true, isRemote: false, workplaceType: 'OnSite', descriptionPlain: 'Models', publishedAt: '2026-09-20T00:00:00Z', jobUrl: 'https://jobs.ashbyhq.com/acme/3', applyUrl: 'https://jobs.ashbyhq.com/acme/3/application', compensation: { summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 120000, maxValue: 150000 }] } }] },
        workable: { name: 'Acme Corp', jobs: [{ shortcode: '4', title: 'Product Engineer', city: 'Austin', state: 'TX', workplace_type: 'remote', description: 'Build products', url: 'https://apply.workable.com/acme/j/4', published_on: '2026-09-20' }] },
    };
    global.fetch = async url => {
        const name = String(url).includes('greenhouse') ? 'greenhouse' : String(url).includes('lever.co') ? 'lever' : String(url).includes('ashbyhq') ? 'ashby' : 'workable';
        return { ok: true, json: async () => fixtures[name] };
    };
    const env = {
        JOB_GREENHOUSE_BOARDS: 'acme|Acme Corp', JOB_LEVER_SITES: 'acme|Acme Corp',
        JOB_ASHBY_BOARDS: 'acme|Acme Corp', JOB_WORKABLE_ACCOUNTS: 'acme|Acme Corp',
    };
    const sources = createBoardSources(env);
    const results = await Promise.all(sources.map(source => source.fetch(source.targets[0])));
    assert.deepEqual(results.map(jobs => jobs.length), [1, 1, 1, 1]);
    assert.equal(results[0][0].description, 'SQL pipelines');
    assert.equal(results[1][0].workplaceType, 'hybrid');
    assert.equal(results[2][0].salaryMin, 120000);
    assert.equal(results[3][0].company, 'Acme Corp');
});
