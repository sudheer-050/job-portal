'use strict';

const { countTerm, extractKeywords } = require('./keywords');

function isListLike(line) {
    const parts = line.split(/\s*[,|;•·]\s*/);
    return parts.length >= 3 && parts.every(part => part.split(/\s+/).length <= 3);
}
const isContactLine = line => /@|linkedin\.com|github\.com|\(\d{3}\)|\d{3}[-.\s]\d{3}[-.\s]\d{4}/i.test(line);

// For each important job keyword, find a resume line that already evidences it. Lines are returned
// verbatim so downstream drafts never contain unsupported claims. Skills lists and contact lines
// are skipped, and a line is never reused for a second keyword.
function requirementEvidence(resumeText, job = {}, limit = 6) {
    const lines = String(resumeText || '').split(/\r?\n/)
        .map(line => line.replace(/^\s*[-*•·▪–—]\s+/, '').trim())
        .filter(line => line.length > 25 && line.length < 260 && !isListLike(line) && !isContactLine(line));
    const used = new Set();
    const results = [];
    for (const { term } of extractKeywords(`${job.title || ''}\n${job.description || ''}`, { limit: 30 })) {
        const line = lines.find(candidate => !used.has(candidate) && countTerm(candidate, term));
        if (!line) continue;
        used.add(line);
        results.push({ requirement: term, status: 'match', evidence: line });
        if (results.length >= limit) break;
    }
    return results;
}

module.exports = { requirementEvidence };
