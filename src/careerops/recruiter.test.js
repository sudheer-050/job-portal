'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pageCount } = require('../documents/export');
const { optimizeForAts } = require('./ats');
const { extractKeywords } = require('./keywords');
const { evaluateOffer } = require('./evaluate');
const { applyResumeRules, checkResumeRules, trimSummary } = require('./rules');
const { boldMetrics, checkCoverLetter, earlierLine, headlineFor, ownTitleParts, headlineIsEvidenced, pickAchievements, recruiterVerdict } = require('./recruiter');
const { buildCoverLetter, parseResume, renderHtml, renderMarkdown, tailorResume, verifyTailoredFacts } = require('./resume');

const RESUME = `Jordan Rivera
jordan@example.com | (312) 555-0187 | Chicago, IL | linkedin.com/in/jordanrivera

SUMMARY
Data analyst with 8 years of experience across finance and operations. Cut month-end reporting from 5 days to 2 and saved $1.5M per year by migrating reports to Snowflake. Skilled in SQL, Python and Tableau.

SKILLS
Python, SQL, Tableau, Excel, Snowflake, dbt, Power BI, Stakeholder management

EXPERIENCE
Senior Data Analyst — Acme Corp, Chicago IL
2022 - Present
- Built Tableau dashboards used weekly by 40 operations managers to track fulfilment performance
- Wrote SQL pipelines that cut month-end reporting from 5 days to 2 for the finance organisation
- Saved an estimated $1.5M per year by migrating on-premises databases to Snowflake
- Automated data quality checks in Python across 12 source systems, catching 90 issues per quarter

Data Analyst — Beta LLC, Chicago IL
2018 - 2022
- Maintained Excel models for the finance team covering 15 cost centres
- Supported ad hoc SQL requests from sales leadership, answering 30 requests per month

Reporting Analyst — Delta Co, Chicago IL
2014 - 2018
- Compiled weekly sales summaries for 4 regional managers

Business Analyst — Gamma Inc, Chicago IL
2008 - 2011
- Cleaned customer records, correcting 1,200 duplicate entries

Software Engineer — Omega Systems, Chicago IL
2006 - 2008
- Wrote reporting scripts used by 20 analysts

EDUCATION
B.S. Statistics, State University, 2006
`;

const JOB = { title: 'Senior Data Analyst', company: 'Northwind', location: 'Chicago, IL', description: 'Requirements:\n- 3+ years of experience with SQL and Python\n- Experience building dashboards in Tableau\n- Strong stakeholder management skills\n- Snowflake experience is a plus\nWe build reporting for finance and sales across the whole company every week.' };
const profile = { full_name: 'Jordan Rivera', phone: '(312) 555-0187', experience_years: 8 };
const keywords = extractKeywords(`${JOB.title}\n${JOB.description}`, { limit: 30 });

test('the headline is the target role and up to three skills the resume evidences, in the resume’s own wording', () => {
    const experience = parseResume(RESUME).experience;
    const headline = headlineFor({ job: JOB, experience, evidenceText: RESUME, keywords });
    assert.match(headline, /^Data Analyst \| /, 'level words (Senior) are left out: the headline never claims a seniority');
    const parts = headline.split(' | ');
    assert.ok(parts.length >= 2 && parts.length <= 4, headline);
    assert.ok(parts.slice(1).every(part => /sql|python|tableau|snowflake|stakeholder/i.test(part)), headline);
    assert.equal(headlineIsEvidenced(headline, RESUME), true);
});

test('a role title the resume does not contain is never claimed: the person’s own newest title is used instead', () => {
    const job = { title: 'Machine Learning Engineer', description: 'Python and SQL for machine learning pipelines' };
    const headline = headlineFor({ job, experience: parseResume(RESUME).experience, evidenceText: RESUME, keywords: extractKeywords(`${job.title}\n${job.description}`, { limit: 20 }) });
    assert.ok(!/Machine Learning Engineer/i.test(headline), headline);
    assert.match(headline, /^Senior Data Analyst \| /);
    assert.equal(headlineIsEvidenced('Machine Learning Engineer | Python', RESUME), false, 'a fabricated part is caught');
    assert.equal(headlineFor({ job: { title: 'Chef', description: 'knives' }, experience: [], evidenceText: 'nothing relevant', keywords: [] }), '', 'nothing true to say: no headline');
});

