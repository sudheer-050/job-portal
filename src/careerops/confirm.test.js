'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { optimizeForAts } = require('./ats');
const { applyConfirmedSkills, MAX_CONFIRMED } = require('./confirm');

// Reuse the resume and job from the ATS tests so both suites describe the same candidate.
const source = fs.readFileSync(path.join(__dirname, 'ats.test.js'), 'utf8');
const RESUME = source.match(/const RESUME = `([\s\S]*?)`;/)[1];
const JOB = eval(`(${source.match(/const DEMANDING_JOB = (\{[\s\S]*?\n\});/)[1]})`);
const profile = { experience_years: 5, skills: 'Python, SQL, Tableau', full_name: 'Jordan Rivera', phone: '(312) 555-0187' };

test('without a confirmation nothing changes', () => {
    for (const requested of [undefined, null, [], 'dbt', {}]) {
        const result = applyConfirmedSkills({ requested, job: JOB, profile });
        assert.equal(result.profile, profile);
        assert.deepEqual([result.confirmed, result.rejected], [[], []]);
    }
});

test('only keywords the job asks for can be confirmed', () => {
    const result = applyConfirmedSkills({ requested: ['dbt', 'Snowflake', 'kubernetes', '  ', 'Staff Engineer', 'dbt'], job: JOB, profile });
    assert.deepEqual(result.confirmed, ['dbt', 'snowflake']);
    assert.deepEqual(result.rejected, ['kubernetes', 'Staff Engineer']);
    assert.match(result.profile.skills, /^Python, SQL, Tableau, dbt, snowflake$/);
    assert.equal(profile.skills, 'Python, SQL, Tableau', 'the original profile is not mutated');
});

test('confirmed skills are capped', () => {
    const many = Array.from({ length: 80 }, (_, i) => `skill${i}`);
    const result = applyConfirmedSkills({ requested: many, job: JOB, profile });
    assert.ok(result.confirmed.length <= MAX_CONFIRMED);
});

test('confirming the missing skills lifts the ATS score honestly', async () => {
    const before = await optimizeForAts({ resumeText: RESUME, job: JOB, profile, target: 90 });
    const missing = before.best.ats.keywords.missing;
    assert.ok(missing.length >= 3, `expected missing skills, got ${missing}`);
    assert.ok(before.best.ats.ceiling < 90, 'without confirmation the honest ceiling is below the target');

    const stated = applyConfirmedSkills({ requested: missing, job: JOB, profile });
    const after = await optimizeForAts({ resumeText: RESUME, job: JOB, profile: stated.profile, target: 90 });
    assert.ok(after.best.ats.score >= before.best.ats.score + 15, `score ${before.best.ats.score} -> ${after.best.ats.score}`);
    assert.ok(after.best.ats.score >= 90 && after.reached);
    assert.equal(after.best.built.factCheck.ok, true, 'the fact gate still passes');
    assert.deepEqual(after.best.ats.keywords.missing, []);
});

test('a confirmed skill appears in Skills only, never in job history', async () => {
    const stated = applyConfirmedSkills({ requested: ['dbt', 'snowflake'], job: JOB, profile });
    const out = await optimizeForAts({ resumeText: RESUME, job: JOB, profile: stated.profile, target: 90 });
    const tailored = out.best.built.tailored;
    assert.ok(tailored.skills.map(s => s.toLowerCase()).includes('dbt'));
    const history = [...tailored.experience, ...tailored.projects].flatMap(entry => [...entry.header, ...entry.bullets]).join('\n').toLowerCase();
    assert.ok(!history.includes('dbt') && !history.includes('snowflake'), 'no bullet or role mentions a confirmed skill');
    assert.ok(!tailored.summary.toLowerCase().includes('snowflake'));
});
