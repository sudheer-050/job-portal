'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const multer = require('multer');
const { registerProfileSources } = require('./routes');

const silent = { log() {}, warn() {}, error() {} };
const publicLookup = async () => [{ address: '93.184.216.34' }];
const repo = (name, extra = {}) => ({ name, owner: { login: 'octocat' }, fork: false, private: false, description: `${name} does things`, language: 'Python', html_url: `https://github.com/octocat/${name}`, stargazers_count: 1, pushed_at: '2026-10-01T00:00:00Z', topics: [], ...extra });
const reposResponse = list => async () => new Response(JSON.stringify(list), { status: 200 });

// A small in-memory stand-in for the tables these routes use.
function fakeDb({ resume = 'Jordan Rivera\n\nEXPERIENCE\nData Analyst — Acme Corp\n2022 - Present\n- Built dashboards\n', skills = 'Python', portfolioUrl = null, sources = null } = {}) {
    const st = { resume: resume === null ? null : { resume_text: resume, version: 1 }, skills, portfolioUrl, sources, findings: [], notifications: [], calls: [], nextId: 1 };
    const query = async (sql, params = []) => {
        const s = String(sql);
        st.calls.push({ s, params });
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
        if (s.includes('FROM job_profile_sources')) return { rows: st.sources ? [st.sources] : [] };
        if (s.includes('INSERT INTO job_profile_sources') && s.includes('last_checked_at')) { st.sources = { ...(st.sources || {}), last_checked_at: new Date(), last_result: JSON.parse(params[1]) }; return { rows: [] }; }
        if (s.includes('INSERT INTO job_profile_sources')) { st.sources = { ...(st.sources || {}), github_user: params[1], auto_check: params[2] }; return { rows: [] }; }
        if (s.includes('FROM job_profiles') && s.includes('linkedin_url')) return { rows: [{ linkedin_url: null, portfolio_url: st.portfolioUrl }] };
        if (s.includes('GROUP BY status')) { const tally = {}; st.findings.forEach(f => { tally[f.status] = (tally[f.status] || 0) + 1; }); return { rows: Object.entries(tally).map(([status, n]) => ({ status, n })) }; }
        if (s.includes('INSERT INTO job_source_findings')) {
            if (st.findings.some(f => f.fingerprint === params[3])) return { rows: [], rowCount: 0 };
            st.findings.push({ id: st.nextId++, source: params[1], kind: params[2], fingerprint: params[3], title: params[4], summary: params[5], url: params[6], meta: JSON.parse(params[7]), status: 'new' });
            return { rows: [], rowCount: 1 };
        }
        if (s.includes('FROM job_source_findings') && s.includes('FOR UPDATE')) return { rows: st.findings.filter(f => f.status === 'new' && params[1].includes(f.id)) };
        if (s.includes('FROM job_source_findings')) return { rows: st.findings.filter(f => f.status === 'new') };
        if (s.includes('FROM resumes')) return { rows: st.resume ? [st.resume] : [] };
        if (s.includes('UPDATE resumes')) { st.resume = { resume_text: params[1], version: st.resume.version + 1 }; return { rows: [{ version: st.resume.version }] }; }
        if (s.includes('INSERT INTO job_profiles')) return { rows: [], rowCount: 1 };
        if (s.includes('SELECT skills FROM job_profiles')) return { rows: [{ skills: st.skills }] };
        if (s.includes('UPDATE job_profiles SET skills')) { st.skills = params[1]; return { rows: [] }; }
        if (s.includes("SET status='accepted'")) { st.findings.forEach(f => { if (params[1].includes(f.id)) f.status = 'accepted'; }); return { rows: [] }; }
        if (s.includes("SET status='dismissed'")) { let n = 0; st.findings.forEach(f => { if (f.status === 'new' && params[1].includes(f.id)) { f.status = 'dismissed'; n += 1; } }); return { rows: [], rowCount: n }; }
        if (s.includes('INSERT INTO job_notifications')) { st.notifications.push(params); return { rows: [], rowCount: 1 }; }
        return { rows: [], rowCount: 0 };
    };
    return { st, query, connect: async () => ({ query, release() {} }) };
}