test('key numbers are bold, years and plain counts are not, and bolding is never doubled', () => {
    assert.equal(boldMetrics('Saved an estimated $1.5M per year by migrating'), 'Saved an estimated **$1.5M** per year by migrating');
    assert.equal(boldMetrics('Cut data latency by 87% (6 hours to under 45 minutes)'), 'Cut data latency by **87%** (**6 hours** to under **45 minutes**)');
    assert.equal(boldMetrics('Trained 8+ team members and processed 1M+ records'), 'Trained **8+** team members and processed **1M+** records');
    assert.equal(boldMetrics('Worked there in 2021 with a team of 12 analysts'), 'Worked there in 2021 with a team of 12 analysts', 'a year and a head count are not metrics');
    assert.equal(boldMetrics('Cut 10% of cost, 20% of time, 30% of errors and 40% of delay'), 'Cut **10%** of cost, **20%** of time, **30%** of errors and 40% of delay', 'at most three per line');
    const once = boldMetrics('Improved retention 10%');
    assert.equal(boldMetrics(once), once);
});

test('an older role becomes the line the resume already has', () => {
    assert.equal(earlierLine({ header: ['Junior Engineer | Hetero Labs Limited', 'February 2021 – July 2023 | Hyderabad, India'] }), 'Junior Engineer | Hetero Labs Limited (February 2021 – July 2023)');
    assert.equal(earlierLine({ header: ['Business Analyst — Gamma Inc, Chicago IL', '2008 - 2011'] }), 'Business Analyst — Gamma Inc, Chicago IL (2008 - 2011)');
    assert.equal(earlierLine({ header: [] }), '');
});

test('roles that ended more than ten years ago go to one line each; the two newest roles never do', () => {
    const built = tailorResume({ resumeText: RESUME, job: JOB, profile });
    const { tailored, changes } = applyResumeRules(built.tailored, { keywords: [], now: 2026 });
    assert.deepEqual(tailored.experience.map(role => role.header[0].split(' — ')[0]), ['Senior Data Analyst', 'Data Analyst', 'Reporting Analyst']);
    assert.deepEqual(tailored.earlier, ['Business Analyst — Gamma Inc, Chicago IL (2008 - 2011)', 'Software Engineer — Omega Systems, Chicago IL (2006 - 2008)']);
    assert.ok(changes.some(line => /ended more than ten years ago/.test(line)));
    const none = applyResumeRules(built.tailored, { keywords: [], now: 2012 });
    assert.deepEqual(none.tailored.earlier || [], [], 'recent enough: nothing is shortened');
});

test('the summary prefers the sentences with numbers', () => {
    const summary = 'Dedicated data professional who enjoys solving problems. Cut month-end reporting from 5 days to 2 and saved $1.5M per year. Works with teams across several departments and regions every single week of the year, in many different settings and situations. Skilled in SQL.';
    const out = trimSummary(summary, ['sql']);
    assert.ok(/\$1\.5M/.test(out.summary), out.summary);
    assert.ok(!/Dedicated data professional/.test(out.summary) || /\$1\.5M/.test(out.summary));
});

