'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { paragraphLines } = require('../documents/export');
const { optimizeForAts } = require('./ats');
const { tailorResume, verifyTailoredFacts } = require('./resume');
const { LIMITS, RULES_TEXT, applyResumeRules, checkResumeRules, trimSummary } = require('./rules');

const LONG_SUMMARY = [
    'Results-driven data analyst with eight years of experience turning messy operational data into clear decisions for business teams.',
    'Skilled in SQL, Python and Tableau, with a record of building dashboards that operations managers use every week.',
    'I am passionate about data quality and have automated checks across twelve source systems.',
    'Led a team of six analysts through a migration of the reporting stack to a cloud warehouse, finishing two weeks early.',
    'Experienced in stakeholder management, presenting findings to directors, and shaping the annual staffing plan.',
    'Comfortable working across finance, sales and supply chain, with a strong interest in forecasting and statistics.',
    'Mentored junior analysts and wrote the onboarding guide that new hires still use today in their first month.',
    'Outside of work I volunteer teaching spreadsheet skills to community groups and local small businesses.',
].join(' ');

const RESUME = `Jordan Rivera
jordan@example.com | (312) 555-0187 | Chicago, IL | linkedin.com/in/jordanrivera

SUMMARY
${LONG_SUMMARY}

SKILLS
Python, SQL, Tableau, Excel, dbt, Snowflake, Airflow, Power BI, R, Looker, Git, Docker, AWS, Spark, Stakeholder management, Data modeling, Forecasting, A/B testing, Statistics, ETL, Reporting, Dashboards, Data quality, Automation, Communication

EXPERIENCE
Data Analyst — Beta LLC, Chicago IL
2018 - 2020
- Maintained Excel models for the finance team covering 15 cost centres
- Supported ad hoc SQL requests from sales leadership, answering 30 requests per month

Senior Data Analyst — Acme Corp, Chicago IL
2022 - Present
- Built Tableau dashboards used weekly by 40 operations managers to track fulfilment performance
- Wrote SQL pipelines that cut month-end reporting from 5 days to 2 for the finance organisation
- Automated data quality checks in Python across 12 source systems, catching 90 issues per quarter
- Presented findings to stakeholders in monthly reviews, shaping the 2024 staffing plan
- Standardised data modeling conventions adopted by 6 analysts on the team
- Documented 20 recurring reports for new team members
- Cleaned customer records, correcting 1,200 duplicate entries

EDUCATION
B.S. Statistics, State University, 2014

REFERENCES
Available upon request
`;

const JOB = { title: 'Senior Data Analyst', company: 'Northwind', description: 'Requirements:\n- 3+ years of experience with SQL and Python\n- Experience building dashboards in Tableau\n- Strong stakeholder management skills\nWe build reporting for finance and sales across the whole company every week.' };
const profile = { experience_years: 8, skills: '', full_name: 'Jordan Rivera', phone: '(312) 555-0187' };
const sentences = text => text.split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(Boolean);

test('the summary in the source really is far over four lines (the problem being fixed)', () => {
    assert.ok(paragraphLines(LONG_SUMMARY) >= 8, `lines: ${paragraphLines(LONG_SUMMARY)}`);
});

test('a long summary is cut to four lines using only the person’s own whole sentences', () => {
    const out = trimSummary(LONG_SUMMARY, ['sql', 'python', 'tableau', 'stakeholder management']);
    assert.equal(out.trimmed, true);
    assert.ok(paragraphLines(out.summary) <= LIMITS.summaryLines, `lines: ${paragraphLines(out.summary)}`);
    assert.ok(out.summary.split(/\s+/).length <= LIMITS.summaryWords);
    const original = sentences(LONG_SUMMARY);
    const kept = sentences(out.summary);
    assert.ok(kept.length >= 1 && kept.every(sentence => original.includes(sentence)), 'every sentence is one of the originals, word for word');
    assert.deepEqual(kept.map(sentence => original.indexOf(sentence)), kept.map(sentence => original.indexOf(sentence)).sort((a, b) => a - b), 'original order');
    assert.ok(!/results-driven|passionate|\bI am\b/i.test(out.summary), 'sentences with filler or first person are left out when cleaner ones fit');
});

