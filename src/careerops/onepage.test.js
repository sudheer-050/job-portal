'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pageCount } = require('../documents/export');
const { renderMarkdown, tailorResume } = require('./resume');
const { optimizeForAts } = require('./ats');
const { SAFETY, describeRemoval, fitToPages, measure } = require('./onepage');

const verbs = ['Built', 'Automated', 'Reduced', 'Led', 'Designed', 'Wrote', 'Improved', 'Delivered'];
const things = ['SQL pipelines', 'Tableau dashboards', 'Python checks', 'finance reports', 'forecast models', 'data quality rules', 'sales analyses', 'ETL jobs'];
const bullet = (team, i) => `- ${verbs[i % 8]} ${things[i % 8]} for the ${team} team, cutting turnaround by ${10 + i} percent across ${3 + i} regions`;
const role = (title, company, years, team) => `${title} — ${company}, Chicago IL\n${years}\n${Array.from({ length: 8 }, (_, i) => bullet(team, i)).join('\n')}`;

// a resume the old builder turned into several pages: five roles with eight bullets each, projects, many skills
const LONG = `Jordan Rivera
jordan@example.com | (312) 555-0187 | Chicago, IL | linkedin.com/in/jordanrivera

SUMMARY
Data analyst who turns messy operational data into clear decisions for business teams.

SKILLS
Python, SQL, Tableau, Excel, dbt, Snowflake, Airflow, Power BI, R, Looker, Git, Docker, AWS, Spark, Stakeholder management, Data modeling, Forecasting, A/B testing, Statistics, ETL, Reporting, Dashboards, Data quality, Automation, Communication

EXPERIENCE
${role('Senior Data Analyst', 'Acme Corp', '2022 - Present', 'finance')}

${role('Data Analyst', 'Beta LLC', '2020 - 2022', 'sales')}

${role('Junior Analyst', 'Gamma Inc', '2018 - 2020', 'operations')}

${role('Reporting Analyst', 'Delta Co', '2016 - 2018', 'supply chain')}

${role('Research Assistant', 'State University', '2014 - 2016', 'research')}

PROJECTS
Churn model
- Built a churn model in Python used by the retention team
Dashboard toolkit
- Published a reusable Tableau toolkit adopted by 6 analysts

EDUCATION
B.S. Statistics, State University, 2014

CERTIFICATIONS
Tableau Desktop Specialist
AWS Cloud Practitioner
dbt Fundamentals
Google Data Analytics
SnowPro Core
`;

const JOB = { title: 'Senior Data Analyst', company: 'Northwind', description: 'Requirements:\n- 3+ years of experience with SQL and Python\n- Experience building dashboards in Tableau\n- Strong stakeholder management skills\nWe build reporting for finance and sales across the whole company every week.' };
const profile = { experience_years: 8, skills: '', full_name: 'Jordan Rivera', phone: '(312) 555-0187' };
const buildLong = () => tailorResume({ resumeText: LONG, job: JOB, profile, maxBullets: 12, surfaceSkills: true });

test('the source resume really is long (the problem being fixed)', () => {
    const built = buildLong();
    assert.ok(built.tailored.experience.length >= 4, `roles parsed: ${built.tailored.experience.length}`);
    assert.ok(pageCount(renderMarkdown(built.tailored)) >= 2, 'an untrimmed tailored resume runs to several pages');
});

test('a long resume is held to one page, measured the way the PDF is laid out', () => {
    const fitted = fitToPages(buildLong().tailored);
    assert.equal(fitted.fits, true);
    assert.equal(fitted.pages, 1);
    assert.equal(pageCount(renderMarkdown(fitted.tailored)), 1);
    assert.equal(pageCount(renderMarkdown(fitted.tailored), { reserve: SAFETY }), 1, 'with room to spare for other programs');
    assert.ok(fitted.removed.length > 0);
});