test('a resume built for a job has a headline, bold numbers and old roles in one line, and still passes the fact check', async () => {
    const out = await optimizeForAts({ resumeText: RESUME, job: JOB, profile, target: 90 });
    const built = out.best.built;
    assert.ok(built.tailored.headline.startsWith('Data Analyst |'), built.tailored.headline);
    assert.equal(built.factCheck.ok, true);
    assert.equal(verifyTailoredFacts(built.tailored, RESUME, profile).ok, true);
    assert.equal(built.pages, 1);
    const markdown = renderMarkdown(built.tailored);
    assert.match(markdown, /\n\*\*Data Analyst \| /, 'the headline sits under the name and contact line');
    assert.match(markdown, /\*\*\$1\.5M\*\*/, 'key numbers are bold');
    assert.match(renderHtml(built.tailored), /<strong>\$1\.5M<\/strong>/);
    assert.ok(pageCount(markdown) === 1, 'bold numbers do not push it past one page');
    const ruled = applyResumeRules(built.tailored, { keywords: [], now: 2026 }).tailored;
    assert.ok(ruled.earlier.length >= 1 && verifyTailoredFacts(ruled, RESUME, profile).ok, 'an earlier-role line is the resume’s own wording');
    assert.match(renderMarkdown(ruled), /## Earlier Experience\nBusiness Analyst — Gamma Inc, Chicago IL \(2008 - 2011\)/);
});

test('a role cut to fit the page stays as one line before it is dropped', async () => {
    const roles = Array.from({ length: 7 }, (_, i) => `Analyst Level ${i} — Company ${i}, Chicago IL\n${2024 - i * 2 - 1} - ${2024 - i * 2}\n${Array.from({ length: 5 }, (_b, j) => `- Built reporting number ${j} for the finance and operations teams across several regions, cutting turnaround by ${10 + j} percent`).join('\n')}`).join('\n\n');
    const text = `Jordan Rivera\njordan@example.com | (312) 555-0187\n\nSKILLS\nSQL, Python, Tableau, Excel, dbt, Snowflake\n\nEXPERIENCE\n${roles}\n\nEDUCATION\nB.S. Statistics, 2006\n`;
    const out = await optimizeForAts({ resumeText: text, job: JOB, profile, target: 90 });
    const built = out.best.built;
    assert.equal(built.pages, 1);
    assert.equal(built.factCheck.ok, true);
    assert.equal(verifyTailoredFacts(built.tailored, text, profile).ok, true);
    assert.ok(built.tailored.experience.length < 7, 'some roles were cut');
    assert.ok((built.tailored.earlier || []).length >= 1, 'a role that did not fit shows as one line instead of disappearing');
    assert.ok(built.tailored.earlier.every(line => /^Analyst Level \d — Company \d, Chicago IL \(\d{4} - \d{4}\)$/.test(line)), built.tailored.earlier.join(' | '));
});

test('the new resume rules report what is missing', () => {
    const built = tailorResume({ resumeText: RESUME, job: JOB, profile });
    const noHeadline = { ...built.tailored, headline: '', summary: 'A dedicated data professional.', skills: ['Teamwork'] };
    const report = checkResumeRules(noHeadline, { pages: 1, keywords: keywords.map(item => item.term), now: 2026 });
    const byId = Object.fromEntries(report.items.map(item => [item.id, item]));
    assert.equal(byId.headline.ok, false);
    assert.equal(byId['summary-numbers'].ok, false);
    assert.equal(byId['earlier-experience'].ok, false, 'two old roles are shown in full');
    assert.equal(byId['keywords-up-front'].ok, false);
    const good = checkResumeRules(applyResumeRules(built.tailored, { keywords: [], now: 2026 }).tailored, { pages: 1, keywords: keywords.map(item => item.term), now: 2026 });
    assert.equal(Object.fromEntries(good.items.map(item => [item.id, item])).headline.ok, true);
    assert.equal(Object.fromEntries(good.items.map(item => [item.id, item]))['earlier-experience'].ok, true);
});

test('the cover letter opens with the role and company, quotes the best numbers, and follows its rules', () => {
    const evaluation = evaluateOffer({ job: JOB, profile, roles: ['Data Analyst'], resumeText: RESUME });
    const letter = buildCoverLetter({ resumeText: RESUME, job: JOB, profile, requirements: evaluation.blocks.B.requirements });
    const lines = letter.text.split('\n\n');
    assert.equal(lines[0], 'Dear Northwind hiring team,');
    assert.match(lines[1], /^I'm applying for the Senior Data Analyst role at Northwind in Chicago, IL/);
    assert.ok(!/writing to apply/i.test(letter.text));
    const bullets = letter.text.split('\n').filter(line => line.startsWith('• '));
    assert.ok(bullets.length >= 1 && bullets.length <= 3);
    assert.ok(bullets.every(line => RESUME.includes(line.slice(2).split(' (answers:')[0])), 'each result is the resume’s own line');
    assert.ok(/\d/.test(bullets[0]), 'the first result carries a number');
    assert.match(lines[lines.length - 2], /short conversation/);
    assert.match(lines[lines.length - 1], /^Sincerely,\nJordan Rivera$/);
    const report = checkCoverLetter(letter.text, { title: JOB.title, company: JOB.company, name: 'Jordan Rivera' });
    assert.equal(report.passed, report.total, JSON.stringify(report.items.filter(item => !item.ok)));
});

test('numbers come first when choosing the results for a letter, and a bad letter is reported', () => {
    const picked = pickAchievements([{ evidence: 'Maintained dashboards for the team', requirement: 'a' }, { evidence: 'Cut reporting from 5 days to 2', requirement: 'b' }, { evidence: 'Cut reporting from 5 days to 2', requirement: 'c' }, { evidence: 'Led 12 analysts', requirement: 'd' }, { evidence: 'Wrote docs', requirement: 'e' }]);
    assert.deepEqual(picked.map(item => item.evidence), ['Cut reporting from 5 days to 2', 'Led 12 analysts', 'Maintained dashboards for the team'], 'duplicates are dropped and numbers go first');
    const bad = checkCoverLetter(`Dear team,\n\nI am writing to apply for the job. I am a hard-working team player who is passionate about data.\n\n${'word '.repeat(300)}`, { title: 'Analyst', company: 'Acme' });
    const failed = bad.items.filter(item => !item.ok).map(item => item.id);
    for (const id of ['opens-with-role', 'length', 'no-filler', 'next-step']) assert.ok(failed.includes(id), `${id} should fail`);
});

test('the recruiter’s verdict is shortlist, maybe or reject, with reasons and quick fixes', () => {
    const rules = { passed: 17, total: 20, items: [{ ok: false, fix: 'Add a headline.' }, { ok: true }] };
    const letter = { passed: 7, total: 8, items: [{ ok: false, fix: 'End with a next step.' }] };
    const shortlist = recruiterVerdict({ fit: 4.4, ats: 91, resumeRules: rules, letterRules: letter });
    assert.equal(shortlist.verdict, 'Shortlist');
    assert.deepEqual(shortlist.fixes, ['Add a headline.', 'Cover letter: End with a next step.']);
    assert.equal(recruiterVerdict({ fit: 3.6, ats: 74, resumeRules: rules, letterRules: letter }).verdict, 'Maybe');
    assert.equal(recruiterVerdict({ fit: 2.4, ats: 90, resumeRules: rules, letterRules: letter }).verdict, 'Reject');
    assert.equal(recruiterVerdict({ fit: 4.6, ats: 95, resumeRules: rules, letterRules: letter, blockers: ['Pay is below your minimum.'] }).verdict, 'Reject');
    assert.equal(recruiterVerdict({ fit: 4.6, ats: 95, legitimacy: 'Suspicious' }).verdict, 'Reject');
    assert.ok(shortlist.reasons.length >= 3);
});

const { layoutPages, toDocx } = require('../documents/export');
const { metricGaps } = require('./recruiter');

test('dates sit against the right margin in the PDF and as a right tab in Word', () => {
    const md = '## Experience\n\n### Data Analyst | Acme\tJan 2020 - Present\nChicago, IL\n- Did a thing\n';
    const ops = layoutPages(md).flat().join('\n');
    const m = ops.match(/BT \/F1 10\.5 Tf ([\d.]+) [\d.]+ Td \(Jan 2020 - Present\) Tj ET/);
    assert.ok(m && Number(m[1]) > 400, 'dates start well right of the left margin');
    assert.ok(/0\.12 0\.25 0\.45 rg/.test(ops) && /0\.12 0\.25 0\.45 RG/.test(ops), 'section headings are coloured');
    const docx = toDocx(md).toString('latin1');
    assert.ok(docx.length > 0);
});

test('a role’s dates move to the right margin and the location stays under the title', () => {
    const built = tailorResume({ resumeText: RESUME, job: JOB, profile });
    const md = renderMarkdown(built.tailored);
    assert.match(md, /### Senior Data Analyst — Acme Corp, Chicago IL\t2022 - Present/);
    assert.equal(verifyTailoredFacts(built.tailored, RESUME, profile).ok, true);
});

test('skills keep their category labels when the resume has them, and only skills still on the page are shown', () => {
    const text = RESUME.replace(/SKILLS\n.*\n/, 'SKILLS\nLanguages: Python, SQL\nTools: Tableau, Excel, dbt\nCloud: Snowflake\n');
    const built = tailorResume({ resumeText: text, job: JOB, profile });
    const md = renderMarkdown(built.tailored);
    assert.match(md, /\*\*Languages:\*\* .*SQL/);
    assert.match(md, /\*\*Tools:\*\* /);
    const trimmed = renderMarkdown({ ...built.tailored, skills: built.tailored.skills.filter(s => !/dbt/i.test(s)) });
    assert.ok(!/dbt/.test(trimmed.split('## Experience')[0].split('## Skills')[1]));
    assert.match(renderMarkdown(tailorResume({ resumeText: RESUME, job: JOB, profile }).tailored), /## Skills\n[^*]/, 'an unlabeled list stays a plain list');
});

test('bullets without a number become a question, never an invented figure', () => {
    const t = { experience: [{ header: ['Old'], bullets: ['Wrote 3 reports'] }].concat([]) };
    assert.deepEqual(metricGaps(t), []);
    const gaps = metricGaps({ experience: [{ header: ['Analyst'], bullets: ['Built dashboards for managers', 'Cut costs 20%'] }] });
    assert.equal(gaps.length, 1);
    assert.match(gaps[0].prompt, /^\[ADD METRIC\] Built dashboards for managers/);
    assert.ok(!/\d/.test(gaps[0].prompt));
});

test('the headline uses the part of your own title line that is closest to the job, and only skills your resume spells out', () => {
    const NL = String.fromCharCode(10);
    const text = ['Jordan Rivera', 'AI/ML Engineer & Analyst | Data Analyst | Business Analyst', 'jordan@example.com | Chicago, IL', 'SKILLS', 'Python, SQL, Tableau, GitHub Actions, machine learning',
        'EXPERIENCE', 'Data Analytics Intern, Acme, Remote 2023 - 2024', '- Built 3 dashboards'].join(NL);
    const parsed = parseResume(text);
    const kw = extractKeywords('Business Analyst github python machine learning engineer', { limit: 12 });
    const headline = headlineFor({ job: { title: 'Business Analyst' }, ownTitles: ownTitleParts(parsed.headerLines), experience: parsed.experience, evidenceText: text, keywords: kw });
    assert.match(headline, /^Business Analyst \| /, 'the closest part of the title line');
    assert.ok(!/github/i.test(headline), 'GitHub appears only inside "GitHub Actions"');
    assert.ok(!/engineer/i.test(headline.split(' | ').slice(1).join(' ')), 'a bare job-title word is not a skill');
    assert.ok(/Machine Learning|Python/.test(headline) && !/machine learning/.test(headline), headline);
    const ml = headlineFor({ job: { title: 'Machine Learning Engineer' }, ownTitles: ownTitleParts(parsed.headerLines), experience: parsed.experience, evidenceText: text, keywords: kw });
    assert.match(ml, /^AI\/ML Engineer & Analyst \| /);
    assert.equal(headlineIsEvidenced(ml, text), true);
});

test('your own title line alone is a fine headline when no job skill is evidenced', () => {
    const NL = String.fromCharCode(10);
    const text = ['Jordan Rivera', 'AI/ML Engineer & Analyst | Data Analyst', 'jordan@example.com', 'EXPERIENCE', 'Data Analytics Intern, Acme, Remote 2023 - 2024', '- Built 3 dashboards'].join(NL);
    const parsed = parseResume(text);
    const headline = headlineFor({ job: { title: 'AI Engineer' }, ownTitles: ownTitleParts(parsed.headerLines), experience: parsed.experience, evidenceText: text, keywords: [{ term: 'kubernetes' }] });
    assert.equal(headline, 'AI/ML Engineer & Analyst');
    assert.equal(headlineFor({ job: { title: 'Chef' }, ownTitles: [], experience: [], evidenceText: 'x', keywords: [] }), '');
});
