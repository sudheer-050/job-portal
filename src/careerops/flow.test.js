'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { alertsFromPipeline, gateOf, summarizeEvaluation, summaryFromRow } = require('./flow');
const { evaluateOffer } = require('./evaluate');
const { registerCareerOps } = require('./routes');

const RESUME = `Jordan Rivera
jordan@example.com | (312) 555-0187

SKILLS
Python, SQL, Tableau, Excel

EXPERIENCE
Data Analyst — Acme Corp, Chicago IL
2022 - Present
- Built Tableau dashboards used weekly by 40 operations managers
- Wrote SQL pipelines that cut month-end reporting from 5 days to 2
- Automated data quality checks in Python across 12 source systems

EDUCATION
B.S. Statistics, State University, 2020
`;
const GOOD_JOB = {
    id: 'greenhouse:1', title: 'Data Analyst', company: 'Northwind', location: 'Chicago, IL', source: 'greenhouse',
    description: `Requirements:\n- 3+ years of experience with SQL and Python\n- Experience building dashboards in Tableau\n- Excel experience\n${'We build reporting for operations and finance across the company every week. '.repeat(8)}`,
    salaryMin: 95000, salaryMax: 125000, workplaceType: 'hybrid', applyUrl: 'https://boards.greenhouse.io/northwind/jobs/1', postedAt: new Date().toISOString(),
};
const SCAM_JOB = { ...GOOD_JOB, id: 'x:2', title: 'Data Analyst', applyUrl: 'https://sketchy.example/apply', company: 'Hidden', description: 'Pay a processing fee and purchase your own equipment. Contact us on Telegram.' };
const profile = { experience_years: 4, salary_min: 90000, salary_max: 130000, skills: 'Python, SQL, Tableau', full_name: 'Jordan Rivera' };
const dbRow = job => ({ id: job.id, title: job.title, company: job.company, location: job.location, description: job.description, salary_min: job.salaryMin, salary_max: job.salaryMax, workplace_type: job.workplaceType, apply_url: job.applyUrl, posted_at: job.postedAt, source: job.source, metadata: {} });

test('the gate lets strong, legitimate jobs through and stops everything else', () => {
    assert.equal(gateOf({ score: 4.3, action: 'apply', tier: 'High Confidence' }).proceed, true);
    assert.equal(gateOf({ score: 3.9, action: 'reconsider', tier: 'High Confidence', verdictText: 'Below the bar.' }).reason, 'Below the bar.');
    assert.equal(gateOf({ score: 4.6, action: 'apply', tier: 'Suspicious' }).proceed, false);
    const blocked = gateOf({ score: 4.6, action: 'apply', tier: 'High Confidence', blockers: ['Pay is below your minimum.'] });
    assert.deepEqual([blocked.proceed, blocked.reason], [false, 'Pay is below your minimum.']);
    assert.equal(gateOf({ score: 4.0, action: 'skip', tier: 'High Confidence' }).proceed, false);
});

test('a summary carries what the UI needs and nothing sensitive', () => {
    const evaluation = evaluateOffer({ job: GOOD_JOB, profile, roles: ['Data Analyst'], resumeText: RESUME });
    const summary = summarizeEvaluation(GOOD_JOB.id, evaluation);
    assert.deepEqual(Object.keys(summary).sort(), ['action', 'archetype', 'blockers', 'coverage', 'gate', 'jobId', 'missing', 'scannedAt', 'score', 'tier', 'verdict'].sort());
    assert.equal(summary.jobId, GOOD_JOB.id);
    assert.ok(summary.score >= 4 && summary.gate.proceed, `score ${summary.score}`);
    assert.ok(!JSON.stringify(summary).includes('Jordan'), 'no resume text or personal data in the summary');
    const scam = summarizeEvaluation(SCAM_JOB.id, evaluateOffer({ job: SCAM_JOB, profile, roles: ['Data Analyst'], resumeText: RESUME }));
    assert.equal(scam.gate.proceed, false);
    assert.equal(scam.tier, 'Suspicious');
});

