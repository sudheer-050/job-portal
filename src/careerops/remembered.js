'use strict';

// Skills a person confirmed on an earlier job are remembered and reused automatically. This helper
// says which of them a given job actually leans on, so the result can show "used from your memory".

const { countTerm, extractKeywords } = require('./keywords');

/**
 * Remembered skills that this job asks for and that the source resume does not already show,
 * excluding any confirmed right now (those are reported separately).
 */
function rememberedUsedFor({ remembered = [], job = {}, resumeText = '', confirmedNow = [] }) {
    const wanted = new Set(extractKeywords(`${job.title || ''}\n${job.description || ''}`, { limit: 40 }).map(item => item.term.toLowerCase()));
    const justNow = new Set(confirmedNow.map(name => name.toLowerCase()));
    return remembered.filter(name => {
        const key = String(name).toLowerCase();
        return wanted.has(key) && !justNow.has(key) && !countTerm(resumeText, key);
    });
}

/**
 * Skills many of the person's jobs ask for that neither their resume nor their profile shows.
 * `rows` are aggregated {key, skill, jobs}; old evaluations may still list a skill that has since been added.
 */
function visibleGaps({ rows = [], resumeText = '', profileSkills = '' }) {
    const have = `${resumeText}\n${profileSkills}`;
    return rows.filter(row => row.key && !countTerm(have, row.key)).map(row => ({ skill: row.skill, jobs: row.jobs }));
}

/** Split a bulk request into the skills that really are gaps for this person and the ones that are not. */
function acceptBulkSkills({ requested, allowed }) {
    const accepted = [];
    const rejected = [];
    for (const raw of Array.isArray(requested) ? requested.slice(0, 80) : []) {
        const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!name) continue;
        const skill = allowed.get(name.toLowerCase());
        if (!skill) rejected.push(name);
        else if (!accepted.includes(skill)) accepted.push(skill);
    }
    return { accepted: accepted.slice(0, 40), rejected };
}

module.exports = { acceptBulkSkills, rememberedUsedFor, visibleGaps };
