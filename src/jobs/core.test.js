'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalizeUrl, normalizeJob, rankJobs, scoreJob } = require('./core');

test('normalizeJob rejects incomplete postings and cleans HTML', () => {
    assert.equal(normalizeJob({ title: 'Engineer' }), null);
    const job = normalizeJob({ source: 'Greenhouse', id: 42, title: ' Data Engineer ', company: 'Acme', location: 'Remote', description: '<p>Build &amp; ship</p>', applyUrl: 'https://example.com/job/42?utm_source=x' });
    assert.equal(job.id, 'greenhouse:42');
    assert.equal(job.description, 'Build & ship');
    assert.equal(job.workplaceType, 'remote');
});
test('canonicalizeUrl removes tracking parameters', () => {
    assert.equal(canonicalizeUrl('https://EXAMPLE.com/jobs/1/?utm_source=test&x=2#top'), 'https://example.com/jobs/1?x=2');
});

test('ranking favors the requested title and returns explanations', () => {
    const preference = { role: 'Solutions Engineer', location: 'Chicago', remote_pref: 'hybrid' };
    const exact = normalizeJob({ source: 'lever', id: '1', title: 'Senior Solutions Engineer', company: 'Acme', location: 'Chicago, IL', workplaceType: 'hybrid', description: 'Customer solutions, APIs and cloud integrations', applyUrl: 'https://jobs.example/1', postedAt: new Date().toISOString() });
    const unrelated = normalizeJob({ source: 'lever', id: '2', title: 'Payroll Specialist', company: 'Acme', location: 'Chicago, IL', workplaceType: 'hybrid', description: 'Payroll operations', applyUrl: 'https://jobs.example/2' });
    const ranked = rankJobs([preference], 'APIs cloud customer architecture', [unrelated, exact]);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].id, exact.id);
    assert.ok(ranked[0].matchReasons.length >= 2);
});

test('missing salary data is neutral rather than a false perfect match', () => {
    const job = normalizeJob({ source: 'ashby', id: '1', title: 'Data Scientist', applyUrl: 'https://example.com/1', location: 'Remote', remote: true });
    const result = scoreJob({ role: 'Data Scientist', salary_min: 200000, remote_pref: 'remote' }, '', job);
    assert.ok(result.score < 100);
    assert.ok(result.score > 50);
});