test('the opening sentence is kept when it is clean', () => {
    const clean = ['Data analyst who turns messy operational data into clear decisions.', ...sentences(LONG_SUMMARY).slice(1)].join(' ');
    const out = trimSummary(clean, []);
    assert.ok(out.summary.startsWith('Data analyst who turns messy operational data into clear decisions.'));
    assert.ok(paragraphLines(out.summary) <= LIMITS.summaryLines);
});

test('sentences that mention what the job asks for are preferred', () => {
    const out = trimSummary(LONG_SUMMARY, ['sql', 'python', 'tableau']);
    assert.ok(out.summary.includes('SQL, Python and Tableau'), out.summary);
    assert.ok(!out.summary.includes('volunteer'), 'a sentence about volunteering is not kept over job-relevant ones');
});

test('a summary that already fits is left alone', () => {
    const short = 'Data analyst who turns messy operational data into clear decisions for business teams.';
    assert.deepEqual(trimSummary(short), { summary: short, trimmed: false });
    assert.deepEqual(trimSummary(''), { summary: '', trimmed: false });
});

test('one enormous sentence is cut at a clause break, and without punctuation it is cut at a word', () => {
    const clauses = Array.from({ length: 14 }, (_, i) => `building reporting number ${i} for the finance and operations teams across several regions`).join(', ');
    const out = trimSummary(`Analyst ${clauses}.`);
    assert.ok(paragraphLines(out.summary) <= LIMITS.summaryLines);
    assert.ok(!/[,;:]$/.test(out.summary));
    assert.ok(`Analyst ${clauses}.`.includes(out.summary.split(', ')[0]), 'still the person’s own words');
    const blob = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const cut = trimSummary(blob);
    assert.ok(paragraphLines(cut.summary) <= LIMITS.summaryLines);
    assert.ok(blob.startsWith(cut.summary));
});

test('the standard fixes only remove or reorder, and say so', () => {
    const built = tailorResume({ resumeText: RESUME, job: JOB, profile, maxBullets: 12, surfaceSkills: true });
    const before = built.tailored;
    const { tailored, changes } = applyResumeRules(before, { keywords: ['sql', 'python', 'tableau'] });
    assert.ok(paragraphLines(tailored.summary) <= LIMITS.summaryLines);
    assert.ok(tailored.skills.length <= LIMITS.skillsMax);
    assert.ok(tailored.experience[0].bullets.length <= LIMITS.bulletsNewest);
    assert.equal(tailored.other.some(section => /reference/i.test(section.title)), false, 'the references section is gone');
    // roles were listed oldest first in the source: now newest first
    assert.match(tailored.experience[0].header[0], /Senior Data Analyst/);
    assert.ok(changes.some(line => /summary/i.test(line)) && changes.some(line => /reverse chronological/i.test(line)));
    // nothing new: every line is one the resume already had
    const had = new Set([...before.experience.flatMap(entry => entry.bullets), ...before.skills]);
    tailored.experience.flatMap(entry => entry.bullets).forEach(line => assert.ok(had.has(line)));
    assert.deepEqual(applyResumeRules(tailored, { keywords: ['sql'] }).changes, [], 'applying the rules again changes nothing');
});

test('a generated summary is never cut', () => {
    const built = tailorResume({ resumeText: 'Jordan\njordan@example.com | 555-0100\n\nEXPERIENCE\nAnalyst — Acme, X\n2022 - Present\n- Built SQL reports used by 5 teams\n', job: JOB, profile: { experience_years: 4 } });
    assert.equal(built.tailored.summaryGenerated, true);
    assert.equal(applyResumeRules(built.tailored).tailored.summary, built.tailored.summary);
});

