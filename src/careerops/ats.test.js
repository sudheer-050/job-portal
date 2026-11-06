'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { optimizeForAts, scoreAts } = require('./ats');
const { tailorResume } = require('./resume');

const RESUME = `Jordan Rivera
jordan@example.com | (312) 555-0187 | Chicago, IL | linkedin.com/in/jordanrivera

SUMMARY
Data analyst who turns messy operational data into clear decisions for business teams.

SKILLS
Python, SQL, Tableau, Excel, Stakeholder management, Data modeling

EXPERIENCE
Data Analyst — Acme Corp, Chicago IL
2022 - Present
- Built Tableau dashboards used weekly by 40 operations managers to track fulfilment performance
- Wrote SQL pipelines that cut month-end reporting from 5 days to 2 for the finance organisation
- Automated data quality checks in Python across 12 source systems, catching 90 issues per quarter
- Presented findings to stakeholders in monthly reviews, shaping the 2024 staffing plan
- Standardised data modeling conventions adopted by 6 analysts on the team

Junior Analyst — Beta LLC, Chicago IL
2020 - 2022
- Maintained Excel models for the finance team covering 15 cost centres
- Supported ad hoc SQL requests from sales leadership, answering 30 requests per month
- Reduced manual reporting effort by 8 hours per week using Python scripts
- Documented 20 recurring reports for new team members

Reporting Intern — Gamma Inc, Chicago IL
2019 - 2020
- Compiled weekly sales summaries in Excel for 4 regional managers
- Cleaned customer records, correcting 1,200 duplicate entries
- Built a Tableau prototype that the team later adopted for monthly reviews

EDUCATION
B.S. Statistics, State University, 2020

CERTIFICATIONS
Tableau Desktop Specialist
`;

const MATCHING_JOB = {
    title: 'Data Analyst', company: 'Northwind',
    description: `Requirements:
- 3+ years of experience with SQL and Python
- Experience building dashboards in Tableau
- Strong stakeholder management skills
- Excel and data modeling experience
We build reporting for operations, finance and sales across the whole company every single week.`,
};

const DEMANDING_JOB = {
    title: 'Senior Data Analyst', company: 'Northwind',
    description: `Requirements:
- 3+ years of experience with SQL and Python
- Experience building dashboards in Tableau or Power BI
- Strong stakeholder management skills
- Hands-on Snowflake and dbt experience required
- Airflow orchestration for data pipelines
We build reporting for operations, finance and sales across the whole company every single week.`,
};

const profile = { experience_years: 5, skills: 'Python, SQL, Tableau', full_name: 'Jordan Rivera', phone: '(312) 555-0187' };

test('scoring reports a breakdown and a ceiling', () => {
    const { tailored } = tailorResume({ resumeText: RESUME, job: MATCHING_JOB, profile });
    const result = scoreAts({ tailored, job: MATCHING_JOB, candidateText: RESUME });
    assert.ok(result.score >= 0 && result.score <= 100);
    assert.ok(result.ceiling >= result.score);
    assert.deepEqual([...new Set(result.breakdown.map(item => item.group))], ['Structure', 'Keywords', 'Quality', 'Title']);
    assert.equal(result.breakdown.reduce((sum, item) => sum + item.max, 0), 100);
});

test('structural problems lower the score and produce fixes', () => {
    const bare = 'Jordan Rivera\n\nI worked on various data things for many years at several places.';
    const { tailored } = tailorResume({ resumeText: bare, job: MATCHING_JOB, profile: {} });
    const result = scoreAts({ tailored, job: MATCHING_JOB, candidateText: bare });
    assert.ok(result.score < 50, `score ${result.score}`);
    assert.ok(result.issues.some(issue => /Experience/.test(issue.text)));
    assert.ok(result.issues.every(issue => issue.fix));
});

test('the optimiser raises a truthful resume to 90 or above and stays fact-checked', async () => {
    const result = await optimizeForAts({ resumeText: RESUME, job: MATCHING_JOB, profile, target: 90 });
    assert.equal(result.reached, true, `${result.best.ats.score}: ${JSON.stringify(result.rounds)}`);
    assert.ok(result.best.ats.score >= 90);
    assert.equal(result.best.built.factCheck.ok, true, JSON.stringify(result.best.built.factCheck.unsupported));
    assert.ok(result.rounds.length >= 1);
});

