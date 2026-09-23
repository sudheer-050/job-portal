'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    canonicalizeUrl, detectEducationRequirement, detectEmploymentType,
    detectMinimumExperience, detectSponsorship, normalizeJob, rankJobs, scoreJob,
} = require('./core');

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

test('selected locations exclude otherwise relevant jobs in other cities', () => {
    const preferences = [
        { role: 'Solutions Engineer', location: 'Chicago, IL', remote_pref: 'any' },
        { role: 'Solutions Engineer', location: 'Austin', remote_pref: 'any' },
    ];
    const chicago = normalizeJob({ source: 'lever', id: 'chi', title: 'Solutions Engineer', location: 'Chicago, IL', applyUrl: 'https://example.com/chi' });
    const paris = normalizeJob({ source: 'lever', id: 'paris', title: 'Solutions Engineer', location: 'Paris, France', applyUrl: 'https://example.com/paris' });
    const ranked = rankJobs(preferences, '', [paris, chicago]);
    assert.deepEqual(ranked.map(job => job.id), [chicago.id]);
});

test('missing salary data is neutral rather than a false perfect match', () => {
    const job = normalizeJob({ source: 'ashby', id: '1', title: 'Data Scientist', applyUrl: 'https://example.com/1', location: 'Remote', remote: true });
    const result = scoreJob({ role: 'Data Scientist', salary_min: 200000, remote_pref: 'remote' }, '', job);
    assert.ok(result.score < 100);
    assert.ok(result.score > 50);
});

test('extracts structured expectations from job descriptions and metadata', () => {
    assert.equal(detectMinimumExperience('Requires 4+ years of customer-facing experience.'), 4);
    assert.equal(detectEducationRequirement("Bachelor's degree or equivalent experience"), 'bachelor');
    assert.equal(detectSponsorship('Candidates must be authorized without sponsorship.'), 'unavailable');
    assert.equal(detectEmploymentType({ title: 'Engineer', metadata: { employmentType: 'FullTime' } }), 'full_time');
});

test('experience, education, employment type, and sponsorship affect ranking', () => {
    const preference = {
        role: 'Solutions Engineer', location: 'Chicago', remote_pref: 'hybrid', salary_min: 100000,
        experience_years: 4, education_level: 'bachelor', employment_type: 'full_time', sponsorship: 'required',
    };
    const matching = normalizeJob({
        source: 'ashby', id: 'match', title: 'Solutions Engineer', company: 'Acme', location: 'Chicago',
        workplaceType: 'hybrid', salaryMax: 150000, postedAt: new Date().toISOString(),
        description: "3+ years experience. Bachelor's degree. Visa sponsorship is available.",
        metadata: { employmentType: 'FullTime' }, applyUrl: 'https://example.com/match',
    });
    const mismatch = normalizeJob({
        source: 'ashby', id: 'mismatch', title: 'Solutions Engineer', company: 'Other', location: 'Chicago',
        workplaceType: 'hybrid', salaryMax: 150000, postedAt: new Date().toISOString(),
        description: '10+ years experience. Doctorate required. We are unable to sponsor visas.',
        metadata: { employmentType: 'Contract' }, applyUrl: 'https://example.com/mismatch',
    });
    const ranked = rankJobs([preference], '', [mismatch, matching]);
    assert.equal(ranked[0].id, matching.id);
    assert.ok(ranked[0].matchScore > ranked[1].matchScore);
    assert.ok(ranked[0].matchReasons.includes('Employment type matched'));
});