test('a cached row rebuilds the same gate decision', () => {
    const evaluation = evaluateOffer({ job: SCAM_JOB, profile, roles: ['Data Analyst'], resumeText: RESUME });
    const row = { jobId: SCAM_JOB.id, score: evaluation.score, verdict: evaluation.verdict.label, tier: evaluation.meta.legitimacyTier, coverage: evaluation.meta.coverage, archetype: evaluation.meta.archetype, missing: ['dbt'], result: { verdict: evaluation.verdict, blockers: evaluation.blockers }, updatedAt: new Date() };
    const summary = summaryFromRow(row);
    assert.equal(summary.gate.proceed, false);
    assert.deepEqual(summary.missing, ['dbt']);
});

test('only due and overdue follow-ups become alerts', () => {
    const base = { jobId: 'a', title: 'Analyst', company: 'Northwind' };
    const alerts = alertsFromPipeline([
        { ...base, next: { urgency: 'overdue', reason: 'No reply after a week.' } },
        { ...base, jobId: 'b', title: 'Engineer', company: null, next: { urgency: 'due', reason: 'Second and final follow-up.' } },
        { ...base, jobId: 'c', next: { urgency: 'upcoming', reason: 'later' } },
        { ...base, jobId: 'd', next: { urgency: 'cold', reason: 'closed' } },
        { ...base, jobId: 'e', next: null },
    ]);
    assert.deepEqual(alerts.map(a => a.jobId), ['a', 'b']);
    assert.equal(alerts[0].title, 'Follow up: Analyst at Northwind');
    assert.equal(alerts[1].title, 'Follow up: Engineer');
    assert.ok(alerts.every(a => a.kind === 'follow_up_due' && a.link === '/jobs#careerops'));
});

// ---- Routes, with a stand-in database ----
function fakePool({ resume = RESUME, jobs = [GOOD_JOB, SCAM_JOB], pipeline = [] } = {}) {
    const calls = [];
    return {
        calls,
        query: async (sql, params) => {
            calls.push({ sql: String(sql), params });
            const s = String(sql);
            if (s.includes('FROM job_profiles')) return { rows: [{ experience_years: 4, salary_min: 90000, salary_max: 130000, skills: 'Python, SQL, Tableau', full_name: 'Jordan Rivera', work_style: 'any' }] };
            if (s.includes('FROM job_roles')) return { rows: [{ role: 'Data Analyst' }] };
            if (s.includes('FROM resumes')) return { rows: resume ? [{ resume_text: resume }] : [] };
            if (s.includes('FROM job_postings')) return { rows: jobs.filter(j => (params[0] || []).includes(j.id)).map(dbRow) };
            if (s.includes('WITH ids AS')) return { rows: pipeline };
            if (s.includes('INSERT INTO job_notifications')) return { rows: [], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        },
    };
}

async function startApp(pool) {
    const app = express();
    app.use(express.json());
    const requireAuth = (req, _res, next) => { req.jobUsername = 'jordan'; next(); };
    const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
    const api = registerCareerOps(app, { pool, requireAuth, asyncRoute, ready: Promise.resolve(), env: {} });
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { api, base, post, close: () => new Promise(resolve => server.close(resolve)) };
}

test('POST /scan evaluates the ranked jobs against the resume, stores each result, and sorts best first', async () => {
    const pool = fakePool();
    const app = await startApp(pool);
    try {
        const res = await app.post('/api/jobs/careerops/scan', { jobIds: ['x:2', 'greenhouse:1', 'greenhouse:1', 'missing:9'] });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.resumeMissing, false);
        assert.equal(body.requested, 3, 'duplicate ids collapse');
        assert.equal(body.scanned, 2, 'unknown jobs are skipped');
        assert.deepEqual(body.results.map(r => r.jobId), ['greenhouse:1', 'x:2']);
        assert.equal(body.results[0].gate.proceed, true);
        assert.equal(body.results[1].gate.proceed, false);
        assert.equal(pool.calls.filter(c => c.sql.includes('INSERT INTO job_evaluations')).length, 2);
    } finally { await app.close(); }
});

