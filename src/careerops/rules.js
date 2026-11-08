'use strict';

// The resume rules recruiters and applicant tracking systems agree on, as code.
//
//  - applyResumeRules() fixes what can be fixed WITHOUT changing a single fact: it only removes or reorders
//    (a long summary is cut back to its best whole sentences, extra bullets and skills are dropped, filler sections go,
//    roles are put in reverse-chronological order). It never writes new words, so the fact check still holds.
//  - checkResumeRules() reports every rule, passed or not, with what to change when a rule needs the person's own words
//    (for example, adding a real number to a bullet).

const { paragraphLines } = require('../documents/export');
const { countTerm } = require('./keywords');

const LIMITS = {
    summaryLines: 4, summaryWords: 60, skillsMin: 6, skillsMax: 20,
    bulletsNewest: 5, bulletsOlder: 4, projectBullets: 3, bulletWords: 30, minWords: 200, maxWords: 700,
};

const ACTION_START = /^(?:[A-Z][a-z]+ed|Built|Led|Wrote|Ran|Drove|Made|Grew|Cut|Won|Taught|Chose|Began|Sold|Set|Held|Kept|Spoke|Oversaw|Undertook|Rebuilt|Rewrote|Redesigned|Developed|Delivered|Saved|Shipped|Launched|Drafted|Spearheaded|Managed|Created|Designed|Reduced|Increased|Improved|Automated|Analyzed|Analysed|Implemented|Streamlined)\b/;
const FIRST_PERSON = /\b(?:I|my|me|we|our)\b/;
const WEAK_PHRASES = [/\bresponsible for\b/i, /\bhelped (?:with|to)\b/i, /\bworked on\b/i, /\bduties (?:included|include)\b/i, /\bassisted (?:with|in)\b/i, /\bparticipated in\b/i, /\btasked with\b/i];
const CLICHES = ['results-driven', 'results driven', 'team player', 'hard-working', 'hardworking', 'detail-oriented', 'detail oriented', 'dynamic', 'go-getter', 'self-starter', 'think outside the box', 'synergy', 'passionate', 'motivated professional', 'proven track record'];
const FILLER_SECTION = /^(references?|objective|hobbies|interests|personal (?:details|information)|declaration)\b/i;
const PERSONAL_LINE = /\b(date of birth|dob|marital status|nationality|gender|religion|references? (?:available|on request|upon request)|photo)\b/i;
const STREET_ADDRESS = /\b\d{1,5}\s+[A-Za-z0-9.' -]+\s(?:street|st\.?|avenue|ave\.?|road|rd\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?)\b/i;

// The rules in plain words, for the people who write the resume and for the AI that drafts one.
const RULES_TEXT = [
    'One page.',
    'A summary of at most 4 lines (about 60 words), no "I" or "my", and no filler such as "results-driven" or "team player".',
    'Name, email and phone at the top, no street address, no photo, no date of birth or marital status.',
    'Standard headings in this order: Summary, Skills, Experience, Projects, Education, Certifications.',
    'Experience in reverse chronological order, a date range on every role.',
    'At most 5 bullets for each of the two newest roles and 4 for older ones, each bullet at most 2 lines.',
    'Every bullet starts with a strong past-tense action verb, never "I", "responsible for", "helped with" or "worked on".',
    'Show results: at least 40% of bullets contain a real number.',
    'A skills list of 6 to 20 relevant skills.',
    'No "References available upon request", objective statement or hobbies.',
];

const clone = value => JSON.parse(JSON.stringify(value));
const words = text => String(text || '').split(/\s+/).filter(Boolean).length;
const splitSentences = text => String(text || '').split(/(?<=[.!?])\s+/).map(part => part.trim()).filter(Boolean);
const bulletsOf = t => (t.experience || []).flatMap((entry, r) => entry.bullets.map(line => ({ line, role: entry.header[0] || 'A role', r })));

const summaryFits = text => paragraphLines(text) <= LIMITS.summaryLines && words(text) <= LIMITS.summaryWords;

/**
 * Cut a long summary back to what fits in four lines, using only the person's own words.
 * Whole sentences are kept, preferring the first and those that mention what the job asks for;
 * if no sentence fits on its own, the first one is cut at a clause break, then at a word.
 */
function trimSummary(summary, keywords = []) {
    const text = String(summary || '').trim();
    if (!text || summaryFits(text)) return { summary: text, trimmed: false };
    // A sentence with "I", "my" or a filler phrase breaks the summary rules, so it is kept only when nothing better fits.
    const breaksRules = sentence => FIRST_PERSON.test(sentence) || CLICHES.some(term => countTerm(sentence, term));
    const scored = splitSentences(text).map((sentence, index) => ({ sentence, index, score: (index === 0 ? 2 : 0) + keywords.filter(term => countTerm(sentence, term)).length - (breaksRules(sentence) ? 5 : 0) }));
    const order = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
    const chosen = [];
    for (const candidate of order) {
        const trial = [...chosen, candidate].sort((a, b) => a.index - b.index).map(item => item.sentence).join(' ');
        if (summaryFits(trial)) chosen.push(candidate);
    }
    if (chosen.length) return { summary: chosen.sort((a, b) => a.index - b.index).map(item => item.sentence).join(' '), trimmed: true };

    const first = scored[0] ? scored[0].sentence : text;
    const clauses = first.split(/(?<=[,;:])\s+/);
    let cut = '';
    for (const clause of clauses) {
        const trial = cut ? `${cut} ${clause}` : clause;
        if (!summaryFits(trial.replace(/[,;:]+$/, ''))) break;
        cut = trial;
    }
    if (!cut) {
        const parts = first.split(/\s+/);
        while (parts.length > 1 && !summaryFits(parts.join(' ').replace(/[,;:]+$/, ''))) parts.pop();
        cut = parts.join(' ');
    }
    return { summary: cut.replace(/[,;:]+$/, ''), trimmed: true };
}

// ---- roles in reverse chronological order ----
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const POINT = '(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+)?(?:19|20)\\d{2}';
const RANGE = new RegExp(`(${POINT})\\s*(?:[-\u2013\u2014]|to)\\s*(${POINT}|present|current|now)`, 'i');
// "March 2024" -> a number of months, so that "Mar 2024 - Jun 2024" sorts before "Aug 2023 - Feb 2024" but after "Feb 2021 - Jul 2023"
function months(point, endOfRange) {
    if (/^(present|current|now)$/i.test(point)) return 9999 * 12;
    const year = Number((point.match(/(?:19|20)\d{2}/) || [])[0]);
    const month = MONTHS[(point.match(/^[A-Za-z]{3}/) || [''])[0].toLowerCase()];
    return year * 12 + (month || (endOfRange ? 12 : 1));
}
function rangeOf(entry) {
    const match = RANGE.exec((entry.header || []).join(' '));
    if (!match) return null;
    return { start: months(match[1], false), end: months(match[2], true) };
}
function chronological(experience) {
    const ranges = experience.map(rangeOf);
    if (ranges.some(range => !range)) return null; // cannot tell: leave the order alone
    return experience.every((_entry, i) => i === 0 || ranges[i - 1].end > ranges[i].end || (ranges[i - 1].end === ranges[i].end && ranges[i - 1].start >= ranges[i].start));
}

/** Fix what can be fixed by removing or reordering. Returns the new resume and plain-language notes. */
function applyResumeRules(tailored, { keywords = [] } = {}) {
    const t = clone(tailored);
    const changes = [];

    if (t.summary && !t.summaryGenerated) {
        const { summary, trimmed } = trimSummary(t.summary, keywords);
        if (trimmed) { t.summary = summary; changes.push(`Cut your summary to ${paragraphLines(summary)} line${paragraphLines(summary) === 1 ? '' : 's'} (the limit is ${LIMITS.summaryLines}), keeping your own sentences that matter most for this job.`); }
    }

    const before = (t.other || []).reduce((sum, section) => sum + section.lines.length + 1, 0);
    t.other = (t.other || []).filter(section => !FILLER_SECTION.test(section.title)).map(section => ({ ...section, lines: section.lines.filter(line => !PERSONAL_LINE.test(line)) })).filter(section => section.lines.length);
    const after = t.other.reduce((sum, section) => sum + section.lines.length + 1, 0);
    if (after < before) changes.push('Left out filler a resume should not carry (references line, objective, hobbies or personal details).');

    if (t.skills.length > LIMITS.skillsMax) { changes.push(`Kept the ${LIMITS.skillsMax} most relevant skills (a longer list stops being read).`); t.skills = t.skills.slice(0, LIMITS.skillsMax); }

    let capped = 0;
    let cappedProjects = 0;
    t.experience.forEach((entry, r) => {
        const cap = r < 2 ? LIMITS.bulletsNewest : LIMITS.bulletsOlder;
        if (entry.bullets.length > cap) { capped += entry.bullets.length - cap; entry.bullets = entry.bullets.slice(0, cap); }
    });
    (t.projects || []).forEach(entry => { if (entry.bullets.length > LIMITS.projectBullets) { cappedProjects += entry.bullets.length - LIMITS.projectBullets; entry.bullets = entry.bullets.slice(0, LIMITS.projectBullets); } });
    if (capped) changes.push(`Kept at most ${LIMITS.bulletsNewest} bullets for the two newest roles and ${LIMITS.bulletsOlder} for older ones; ${capped} lower-relevance bullet${capped === 1 ? ' was' : 's were'} left out.`);

    if (cappedProjects) changes.push(`Kept at most ${LIMITS.projectBullets} bullets for each project.`);

    if (t.experience.length > 1 && chronological(t.experience) === false) {
        const ranges = new Map(t.experience.map(entry => [entry, rangeOf(entry)]));
        t.experience = [...t.experience].sort((a, b) => ranges.get(b).end - ranges.get(a).end || ranges.get(b).start - ranges.get(a).start);
        changes.push('Put your roles in reverse chronological order (newest first).');
    }
    return { tailored: t, changes };
}

/** Every rule, with whether the resume follows it, and what to change when it does not. */
function checkResumeRules(tailored, { pages = null } = {}) {
    const t = tailored;
    const items = [];
    const add = (id, title, ok, detail, fix = '', lines = []) => items.push({ id, title, ok: Boolean(ok), detail, fix: ok ? '' : fix, lines: ok ? [] : lines.slice(0, 3) });
    const bullets = bulletsOf(t);
    const all = [...bullets, ...(t.projects || []).flatMap(entry => entry.bullets.map(line => ({ line, role: entry.header[0] || 'A project', r: 99 })))];

    if (pages !== null) add('one-page', 'One page', pages <= 1, pages <= 1 ? 'Fits on one page.' : `${pages} pages.`, 'Shorten the header, contact or education lines in your source resume.');

    const summaryLines = t.summary ? paragraphLines(t.summary) : 0;
    const summaryWords = words(t.summary);
    add('summary-length', `Summary of at most ${LIMITS.summaryLines} lines`, !t.summary || (summaryLines <= LIMITS.summaryLines && summaryWords <= LIMITS.summaryWords),
        t.summary ? `${summaryLines} line${summaryLines === 1 ? '' : 's'}, ${summaryWords} words.` : 'No summary.',
        `Shorten your summary to ${LIMITS.summaryLines} lines or fewer (about ${LIMITS.summaryWords} words).`);
    const buzz = CLICHES.filter(term => countTerm(t.summary || '', term));
    add('summary-voice', 'Summary in a professional voice', !FIRST_PERSON.test(t.summary || '') && !buzz.length,
        buzz.length ? `Filler words: ${buzz.join(', ')}.` : FIRST_PERSON.test(t.summary || '') ? 'Uses “I” or “my”.' : 'No first person, no filler.',
        'Write the summary without “I” or “my”, and replace filler such as “results-driven” with something you did.');

    const contact = t.contact || {};
    add('contact', 'Name, email and phone at the top', Boolean(t.name && contact.email && contact.phone),
        [t.name ? '' : 'name', contact.email ? '' : 'email', contact.phone ? '' : 'phone'].filter(Boolean).length ? `Missing: ${[t.name ? '' : 'name', contact.email ? '' : 'email', contact.phone ? '' : 'phone'].filter(Boolean).join(', ')}.` : 'All present.',
        'Add the missing details at the top of your resume (a phone number can be set on the Profile page).');
    const headerText = [t.name, ...Object.values(contact).flat()].filter(Boolean).join(' ');
    add('no-address', 'No street address', !STREET_ADDRESS.test(headerText), STREET_ADDRESS.test(headerText) ? 'A street address is shown.' : 'City and state only.', 'Show only your city and state.');

    add('sections', 'Standard sections', t.experience.length > 0 && t.education.length > 0, `${t.experience.length ? 'Experience' : 'No experience'}, ${t.education.length ? 'Education' : 'no education'}.`, 'Use headings such as “Experience” and “Education”.');
    add('chronological', 'Roles newest first', chronological(t.experience) !== false, 'Reverse chronological order.', 'Order your roles from newest to oldest.');
    const undated = t.experience.filter(entry => !rangeOf(entry) && !/(?:19|20)\d{2}/.test(entry.header.join(' ')));
    add('dated', 'A date range on every role', undated.length === 0, undated.length ? `${undated.length} role${undated.length === 1 ? ' has' : 's have'} no dates.` : 'Every role is dated.', 'Give every role a date range such as “2022 – Present”.', undated.map(entry => entry.header[0]));

    const overCap = t.experience.filter((entry, r) => entry.bullets.length > (r < 2 ? LIMITS.bulletsNewest : LIMITS.bulletsOlder));
    add('bullet-count', `At most ${LIMITS.bulletsNewest} bullets per recent role, ${LIMITS.bulletsOlder} per older one`, overCap.length === 0, overCap.length ? `${overCap.length} role${overCap.length === 1 ? ' has' : 's have'} too many.` : 'Within the limits.', 'Keep only the strongest bullets for each role.');
    const longBullets = all.filter(item => words(item.line) > LIMITS.bulletWords);
    add('bullet-length', 'Each bullet at most 2 lines', longBullets.length === 0, longBullets.length ? `${longBullets.length} bullet${longBullets.length === 1 ? ' is' : 's are'} longer than ${LIMITS.bulletWords} words.` : 'All short enough.', `Cut these bullets to under ${LIMITS.bulletWords} words, keeping the result.`, longBullets.map(item => item.line.slice(0, 140)));
    const noVerb = all.filter(item => !ACTION_START.test(item.line));
    add('action-verbs', 'Bullets start with an action verb', all.length === 0 || noVerb.length / all.length <= 0.2, noVerb.length ? `${noVerb.length} of ${all.length} do not.` : 'All do.', 'Start each bullet with a past-tense verb such as Built, Reduced, Automated or Led.', noVerb.map(item => item.line.slice(0, 140)));
    const person = all.filter(item => FIRST_PERSON.test(item.line));
    add('no-first-person', 'No “I”, “my” or “we” in bullets', person.length === 0, person.length ? `${person.length} bullet${person.length === 1 ? '' : 's'}.` : 'None.', 'Remove “I”, “my” and “we”: start with the verb.', person.map(item => item.line.slice(0, 140)));
    const weak = all.filter(item => WEAK_PHRASES.some(pattern => pattern.test(item.line)));
    add('no-weak-phrases', 'No “responsible for” or “helped with”', weak.length === 0, weak.length ? `${weak.length} bullet${weak.length === 1 ? '' : 's'}.` : 'None.', 'Say what you did and what changed: “Built …”, “Reduced …”.', weak.map(item => item.line.slice(0, 140)));
    const withNumber = all.filter(item => /[0-9]/.test(item.line));
    add('numbers', 'Results with real numbers (40% of bullets)', all.length === 0 || withNumber.length / all.length >= 0.4, `${withNumber.length} of ${all.length} bullets have a number.`, 'Where it is true, add the real number, percentage or time saved.', all.filter(item => !/[0-9]/.test(item.line)).map(item => item.line.slice(0, 140)));
    const repeats = t.experience.filter(entry => { const counts = {}; entry.bullets.forEach(line => { const first = (line.split(/\s+/)[0] || '').toLowerCase(); counts[first] = (counts[first] || 0) + 1; }); return Object.values(counts).some(n => n > 2); });
    add('varied-verbs', 'Varied opening verbs', repeats.length === 0, repeats.length ? 'A role repeats the same opening word three times.' : 'Varied.', 'Vary the opening verbs within a role.', repeats.map(entry => entry.header[0]));

    add('skills', `A skills list of ${LIMITS.skillsMin} to ${LIMITS.skillsMax}`, t.skills.length >= LIMITS.skillsMin && t.skills.length <= LIMITS.skillsMax, `${t.skills.length} skills.`, t.skills.length < LIMITS.skillsMin ? 'List at least 6 relevant skills.' : `Keep the ${LIMITS.skillsMax} most relevant skills.`);
    const filler = (t.other || []).filter(section => FILLER_SECTION.test(section.title));
    add('no-filler', 'No references line, objective or hobbies', filler.length === 0, filler.length ? filler.map(section => section.title).join(', ') : 'None.', 'Remove these sections.');
    const total = words([t.name, t.summary, t.skills.join(' '), ...[...t.experience, ...(t.projects || [])].flatMap(entry => [...entry.header, ...entry.bullets]), ...t.education, ...(t.certifications || [])].join(' '));
    add('length', `${LIMITS.minWords} to ${LIMITS.maxWords} words`, total >= LIMITS.minWords && total <= LIMITS.maxWords, `${total} words.`, total < LIMITS.minWords ? 'Add real detail to your source resume.' : 'Leave out older or less relevant content.');

    return { passed: items.filter(item => item.ok).length, total: items.length, items };
}

module.exports = { LIMITS, RULES_TEXT, applyResumeRules, checkResumeRules, trimSummary };