test('trimming only removes: every line that is left was already there, in the same order', () => {
    const built = buildLong();
    const fitted = fitToPages(built.tailored).tailored;
    fitted.experience.forEach((entry, index) => {
        const before = built.tailored.experience.find(item => item.header[0] === entry.header[0]);
        assert.ok(before, 'no role was invented');
        const kept = entry.bullets.map(line => before.bullets.indexOf(line));
        assert.ok(kept.every(position => position >= 0), `bullets of role ${index} all come from the original`);
        assert.deepEqual(kept, [...kept].sort((a, b) => a - b), 'order is unchanged');
    });
    assert.deepEqual(fitted.education, built.tailored.education, 'education is never cut');
    assert.equal(fitted.name, built.tailored.name);
    assert.deepEqual(fitted.contact, built.tailored.contact);
});

test('the newest role keeps its best bullets and old content goes first', () => {
    const built = buildLong();
    const fitted = fitToPages(built.tailored).tailored;
    assert.ok(fitted.experience[0].bullets.length >= 3, 'the newest role keeps at least three bullets');
    assert.equal(fitted.experience[0].bullets[0], built.tailored.experience[0].bullets[0], 'its most relevant bullet is kept');
    const counts = fitted.experience.map(entry => entry.bullets.length);
    assert.ok(counts[0] >= counts[counts.length - 1], 'recent roles keep at least as much as the oldest');
});

test('a resume that already fits is left exactly as it is', () => {
    const short = 'A B\na@b.co | 555-0100\n\nSKILLS\nSQL, Python\n\nEXPERIENCE\nAnalyst — Acme, X\n2022 - Present\n- Built SQL reports used by 5 teams\n- Cut reporting time by 30 percent\n- Automated checks in Python\n\nEDUCATION\nB.S. Statistics, 2020\n';
    const built = tailorResume({ resumeText: short, job: JOB, profile: {} });
    const fitted = fitToPages(built.tailored);
    assert.deepEqual(fitted.removed, []);
    assert.deepEqual(fitted.tailored, built.tailored);
});

test('the optimiser always returns a one-page resume, and says what it left out', async () => {
    const result = await optimizeForAts({ resumeText: LONG, job: JOB, profile, target: 90 });
    const best = result.best;
    assert.equal(best.built.pages, 1);
    assert.equal(measure(best.built.tailored), 1);
    assert.equal(best.built.factCheck.ok, true, 'the fact check still passes');
    assert.ok(best.built.changes.some(line => line.startsWith('Kept to one page')));
    assert.ok(best.ats.score > 0);
    for (const round of result.rounds) assert.equal(round.factCheckOk, true);
});

test('what was left out is described in plain words', () => {
    assert.equal(describeRemoval([]), '');
    const text = describeRemoval(['a bullet under "x"', 'a bullet under "y"', 'project "Churn model"']);
    assert.match(text, /^Kept to one page: left out 2 lower-relevance bullets, 1 project. /);
    assert.match(describeRemoval(['the role "X"', 'certification "A"', 'certification "B"', 'skill "dbt"', 'the summary', 'Other: one line']), /1 older role, 2 certifications, 1 extra skill, the summary, 1 other line./);
    assert.match(text, /still from your own resume/);
});

test('when even the essentials are too long it says so instead of pretending', () => {
    const lines = Array.from({ length: 140 }, (_, i) => `contact line number ${i} with some extra words to take up room on the page`).join('\n');
    const built = tailorResume({ resumeText: `Jordan Rivera\n${lines}\n\nEXPERIENCE\nAnalyst — Acme, X\n2022 - Present\n- Built SQL reports used by 5 teams\n`, job: JOB, profile: {} });
    const fitted = fitToPages(built.tailored);
    assert.equal(typeof fitted.fits, 'boolean');
    assert.equal(fitted.fits, fitted.pages <= 1);
});

test('the page is used fully: no bullet that was left out would still fit', () => {
    const built = buildLong();
    const fitted = fitToPages(built.tailored).tailored;
    let checked = 0;
    built.tailored.experience.forEach(original => {
        const kept = fitted.experience.find(entry => entry.header[0] === original.header[0]);
        if (!kept) return;
        for (const line of original.bullets) {
            if (kept.bullets.includes(line)) continue;
            const trial = JSON.parse(JSON.stringify(fitted));
            trial.experience.find(entry => entry.header[0] === original.header[0]).bullets.push(line);
            assert.ok(measure(trial) > 1, `"${line.slice(0, 40)}…" would still fit, so the page is not full`);
            checked += 1;
        }
    });
    assert.ok(checked > 0, 'something was left out to test against');
});
