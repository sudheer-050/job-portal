'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rememberedUsedFor } = require('./remembered');

const JOB = { title: 'Senior Data Analyst', description: 'Requirements:\n- SQL and Python\n- Hands-on Snowflake and dbt experience required\n- Airflow orchestration for data pipelines\nWe build reporting for finance and sales across the whole company every week.' };
const RESUME = 'Jordan Rivera\nSKILLS\nPython, SQL\nEXPERIENCE\nBuilt dashboards in Tableau';

test('only remembered skills the job asks for are reported', () => {
    const used = rememberedUsedFor({ remembered: ['dbt', 'Snowflake', 'kubernetes', 'rust'], job: JOB, resumeText: RESUME });
    assert.deepEqual(used.sort(), ['Snowflake', 'dbt']);
});

test('a skill the resume already shows is not reported as coming from memory', () => {
    const used = rememberedUsedFor({ remembered: ['sql', 'dbt'], job: JOB, resumeText: RESUME });
    assert.deepEqual(used, ['dbt']);
});

test('skills confirmed in this very request are reported separately', () => {
    const used = rememberedUsedFor({ remembered: ['dbt', 'airflow'], job: JOB, resumeText: RESUME, confirmedNow: ['DBT'] });
    assert.deepEqual(used, ['airflow']);
});

test('nothing remembered means nothing used', () => {
    assert.deepEqual(rememberedUsedFor({ job: JOB, resumeText: RESUME }), []);
});

const { acceptBulkSkills, visibleGaps } = require('./remembered');

test('skill gaps hide anything the resume or profile already shows', () => {
    const rows = [{ key: 'dbt', skill: 'dbt', jobs: 12 }, { key: 'sql', skill: 'SQL', jobs: 9 }, { key: 'airflow', skill: 'airflow', jobs: 4 }];
    const gaps = visibleGaps({ rows, resumeText: 'Wrote SQL pipelines', profileSkills: 'Airflow, Tableau' });
    assert.deepEqual(gaps, [{ skill: 'dbt', jobs: 12 }]);
});

test('a bulk confirmation only accepts skills that are real gaps for this person', () => {
    const allowed = new Map([['dbt', 'dbt'], ['snowflake', 'snowflake']]);
    const result = acceptBulkSkills({ requested: ['DBT', 'dbt', 'kubernetes', '  ', 'snowflake'], allowed });
    assert.deepEqual(result.accepted, ['dbt', 'snowflake']);
    assert.deepEqual(result.rejected, ['kubernetes']);
    assert.deepEqual(acceptBulkSkills({ requested: 'dbt', allowed }), { accepted: [], rejected: [] });
});

const { extractKeywords } = require('./keywords');

test('function words from other languages are never offered as skills', () => {
    const dutch = { title: 'Data Analist', description: 'Wij zijn een team dat werken en bouwen voor klanten, maar niet zonder SQL en Python. Je werkt met dbt voor onze klanten.' };
    const terms = extractKeywords(`${dutch.title}\n${dutch.description}`, { limit: 40 }).map(item => item.term);
    for (const word of ['voor', 'niet', 'maar', 'werken', 'zijn', 'bouwen']) assert.ok(!terms.includes(word), `${word} should not be a keyword`);
    for (const skill of ['sql', 'python', 'dbt']) assert.ok(terms.includes(skill), `${skill} should still be a keyword`);
});