test('the rule check names every rule that fails, with the lines to change', () => {
    const built = tailorResume({ resumeText: RESUME, job: JOB, profile, maxBullets: 12, surfaceSkills: true });
    const report = checkResumeRules(built.tailored, { pages: 3 });
    assert.equal(report.total, report.items.length);
    const failing = Object.fromEntries(report.items.filter(item => !item.ok).map(item => [item.id, item]));
    for (const id of ['one-page', 'summary-length', 'summary-voice', 'chronological']) assert.ok(failing[id], `${id} should fail on the raw resume`);
    assert.ok(built.changes.some(line => /Left out sections a resume should not carry: REFERENCES/.test(line)), 'a references section is recognised and left out');
    assert.ok(!built.tailored.education.some(line => /references|upon request/i.test(line)), 'and is not absorbed into Education');
    const withFiller = { ...built.tailored, other: [{ title: 'Hobbies', lines: ['Chess'] }] };
    assert.equal(checkResumeRules(withFiller).items.find(item => item.id === 'no-filler').ok, false);
    assert.match(failing['summary-length'].detail, /\d+ lines, \d+ words/);
    assert.ok(failing['summary-voice'].detail.includes('results-driven') || /I|my/.test(failing['summary-voice'].detail));
    assert.ok(failing['one-page'].fix.length > 0);
});

test('weak, first-person and number-free bullets are listed so they can be fixed', () => {
    const t = { name: 'A B', contact: { email: 'a@b.co', phone: '555-0100', links: [] }, summary: 'Data analyst.', skills: ['SQL', 'Python', 'Tableau', 'Excel', 'dbt', 'R'],
        experience: [{ header: ['Analyst — Acme, X', '2022 - Present'], bullets: ['Responsible for weekly reports', 'I built dashboards for the team', 'Helped with data cleanup', 'Reduced reporting time by 30 percent'] }],
        projects: [], education: ['B.S. Statistics, 2020'], certifications: [], other: [] };
    const report = checkResumeRules(t);
    const byId = Object.fromEntries(report.items.map(item => [item.id, item]));
    assert.equal(byId['no-weak-phrases'].ok, false);
    assert.deepEqual(byId['no-weak-phrases'].lines.sort(), ['Helped with data cleanup', 'Responsible for weekly reports']);
    assert.equal(byId['no-first-person'].ok, false);
    assert.equal(byId['numbers'].ok, false);
    assert.equal(byId['action-verbs'].ok, false);
    assert.equal(byId['one-page'], undefined, 'page count is only checked when it is known');
});

test('the optimiser returns a resume that follows the rules, with the summary under four lines', async () => {
    const result = await optimizeForAts({ resumeText: RESUME, job: JOB, profile, target: 90 });
    const built = result.best.built;
    assert.ok(paragraphLines(built.tailored.summary) <= LIMITS.summaryLines, `summary lines: ${paragraphLines(built.tailored.summary)}`);
    assert.equal(built.pages, 1);
    assert.equal(built.factCheck.ok, true);
    assert.equal(verifyTailoredFacts(built.tailored, RESUME, profile).ok, true, 'each kept summary sentence is the person’s own');
    assert.ok(built.changes.some(line => line.startsWith('Cut your summary')));
    const byId = Object.fromEntries(built.rules.items.map(item => [item.id, item]));
    for (const id of ['one-page', 'summary-length', 'chronological', 'no-filler', 'skills', 'bullet-count']) assert.equal(byId[id].ok, true, `${id}: ${byId[id].detail}`);
});

test('the rules are written down once, in plain words', () => {
    assert.ok(RULES_TEXT.length >= 8);
    assert.ok(RULES_TEXT.some(line => /4 lines/.test(line)));
    assert.ok(RULES_TEXT.some(line => /One page/.test(line)));
});