test('POST /scan without a resume asks for one instead of scoring against nothing', async () => {
    const pool = fakePool({ resume: '' });
    const app = await startApp(pool);
    try {
        const body = await (await app.post('/api/jobs/careerops/scan', { jobIds: ['greenhouse:1'] })).json();
        assert.equal(body.resumeMissing, true);
        assert.deepEqual(body.results, []);
        assert.equal(pool.calls.filter(c => c.sql.includes('INSERT INTO job_evaluations')).length, 0);
    } finally { await app.close(); }
});

test('POST /scan validates input and caps the batch at 100', async () => {
    const pool = fakePool();
    const app = await startApp(pool);
    try {
        assert.equal((await app.post('/api/jobs/careerops/scan', {})).status, 400);
        assert.equal((await app.post('/api/jobs/careerops/scan', { jobIds: [] })).status, 400);
        assert.equal((await app.post('/api/jobs/careerops/scan', { jobIds: ['x'.repeat(201)] })).status, 400);
        await app.post('/api/jobs/careerops/scan', { jobIds: Array.from({ length: 150 }, (_, i) => `j:${i}`) });
        const lookup = pool.calls.find(c => c.sql.includes('FROM job_postings'));
        assert.equal(lookup.params[0].length, 100);
    } finally { await app.close(); }
});

test('evaluateJobForUser stores an evaluation when an application starts, and does nothing without a resume', async () => {
    const withResume = fakePool();
    const a = await startApp(withResume);
    try {
        const summary = await a.api.evaluateJobForUser('jordan', 'greenhouse:1');
        assert.equal(summary.jobId, 'greenhouse:1');
        assert.equal(withResume.calls.filter(c => c.sql.includes('INSERT INTO job_evaluations')).length, 1);
    } finally { await a.close(); }
    const noResume = fakePool({ resume: '' });
    const b = await startApp(noResume);
    try {
        assert.equal(await b.api.evaluateJobForUser('jordan', 'greenhouse:1'), null);
        assert.equal(noResume.calls.filter(c => c.sql.includes('INSERT INTO job_evaluations')).length, 0);
    } finally { await b.close(); }
});

test('syncAlerts raises one Action Center alert per due follow-up, and is throttled per user', async () => {
    const DAY = 86400000;
    const pipeline = [
        { jobId: 'greenhouse:1', title: 'Data Analyst', company: 'Northwind', applicationStatus: 'applied', createdAt: new Date(Date.now() - 12 * DAY), appliedAt: new Date(Date.now() - 9 * DAY), updatedAt: new Date(), followUps: null },
        { jobId: 'x:2', title: 'Fresh application', company: 'Acme', applicationStatus: 'applied', createdAt: new Date(), appliedAt: new Date(), updatedAt: new Date(), followUps: null },
        { jobId: 'y:3', title: 'Only evaluated', company: 'Beta', applicationStatus: null, createdAt: null, appliedAt: null, updatedAt: null, followUps: null },
    ];
    const pool = fakePool({ pipeline });
    const app = await startApp(pool);
    try {
        assert.equal(await app.api.syncAlerts('jordan', { force: true }), 1);
        const insert = pool.calls.find(c => c.sql.includes('INSERT INTO job_notifications'));
        assert.deepEqual(insert.params.slice(0, 3), ['jordan', 'follow_up_due', 'Follow up: Data Analyst at Northwind']);
        assert.match(insert.sql, /NOT EXISTS/, 'duplicate alerts are suppressed in SQL');
        const before = pool.calls.length;
        assert.equal(await app.api.syncAlerts('jordan'), 0, 'second call inside the interval does nothing');
        assert.equal(pool.calls.length, before, 'and does not even query the database');
    } finally { await app.close(); }
});