async function start(db, opts = {}) {
    const app = express();
    app.use(express.json());
    const requireAuth = (req, _res, next) => { req.jobUsername = 'jordan'; next(); };
    const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
    const api = registerProfileSources(app, { pool: db, requireAuth, asyncRoute, ready: Promise.resolve(), lookup: publicLookup, logger: silent, ...opts });
    app.use((error, _req, res, _next) => res.status(error instanceof multer.MulterError ? 400 : 500).json({ error: error.message }));
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/jobs/profile-sources`;
    const json = (path, method, body) => fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { api, base, json, close: () => new Promise(resolve => server.close(resolve)) };
}

test('settings: GitHub is validated and saved, and the profile links are reported', async () => {
    const db = fakeDb({ portfolioUrl: 'https://jordan.dev' });
    const app = await start(db);
    try {
        assert.equal((await app.json('', 'PUT', { github: 'not valid!' })).status, 400);
        assert.equal((await app.json('', 'PUT', { github: 'https://github.com/octocat/hello' })).status, 200);
        const body = await (await app.json('', 'GET')).json();
        assert.equal(body.settings.githubUser, 'octocat');
        assert.equal(body.settings.portfolioUrl, 'https://jordan.dev');
        assert.equal(body.settings.autoCheck, true);
        assert.deepEqual(body.counts, { new: 0, accepted: 0, dismissed: 0 });
    } finally { await app.close(); }
});

test('checking with nothing configured explains what to add', async () => {
    const app = await start(fakeDb());
    try {
        const res = await app.json('/check', 'POST');
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /GitHub username or your portfolio/);
    } finally { await app.close(); }
});

test('a check stores new findings from GitHub and the portfolio once, and never again', async () => {
    const db = fakeDb({ portfolioUrl: 'https://jordan.dev', sources: { github_user: 'octocat', auto_check: true } });
    const page = '<h2>Projects</h2><h3>Churn Dashboard</h3><p>A Tableau dashboard for the operations team.</p>';
    const fetchImpl = async url => String(url).startsWith('https://api.github.com') ? reposResponse([repo('alpha'), repo('beta')])() : new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
    const app = await start(db, { fetchImpl });
    try {
        const first = await (await app.json('/check', 'POST')).json();
        assert.equal(first.result.github.ok, true);
        assert.equal(first.result.github.added, 3, 'two projects and the Python skill');
        assert.equal(first.result.portfolio.added, 1);
        assert.equal(first.counts.new, 4);
        const second = await (await app.json('/check', 'POST')).json();
        assert.deepEqual([second.result.github.added, second.result.portfolio.added], [0, 0], 'nothing is duplicated');
        const list = await (await app.json('/findings', 'GET')).json();
        assert.equal(list.findings.length, 4);
    } finally { await app.close(); }
});

test('a source that fails is reported without breaking the others', async () => {
    const db = fakeDb({ portfolioUrl: 'https://jordan.dev', sources: { github_user: 'nobody', auto_check: true } });
    const fetchImpl = async url => String(url).startsWith('https://api.github.com') ? new Response('[]', { status: 404 }) : new Response('<h2>Projects</h2><h3>Thing</h3><p>It does a useful thing for people.</p>', { status: 200, headers: { 'content-type': 'text/html' } });
    const app = await start(db, { fetchImpl });
    try {
        const { result } = await (await app.json('/check', 'POST')).json();
        assert.equal(result.github.ok, false);
        assert.match(result.github.error, /not found/i);
        assert.equal(result.portfolio.ok, true);
        assert.equal(result.portfolio.added, 1);
    } finally { await app.close(); }
});

async function upload(app, files) {
    const form = new FormData();
    for (const [name, content] of files) form.append('files', new Blob([content], { type: 'text/csv' }), name);
    return fetch(`${app.base}/linkedin`, { method: 'POST', body: form });
}

test('LinkedIn export files are imported, and bad files are reported without losing good ones', async () => {
    const app = await start(fakeDb());
    try {
        const res = await upload(app, [
            ['Positions.csv', 'Company Name,Title,Description,Location,Started On,Finished On\nAcme Corp,Data Analyst,Built dashboards for managers.,Chicago,Jan 2022,\n'],
            ['Skills.csv', 'Name\nSQL\nTableau\n'],
            ['Connections.csv', 'First Name,Last Name\nA,B\n'],
            ['notes.txt', 'hello'],
        ]);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.added, 3);
        const byName = Object.fromEntries(body.files.map(f => [f.name, f]));
        assert.equal(byName['Positions.csv'].added, 1);
        assert.equal(byName['Skills.csv'].added, 2);
        assert.match(byName['Connections.csv'].error, /not a file I can read|Positions\.csv/);
        assert.match(byName['notes.txt'].error, /\.csv/);
        assert.equal((await upload(app, [])).status, 400);
        const again = await (await upload(app, [['Skills.csv', 'Name\nSQL\n']])).json();
        assert.equal(again.added, 0, 're-importing the same export adds nothing');
    } finally { await app.close(); }
});

test('oversized uploads are refused', async () => {
    const app = await start(fakeDb());
    try {
        const res = await upload(app, [['Positions.csv', 'x'.repeat(1024 * 1024 + 10)]]);
        assert.equal(res.status, 400);
    } finally { await app.close(); }
});

async function seeded(opts) {
    const db = fakeDb(opts);
    const app = await start(db, { fetchImpl: reposResponse([repo('alpha', { description: 'First tool' }), repo('beta')]) });
    db.st.sources = { github_user: 'octocat', auto_check: true };
    await app.json('/check', 'POST');
    return { db, app, ids: Object.fromEntries(db.st.findings.map(f => [`${f.kind}:${f.title}`, f.id])) };
}

test('nothing reaches the resume or skills until the user approves it', async () => {
    const { db, app } = await seeded();
    try {
        assert.equal(db.st.resume.version, 1);
        assert.equal(db.st.skills, 'Python');
        assert.ok(!db.st.resume.resume_text.includes('alpha'));
    } finally { await app.close(); }
});

test('approving a project and a skill updates the resume (new version) and the skills list, in one step', async () => {
    const { db, app, ids } = await seeded({ skills: 'SQL' });
    try {
        const res = await app.json('/decide', 'POST', { accept: [ids['project:alpha'], ids['skill:Python']] });
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.accepted, 2);
        assert.equal(body.resumeVersion, 2);
        assert.deepEqual(body.skillsAdded, ['Python']);
        assert.match(db.st.resume.resume_text, /PROJECTS\n- alpha: First tool \(Python\) https:\/\/github\.com\/octocat\/alpha/);
        assert.equal(db.st.skills, 'SQL, Python');
        assert.deepEqual(db.st.findings.map(f => f.status).sort(), ['accepted', 'accepted', 'new']);
        assert.deepEqual(body.counts, { new: 1, accepted: 2, dismissed: 0 }, 'beta is still waiting for a decision');
        const again = await (await app.json('/decide', 'POST', { accept: [ids['project:alpha']] })).json();
        assert.equal(again.accepted, 0, 'an item can only be applied once');
        assert.equal(db.st.resume.version, 2);
    } finally { await app.close(); }
});

test('dismissed items are remembered and never come back', async () => {
    const { db, app, ids } = await seeded();
    try {
        const body = await (await app.json('/decide', 'POST', { dismiss: [ids['project:alpha']] })).json();
        assert.equal(body.dismissed, 1);
        assert.equal(db.st.resume.version, 1, 'dismissing never touches the resume');
        const recheck = await (await app.json('/check', 'POST')).json();
        assert.equal(recheck.result.github.added, 0);
        assert.equal((await (await app.json('/findings', 'GET')).json()).findings.some(f => f.title === 'alpha'), false);
    } finally { await app.close(); }
});

test('accepting a project without a resume is refused and changes nothing', async () => {
    const { db, app, ids } = await seeded({ resume: null });
    try {
        const res = await app.json('/decide', 'POST', { accept: [ids['project:alpha']] });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /Upload your resume first/);
        assert.ok(db.st.findings.every(f => f.status === 'new'));
        assert.ok(db.st.calls.some(c => /^\s*ROLLBACK/.test(c.s)));
    } finally { await app.close(); }
});

test('decide validates its input', async () => {
    const { app } = await seeded();
    try {
        assert.equal((await app.json('/decide', 'POST', {})).status, 400);
        assert.equal((await app.json('/decide', 'POST', { accept: ['x', -1, 1.5, null] })).status, 400);
    } finally { await app.close(); }
});

test('the weekly auto-check runs only when due, is throttled, and raises one quiet notification', async () => {
    const db = fakeDb({ sources: { github_user: 'octocat', auto_check: true, last_checked_at: new Date(Date.now() - 8 * 86400000) } });
    const app = await start(db, { fetchImpl: reposResponse([repo('alpha'), repo('beta')]) });
    try {
        const result = await app.api.maybeAutoCheck('jordan');
        assert.equal(result.github.added, 3);
        assert.equal(db.st.notifications.length, 1);
        assert.match(db.st.notifications[0][1], /3 new items found on your profiles/);
        assert.equal(await app.api.maybeAutoCheck('jordan'), null, 'throttled for an hour');
    } finally { await app.close(); }
    const recent = fakeDb({ sources: { github_user: 'octocat', auto_check: true, last_checked_at: new Date() } });
    const a = await start(recent, { fetchImpl: async () => { throw new Error('must not fetch'); } });
    try { assert.equal(await a.api.maybeAutoCheck('jordan'), null, 'not due yet'); } finally { await a.close(); }
    const off = fakeDb({ sources: { github_user: 'octocat', auto_check: false, last_checked_at: null } });
    const b = await start(off, { fetchImpl: async () => { throw new Error('must not fetch'); } });
    try { assert.equal(await b.api.maybeAutoCheck('jordan'), null, 'switched off by the user'); } finally { await b.close(); }
});
