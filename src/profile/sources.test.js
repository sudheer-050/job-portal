'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./sources');
const { parseResume, tailorResume } = require('../careerops/resume');

const repo = (name, extra = {}) => ({ name, owner: { login: 'octocat' }, fork: false, private: false, description: `${name} description`, language: 'Python', html_url: `https://github.com/octocat/${name}`, stargazers_count: 3, pushed_at: '2026-10-01T00:00:00Z', topics: [], archived: false, ...extra });

test('GitHub usernames and profile links are validated', () => {
    for (const ok of ['octocat', '@octocat', 'github.com/octocat', 'https://github.com/octocat', 'https://www.github.com/octocat/repo?tab=x', 'a', 'a-b-c']) assert.equal(S.githubUsername(ok) !== null, true, ok);
    assert.equal(S.githubUsername('https://github.com/octocat/hello'), 'octocat');
    for (const bad of ['', '  ', 'a--b', '-a', 'a-', 'has space', 'x'.repeat(40), 'octo/cat', 'https://evil.example/octocat', 'javascript:alert(1)']) assert.equal(S.githubUsername(bad), null, bad);
});

test('only the user\'s own, public, non-fork repositories become projects', () => {
    const findings = S.parseGithubRepos([
        repo('mine-a'), repo('mine-b', { language: 'Python' }),
        repo('a-fork', { fork: true }), repo('someone-elses', { owner: { login: 'torvalds' } }),
        repo('secret', { private: true }), repo('octocat', { description: 'profile readme' }),
    ], 'octocat');
    const projects = findings.filter(f => f.kind === 'project').map(f => f.title).sort();
    assert.deepEqual(projects, ['mine-a', 'mine-b']);
});

