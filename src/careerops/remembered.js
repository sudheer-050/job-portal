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

module.exports = { rememberedUsedFor };
