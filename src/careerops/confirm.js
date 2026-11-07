'use strict';

// Skills the user states they have. The optimiser can only use what the resume or profile evidences,
// so a keyword the job asks for but the resume lacks stays out unless the person says it is true.
// Their statement is the evidence: it goes into the Skills list only (never into job history or
// bullets), only for keywords this job actually asks for, and only when they explicitly ask for it.

const { extractKeywords } = require('./keywords');
const { mergeSkills } = require('../profile/sources');

const MAX_CONFIRMED = 15;

/**
 * @param {{requested: unknown, job: object, profile: object}} input
 * @returns {{profile: object, confirmed: string[], rejected: string[], skipped: string[]}}
 */
function applyConfirmedSkills({ requested, job, profile = {} }) {
    if (!Array.isArray(requested) || !requested.length) return { profile, confirmed: [], rejected: [], skipped: [] };
    const allowed = new Map(extractKeywords(`${job.title || ''}\n${job.description || ''}`, { limit: 40 }).map(item => [item.term.toLowerCase(), item.term]));
    const confirmed = [];
    const rejected = [];
    for (const raw of requested.slice(0, MAX_CONFIRMED + 20)) {
        const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!name) continue;
        const term = allowed.get(name.toLowerCase());
        if (!term) { rejected.push(name); continue; }
        if (!confirmed.includes(term)) confirmed.push(term);
    }
    const limited = confirmed.slice(0, MAX_CONFIRMED);
    const merged = mergeSkills(profile.skills, limited, 100000);
    return { profile: { ...profile, skills: merged.skills }, confirmed: limited, rejected, skipped: merged.skipped };
}

module.exports = { MAX_CONFIRMED, applyConfirmedSkills };