test('projects are newest first, capped, and carry safe metadata', () => {
    const repos = Array.from({ length: 40 }, (_, i) => repo(`r${i}`, { pushed_at: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`, description: `d${i}\n\nwith\tcontrol chars` }));
    const projects = S.parseGithubRepos(repos, 'octocat').filter(f => f.kind === 'project');
    assert.equal(projects.length, 30);
    assert.ok(projects.every(f => !/[\n\t]/.test(f.summary)), 'control characters are removed');
    assert.ok(projects.every(f => f.url.startsWith('https://github.com/octocat/')));
    const dates = projects.map(f => f.meta.pushedAt);
    assert.deepEqual(dates, [...dates].sort().reverse());
});

test('a language used in two or more repositories becomes a skill suggestion, a one-off does not', () => {
    const findings = S.parseGithubRepos([repo('a', { language: 'Go' }), repo('b', { language: 'Go' }), repo('c', { language: 'Rust' })], 'octocat');
    const skills = findings.filter(f => f.kind === 'skill');
    assert.deepEqual(skills.map(f => f.title), ['Go']);
    assert.match(skills[0].summary, /2 of your public repositories/);
});

test('findings have stable, distinct fingerprints so reruns never duplicate', () => {
    const a = S.parseGithubRepos([repo('alpha'), repo('beta')], 'octocat');
    const b = S.parseGithubRepos([repo('alpha'), repo('beta')], 'octocat');
    assert.deepEqual(a.map(f => f.fingerprint), b.map(f => f.fingerprint));
    assert.equal(new Set(a.map(f => f.fingerprint)).size, a.length, 'every finding (2 projects + the Python skill) is distinct');
    assert.equal(a.filter(f => f.kind === 'project').length, 2);
    assert.notEqual(S.fingerprint('github', 'project', 'x'), S.fingerprint('linkedin', 'project', 'x'));
});

test('the GitHub fetcher explains missing users and rate limits', async () => {
    const reply = (status, body = []) => async () => new Response(JSON.stringify(body), { status });
    await assert.rejects(S.fetchGithub('nobody', { fetchImpl: reply(404) }), /not found/i);
    await assert.rejects(S.fetchGithub('octocat', { fetchImpl: reply(403) }), /limiting requests/i);
    await assert.rejects(S.fetchGithub('octocat', { fetchImpl: reply(500) }), /500/);
    let requested;
    const found = await S.fetchGithub('octocat', { fetchImpl: async (url, init) => { requested = { url, init }; return new Response(JSON.stringify([repo('x')]), { status: 200 }); } });
    assert.equal(found.length, 1);
    assert.match(requested.url, /^https:\/\/api\.github\.com\/users\/octocat\/repos/);
    assert.ok(!requested.init.headers.Authorization, 'no credentials unless a token is configured');
});

const PORTFOLIO = `<!doctype html><html><head><title>Jordan</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Route Planner","description":"Plans delivery routes","url":"https://jordan.dev/route"}</script>
<script>var secret = "<h3>Fake Project In A Script</h3>";</script></head><body>
<h1>Jordan Rivera</h1><p>Data analyst.</p>
<h2>Projects</h2>
<h3>Churn Dashboard</h3><p>A Tableau dashboard that cut reporting time &amp; surfaced churn risk for the ops team.</p>
<h3>Forecast Pipeline</h3><p>Python and SQL pipeline for weekly demand forecasts across 12 sources.</p>
<h2>Experience</h2>
<ul><li>Data Analyst — Acme Corp: built dashboards for 40 managers</li><li>Junior Analyst — Beta LLC</li></ul>
<h2>Contact</h2><p>Say hello</p><h3>Not A Project</h3><p>Email me</p>
<a href="https://github.com/octocat">GitHub</a> <a href="https://www.linkedin.com/in/jordan-rivera/">LinkedIn</a>
</body></html>`;

test('a portfolio page yields projects and roles under recognisable headings, plus profile links', () => {
    const { findings, links, readable } = S.parsePortfolioHtml(PORTFOLIO, 'https://jordan.dev');
    const titles = findings.map(f => `${f.kind}:${f.title}`);
    assert.ok(titles.includes('project:Route Planner'), 'JSON-LD project');
    assert.ok(titles.includes('project:Churn Dashboard') && titles.includes('project:Forecast Pipeline'));
    assert.ok(titles.some(t => t.startsWith('experience:Data Analyst')));
    assert.ok(!titles.some(t => /Fake Project In A Script|Not A Project/.test(t)), 'script text and unrelated sections are ignored');
    assert.match(findings.find(f => f.title === 'Churn Dashboard').summary, /cut reporting time & surfaced churn risk/, 'entities are decoded');
    assert.deepEqual(links, { github: 'octocat', linkedin: 'https://www.linkedin.com/in/jordan-rivera' });
    assert.equal(readable, true);
});

test('a page with nothing readable is reported as such instead of inventing content', () => {
    const spa = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>';
    const result = S.parsePortfolioHtml(spa, 'https://spa.example');
    assert.deepEqual([result.findings.length, result.readable], [0, false]);
    assert.doesNotThrow(() => S.parsePortfolioHtml('<<<not html', 'https://x.example'));
});

test('markup in a portfolio cannot inject structure into findings', () => {
    const html = '<h2>Projects</h2><h3>Evil <img src=x onerror=alert(1)> Project</h3><p>Line one\nEXPERIENCE\nFake role</p>';
    const { findings } = S.parsePortfolioHtml(html, 'https://x.example');
    assert.ok(findings.length >= 1);
    for (const f of findings) { assert.ok(!/[<>\n]/.test(f.title + f.summary), JSON.stringify(f)); }
});

test('the page fetcher refuses http, private addresses and redirects into them, and non-HTML', async () => {
    const publicLookup = async () => [{ address: '93.184.216.34' }];
    const privateLookup = async host => [{ address: host === 'ok.example' ? '93.184.216.34' : '10.0.0.5' }];
    const never = async () => { throw new Error('must not fetch'); };
    await assert.rejects(S.fetchPage('http://ok.example', { fetchImpl: never, lookup: publicLookup }), /https/);
    await assert.rejects(S.fetchPage('https://internal.example', { fetchImpl: never, lookup: privateLookup }), /public/);
    const redirect = async () => new Response(null, { status: 302, headers: { location: 'https://metadata.internal/latest' } });
    await assert.rejects(S.fetchPage('https://ok.example', { fetchImpl: redirect, lookup: privateLookup }), /public/);
    const json = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    await assert.rejects(S.fetchPage('https://ok.example', { fetchImpl: json, lookup: publicLookup }), /web page/);
    const good = await S.fetchPage('https://ok.example', { fetchImpl: async () => new Response('<h1>hi</h1>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }), lookup: publicLookup });
    assert.equal(good.html, '<h1>hi</h1>');
});

test('CSV parsing handles quotes, commas, newlines inside quotes, BOM and CRLF', () => {
    const rows = S.parseCsv('﻿Name,Note\r\n"Smith, Jo","said ""hi""\nthere"\r\nplain,"x"\r\n');
    assert.deepEqual(rows, [['Name', 'Note'], ['Smith, Jo', 'said "hi"\nthere'], ['plain', 'x']]);
});

test('LinkedIn Positions.csv becomes experience, even with note lines above the header', () => {
    const csv = 'Notes:,"exported by LinkedIn"\n\nCompany Name,Title,Description,Location,Started On,Finished On\nAcme Corp,Data Analyst,"Built dashboards. Cut reporting from 5 days to 2.",Chicago IL,Jan 2022,\n';
    const [job] = S.parseLinkedinCsv('Positions.csv', csv);
    assert.equal(job.kind, 'experience');
    assert.equal(job.title, 'Data Analyst — Acme Corp');
    assert.deepEqual([job.meta.company, job.meta.start, job.meta.end], ['Acme Corp', 'Jan 2022', '']);
});

test('LinkedIn skills, education, certifications and projects are read; licence numbers are dropped', () => {
    assert.deepEqual(S.parseLinkedinCsv('Skills.csv', 'Name\nSQL\nTableau\n').map(f => [f.kind, f.title]), [['skill', 'SQL'], ['skill', 'Tableau']]);
    const [edu] = S.parseLinkedinCsv('Education.csv', 'School Name,Start Date,End Date,Notes,Degree Name,Activities\nState University,2016,2020,,B.S. Statistics,\n');
    assert.deepEqual([edu.kind, edu.title], ['education', 'B.S. Statistics — State University']);
    const [cert] = S.parseLinkedinCsv('Certifications.csv', 'Name,Url,Authority,Started On,Finished On,License Number\nTableau Desktop Specialist,https://x.example/c,Tableau,Mar 2023,,SECRET-123\n');
    assert.equal(cert.kind, 'certification');
    assert.ok(!JSON.stringify(cert).includes('SECRET-123'), 'licence numbers are never stored');
    assert.equal(S.parseLinkedinCsv('Projects.csv', 'Title,Description,Url,Started On,Finished On\nRoute Planner,Plans routes,https://x.example/p,2024,\n')[0].kind, 'project');
});

test('unrecognised LinkedIn files are refused with guidance', () => {
    assert.throws(() => S.parseLinkedinCsv('Connections.csv', 'First Name,Last Name\nA,B\n'), /Positions\.csv/);
    assert.throws(() => S.parseLinkedinCsv('../../etc/passwd', 'x'), /not a file I can read/);
});

const BASE_RESUME = 'Jordan Rivera\njordan@example.com\n\nSKILLS\nPython, SQL\n\nEXPERIENCE\nData Analyst — Acme Corp\n2022 - Present\n- Built Tableau dashboards used by 40 managers\n- Cut month-end reporting from 5 days to 2\n- Automated checks across 12 systems\n';

test('accepted projects are appended under one PROJECTS section, and later ones join it', () => {
    const [a, b] = S.parseGithubRepos([repo('alpha', { description: 'First tool' }), repo('beta', { description: 'Second tool', language: 'Go' })], 'octocat').filter(f => f.kind === 'project');
    const once = S.applyFindingsToResume(BASE_RESUME, [a]);
    const twice = S.applyFindingsToResume(once, [b]);
    assert.equal((twice.match(/^PROJECTS$/gm) || []).length, 1, 'one heading, not one per project');
    assert.match(twice, /- alpha: First tool \(Python\) https:\/\/github\.com\/octocat\/alpha/);
    assert.match(twice, /- beta: Second tool \(Go\)/);
    assert.ok(twice.startsWith(BASE_RESUME.trimEnd()), 'the original resume is untouched');
    assert.equal(parseResume(twice).projects.flatMap(p => p.bullets).length, 2, 'the resume parser reads them back as projects');
});

test('an accepted LinkedIn role becomes a parseable experience entry that the fact gate accepts', () => {
    const [job] = S.parseLinkedinCsv('Positions.csv', 'Company Name,Title,Description,Location,Started On,Finished On\nBeta LLC,Junior Analyst,"Maintained Excel models for finance. Answered ad hoc SQL requests from sales.",Chicago IL,Jun 2020,Dec 2021\n');
    const text = S.applyFindingsToResume(BASE_RESUME, [job]);
    const parsed = parseResume(text);
    assert.equal(parsed.experience.length, 2);
    const added = parsed.experience[1];
    assert.match(added.header.join(' '), /Junior Analyst — Beta LLC/);
    assert.ok(added.header.some(line => /Jun 2020 - Dec 2021/.test(line)));
    assert.equal(added.bullets.length, 2);
    const tailored = tailorResume({ resumeText: text, job: { title: 'Data Analyst', description: 'Requirements:\n- SQL and Excel experience\n- Tableau dashboards for managers\nWe build reporting for operations and finance across the company every week.' }, profile: {} });
    assert.equal(tailored.factCheck.ok, true, JSON.stringify(tailored.factCheck.unsupported));
});

test('a new job goes inside the existing Experience section, before Education, not under a second heading', () => {
    const resume = 'Jordan Rivera\n\nEXPERIENCE\nData Analyst — Acme Corp\n2022 - Present\n- Built dashboards\n\nEDUCATION\nB.S. Statistics, State University, 2020\n';
    const [job] = S.parseLinkedinCsv('Positions.csv', 'Company Name,Title,Description,Location,Started On,Finished On\nBeta LLC,Junior Analyst,"Maintained Excel models for finance.",,Jun 2020,Dec 2021\n');
    const text = S.applyFindingsToResume(resume, [job]);
    assert.equal((text.match(/^EXPERIENCE$/gm) || []).length, 1, 'one Experience heading');
    assert.ok(text.indexOf('Junior Analyst') < text.indexOf('EDUCATION'), 'the new job sits above Education');
    assert.ok(text.indexOf('Data Analyst') < text.indexOf('Junior Analyst'), 'and below the existing job');
    assert.match(text, /- Built dashboards\n\nJunior Analyst — Beta LLC/, 'jobs are separated by a blank line');
    assert.match(text, /\n\nEDUCATION\n/, 'the next section keeps its spacing');
    assert.deepEqual(parseResume(text).experience.map(e => e.header[0]), ['Data Analyst — Acme Corp', 'Junior Analyst — Beta LLC']);
    assert.ok(text.endsWith('B.S. Statistics, State University, 2020\n'), 'nothing after the sections is lost');
});

test('a section is created only when the resume has none of that kind, and an existing one is joined in place', () => {
    const noProjects = 'Jordan Rivera\n\nEXPERIENCE\nData Analyst — Acme Corp\n2022 - Present\n- Built dashboards\n\nEDUCATION\nState University\n';
    const project = S.parseGithubRepos([repo('alpha')], 'octocat').find(f => f.kind === 'project');
    assert.match(S.applyFindingsToResume(noProjects, [project]), /EDUCATION\nState University\n\nPROJECTS\n- alpha/);
    const withProjects = 'Jordan Rivera\n\nPROJECTS\n- old thing\n\nEXPERIENCE\nData Analyst — Acme Corp\n2022 - Present\n- Built dashboards\n';
    const added = S.applyFindingsToResume(withProjects, [project]);
    assert.match(added, /PROJECTS\n- old thing\n- alpha[^\n]*\n\nEXPERIENCE/, 'joins the existing Projects section');
    assert.equal((added.match(/^PROJECTS$/gm) || []).length, 1);
});

test('text from a profile can never forge a resume section or heading', () => {
    const evil = S.parseGithubRepos([repo('x', { description: 'nice\nEXPERIENCE\nCEO — Fake Corp\n2010 - Present' })], 'octocat').find(f => f.kind === 'project');
    const text = S.applyFindingsToResume(BASE_RESUME, [evil]);
    const added = text.slice(BASE_RESUME.trimEnd().length);
    assert.equal((added.match(/^EXPERIENCE$/gm) || []).length, 0);
    assert.equal(parseResume(text).experience.length, 1, 'no invented role appears');
});

test('skills merge without duplicates and respect the 1,000-character profile limit', () => {
    const merged = S.mergeSkills('Python, SQL', ['sql', 'Go', 'Rust', ' go ']);
    assert.deepEqual([merged.skills, merged.added], ['Python, SQL, Go, Rust', ['Go', 'Rust']]);
    const full = 'S'.repeat(995);
    const limited = S.mergeSkills(full, ['Tableau', 'C']);
    assert.ok(limited.skills.length <= 1000);
    assert.deepEqual(limited.skipped, ['Tableau'], 'too long to fit, so it is skipped and reported');
    assert.deepEqual(limited.added, ['C'], 'a shorter one still fits');
});
