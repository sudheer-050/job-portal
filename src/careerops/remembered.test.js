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