test('the optimiser improves round over round and keeps the best attempt', async () => {
    const result = await optimizeForAts({ resumeText: RESUME, job: DEMANDING_JOB, profile, target: 99 });
    const scores = result.rounds.map(round => round.score);
    assert.equal(result.best.ats.score, Math.max(...scores));
    assert.ok(result.rounds.length > 1, 'it should keep trying while below target');
});

test('it never reaches the target by adding keywords the candidate does not have', async () => {
    const result = await optimizeForAts({ resumeText: RESUME, job: DEMANDING_JOB, profile, target: 90 });
    const output = JSON.stringify(result.best.built.tailored).toLowerCase();
    for (const forbidden of ['snowflake', 'dbt', 'airflow', 'power bi']) assert.ok(!output.includes(forbidden), `${forbidden} was added`);
    assert.equal(result.reached, false);
    assert.ok(result.best.ats.ceiling < 90);
    assert.match(result.explanation, /honestly|truthful/i);
    assert.match(result.explanation, /snowflake|dbt|airflow/i);
    assert.equal(result.best.built.factCheck.ok, true);
});

test('adding a genuinely held skill to the profile is credited and surfaced', async () => {
    const withSkill = { ...profile, skills: `${profile.skills}, Snowflake, dbt` };
    const base = await optimizeForAts({ resumeText: RESUME, job: DEMANDING_JOB, profile, target: 90 });
    const better = await optimizeForAts({ resumeText: RESUME, job: DEMANDING_JOB, profile: withSkill, target: 90 });
    assert.ok(better.best.ats.score > base.best.ats.score);
    assert.ok(better.best.built.tailored.skills.some(skill => /snowflake/i.test(skill)));
    assert.equal(better.best.built.factCheck.ok, true);
});

test('level words are ignored so a seniority is never required or invented', () => {
    const { tailored } = tailorResume({ resumeText: RESUME, job: DEMANDING_JOB, profile });
    const result = scoreAts({ tailored, job: DEMANDING_JOB, candidateText: RESUME });
    const title = result.breakdown.find(item => item.group === 'Title');
    assert.doesNotMatch(title.detail, /senior/i);
    assert.equal(title.points, 10);
});

test('AI wording is used only when it helps, passes the rules, and is fact-checked', async () => {
    const resume = RESUME.replace('Built Tableau dashboards used weekly', 'Made dashboards in Tableau used weekly');
    let calls = 0;
    const askAi = async tailored => {
        calls += 1;
        return tailored.experience.flatMap(role => role.bullets).map((text, id) => ({
            id, original: text, status: /Made dashboards/.test(text) ? 'improved' : 'unchanged',
            suggested: /Made dashboards/.test(text) ? text.replace('Made dashboards in Tableau', 'Built Tableau dashboards') : text,
        }));
    };
    const result = await optimizeForAts({ resumeText: resume, job: DEMANDING_JOB, profile, target: 100, askAi });
    assert.equal(calls, 1);
    assert.equal(result.best.built.factCheck.ok, true);
    assert.ok(result.rounds.some(round => /AI wording/.test(round.label)));
    // The opted-in rewording is kept even though it does not change the score, and it is rule-checked.
    assert.equal(result.aiUsed, true);
    assert.ok(result.best.built.appliedRewrites.length >= 1);
    assert.ok(result.best.built.tailored.experience[0].bullets.some(line => /^Built Tableau dashboards/.test(line)));
});

test('AI rewording that breaks the rules is dropped and never lowers the result', async () => {
    const askAi = async tailored => tailored.experience.flatMap(role => role.bullets).map((text, id) => ({
        id, original: text, status: 'improved', suggested: `Led ${text} using Snowflake and dbt`,
    }));
    const base = await optimizeForAts({ resumeText: RESUME, job: DEMANDING_JOB, profile, target: 100 });
    const result = await optimizeForAts({ resumeText: RESUME, job: DEMANDING_JOB, profile, target: 100, askAi });
    assert.equal(result.aiUsed, false);
    assert.equal(result.best.ats.score, base.best.ats.score);
    assert.ok(!JSON.stringify(result.best.built.tailored).toLowerCase().includes('snowflake'));
    assert.equal(result.best.built.factCheck.ok, true);
});

test('an AI failure never breaks the optimiser', async () => {
    const result = await optimizeForAts({ resumeText: RESUME, job: DEMANDING_JOB, profile, target: 100, askAi: async () => { throw new Error('provider down'); } });
    assert.equal(result.aiError, 'provider down');
    assert.ok(result.best.ats.score > 0);
});
