'use strict';

// What recruiters and hiring managers say makes a resume and a cover letter get read, as code.
//
// Everything here only chooses, orders, emphasises or compresses what the person's own resume says. Nothing is invented:
// a headline is made of words the resume evidences, a number is only ever bolded, an older role is shown as the line the
// resume already has, and a cover letter quotes the resume's own lines. So the fact check still holds.

const { paragraphLines, pageCount } = require('../documents/export');
const { KNOWN_TERMS, SKILL_PHRASES, countTerm } = require('./keywords');

const LEVEL_WORDS = new Set(['senior', 'junior', 'lead', 'staff', 'principal', 'sr', 'jr', 'associate', 'head', 'chief', 'intern', 'i', 'ii', 'iii', 'iv']);

// ---------------------------------------------------------------------------------------------
// A headline under the name: the role the resume is for, then the skill areas that matter for it
// ---------------------------------------------------------------------------------------------

const titleCase = text => text.replace(/\b([a-z])/g, (_all, letter) => letter.toUpperCase());

/** The form the resume itself uses for a term ("Power BI", "SQL"), so the headline reads like the resume. */
function displayForm(term, text) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = String(text || '').match(new RegExp(`(?<![A-Za-z0-9+#])${escaped}(?![A-Za-z0-9+#])`, 'i'));
    return found ? found[0] : titleCase(term);
}

/** The person's own most recent job title ("Data Analytics Intern" from "Data Analytics Intern | Unified Mentor"). */
function newestTitle(experience) {
    const heading = (experience[0] && experience[0].header[0]) || '';
    const parts = heading.split(/\s+[|—–]\s+|,\s+/);
    // "Company — Location" style headings have no title on the first line
    return parts.length > 1 && !/\b\d{4}\b/.test(parts[0]) && !/\b(inc|llc|ltd|limited|corp|company)\b/i.test(parts[0]) ? parts[0].trim() : '';
}

/**
 * "Data Analyst | SQL | Python | Power BI": the target role, then up to three skills the job asks for.
 * The role is the job's title only when the resume itself contains that exact title; otherwise it is the person's own
 * newest title. Every skill is one the resume evidences. Returns '' when it cannot say anything true.
 */
function headlineFor({ job = {}, experience = [], evidenceText = '', keywords = [] }) {
    const words = String(job.title || '').replace(/[()|,/–—-]+/g, ' ').split(/\s+/).filter(Boolean);
    const role = words.filter(word => !LEVEL_WORDS.has(word.toLowerCase()) && word.length > 1).join(' ');
    const roleEvidenced = role && countTerm(evidenceText, role) > 0;
    const heading = roleEvidenced ? titleCase(role) : newestTitle(experience);
    const taken = new Set(String(heading).toLowerCase().split(/\s+/));
    const preferred = keywords.filter(item => KNOWN_TERMS.has(item.term) || SKILL_PHRASES.includes(item.term));
    const skills = [];
    for (const { term } of [...preferred, ...keywords.filter(item => !preferred.includes(item))]) {
        if (skills.length >= 3) break;
        if (!countTerm(evidenceText, term) || taken.has(term.toLowerCase()) || term.length < 2) continue;
        const shown = displayForm(term, evidenceText);
        if (skills.some(existing => existing.toLowerCase() === shown.toLowerCase())) continue;
        skills.push(shown);
    }
    const parts = [heading, ...skills].filter(Boolean);
    return parts.length >= 2 ? parts.join(' | ').slice(0, 110) : '';
}

/** A headline is true when every part of it is wording from the resume (a part that is not is a fabrication). */
function headlineIsEvidenced(headline, evidenceText) {
    return String(headline || '').split(' | ').every(part => !part.trim() || countTerm(evidenceText, part.trim()) > 0);
}

// ---------------------------------------------------------------------------------------------
// Numbers stand out: bold the key metrics
// ---------------------------------------------------------------------------------------------

// $12M, 87%, 8+, 1M+, 100K, 3x, "45 minutes", "8 hours". A bare year (2024) and ordinary counts are not metrics.
const METRIC = /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:[KMB]\b|million\b|billion\b|thousand\b)?\+?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|\+|x\b|X\b)|\b\d[\d,]*(?:\.\d+)?[KMB]\+?(?=\W|$)|\b\d[\d,]*(?:\.\d+)?\s(?:hours?|minutes?|mins?|days?|weeks?|months?)\b/g;

/** Wrap the key numbers of a line in **bold** (at most three; a line that is already bold is left alone). */
function boldMetrics(text) {
    const line = String(text || '');
    if (line.includes('**')) return line;
    let count = 0;
    return line.replace(METRIC, match => (count++ < 3 ? `**${match.trim()}**${/\s$/.test(match) ? ' ' : ''}` : match));
}

// ---------------------------------------------------------------------------------------------
// Older roles in one line
// ---------------------------------------------------------------------------------------------

const POINT = '(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+)?(?:19|20)\\d{2}';
const RANGE = new RegExp(`(${POINT}\\s*(?:[-\\u2013\\u2014]|to)\\s*(?:${POINT}|present|current|now))`, 'i');

/** The date range in a header line ("February 2021 – July 2023"), or ''. */
function earlierDates(line) { return (RANGE.exec(String(line || '')) || [])[1] || ''; }

/**
 * Bullets that carry no number. Never filled in for the person: each becomes a question, "[ADD METRIC] ...", asking for a
 * figure only they know (how many, how much, how often, how long). The most recent roles come first.
 */
function metricGaps(tailored, limit = 5) {
    const out = [];
    for (const [r, entry] of (tailored.experience || []).entries()) {
        for (const bullet of entry.bullets) {
            if (/\d/.test(bullet)) continue;
            out.push({ role: (entry.header[0] || '').slice(0, 80), line: bullet, prompt: `[ADD METRIC] ${bullet.length > 110 ? `${bullet.slice(0, 107)}...` : bullet} — how many, how much, how often or how long? Add it only if it is true.`, recent: r });
        }
    }
    return out.sort((a, b) => a.recent - b.recent).slice(0, limit).map(({ role, line, prompt }) => ({ role, line, prompt }));
}

/** "Junior Engineer | Hetero Labs Limited (February 2021 – July 2023)": the role's own words, in one line. */
function earlierLine(entry) {
    const title = (entry.header && entry.header[0]) || '';
    if (!title) return '';
    const dates = (RANGE.exec((entry.header || []).join(' ')) || [])[1];
    return dates && !title.includes(dates) ? `${title} (${dates})` : title;
}

// ---------------------------------------------------------------------------------------------
// The cover letter
// ---------------------------------------------------------------------------------------------

const LETTER_CLICHES = [/\bi am writing to apply\b/i, /\bi'?m writing to apply\b/i, /\bi am (?:very |truly )?passionate\b/i, /\bteam player\b/i, /\bhard[- ]working\b/i, /\bresults[- ]driven\b/i, /\bdynamic\b/i, /\bgo-getter\b/i, /\bsynergy\b/i, /\bto whom it may concern\b/i];
const LETTER_LIMITS = { words: 250, achievements: 3 };

const wordCount = text => String(text || '').split(/\s+/).filter(Boolean).length;

/** Evidence lines for the letter: the ones with real numbers first, then the ones that match the job best. */
function pickAchievements(evidence) {
    const seen = new Set();
    return evidence
        .filter(item => item && item.evidence && !seen.has(item.evidence) && seen.add(item.evidence))
        .map((item, index) => ({ item, index, hasNumber: /\d/.test(item.evidence) ? 1 : 0 }))
        .sort((a, b) => b.hasNumber - a.hasNumber || a.index - b.index)
        .slice(0, LETTER_LIMITS.achievements)
        .map(entry => entry.item);
}

/** Every rule for a cover letter, passed or not. */
function checkCoverLetter(text, { title = '', company = '', name = '' } = {}) {
    const body = String(text || '');
    const paragraphs = body.split(/\n{2,}/).map(part => part.trim()).filter(Boolean);
    const opening = paragraphs[1] || '';
    const words = wordCount(body);
    const items = [];
    const add = (id, label, ok, detail, fix = '') => items.push({ id, title: label, ok: Boolean(ok), detail, fix: ok ? '' : fix });

    add('opens-with-role', 'Opens with the role and the company', Boolean(opening) && (!title || countTerm(opening, title) > 0) && (!company || countTerm(opening, company) > 0) && !LETTER_CLICHES[0].test(opening) && !LETTER_CLICHES[1].test(opening),
        'The first paragraph names the role and the company, without “I am writing to apply”.', 'Start with the role and the company, then your strongest match.');
    add('length', `At most ${LETTER_LIMITS.words} words`, words <= LETTER_LIMITS.words, `${words} words.`, 'Cut it to three short paragraphs.');
    add('one-page', 'One page', pageCount(body) <= 1, pageCount(body) <= 1 ? 'Fits on one page.' : `${pageCount(body)} pages.`, 'Shorten it.');
    const bullets = body.split('\n').filter(line => /^\s*[•-]\s/.test(line));
    add('achievements', 'Your best results, matched to the job', bullets.length >= 1 && bullets.length <= LETTER_LIMITS.achievements, `${bullets.length} result${bullets.length === 1 ? '' : 's'} quoted from your resume.`, 'Quote one to three results from your resume that match what the job asks for.');
    add('numbers', 'At least one real number', bullets.some(line => /\d/.test(line)) || /\d/.test(body.replace(/\d{4}/g, '')), 'A number backs up a claim.', 'Quote a result that has a real number.');
    const clichés = LETTER_CLICHES.filter(pattern => pattern.test(body));
    add('no-filler', 'No filler phrases', clichés.length === 0, clichés.length ? 'Contains filler such as “I am writing to apply” or “team player”.' : 'None.', 'Replace filler with something you did.');
    add('salutation', 'A named greeting and a sign-off', /^dear\s+\S/i.test(body.trim()) && (!name || body.trim().endsWith(name) || /\n\S+/.test(body.trim().split('\n').slice(-2).join('\n'))), 'Greeting and name present.', 'Start with “Dear … team,” and end with your name.');
    add('next-step', 'Ends with a clear next step', /(welcome|happy to|glad to|look forward to)[^.]*\b(conversation|talk|discuss|chat|call|interview)\b/i.test(body), 'Ends by asking for a conversation.', 'End by asking for a short conversation.');
    return { passed: items.filter(item => item.ok).length, total: items.length, items };
}

// ---------------------------------------------------------------------------------------------
// A recruiter's verdict: shortlist, maybe or reject
// ---------------------------------------------------------------------------------------------

/** Deterministic and explained: the same inputs always give the same answer, and each reason is a fact about the application. */
function recruiterVerdict({ fit = 0, ats = 0, resumeRules = null, letterRules = null, blockers = [], legitimacy = '' }) {
    const reasons = [];
    const fixes = [];
    const rulesRatio = resumeRules && resumeRules.total ? resumeRules.passed / resumeRules.total : 1;
    const letterRatio = letterRules && letterRules.total ? letterRules.passed / letterRules.total : 1;
    if (fit >= 4) reasons.push(`Strong job fit (${fit.toFixed(1)}/5).`); else if (fit >= 3.3) reasons.push(`Reasonable job fit (${fit.toFixed(1)}/5).`); else reasons.push(`Weak job fit (${fit.toFixed(1)}/5).`);
    if (ats >= 85) reasons.push(`Resume reads well to an applicant tracking system (${ats}/100).`); else if (ats >= 70) reasons.push(`Resume is readable but could match more of the job's keywords (${ats}/100).`); else reasons.push(`Resume matches too few of the job's keywords (${ats}/100).`);
    if (resumeRules) reasons.push(`${resumeRules.passed} of ${resumeRules.total} resume rules followed.`);
    for (const blocker of blockers.slice(0, 2)) reasons.push(blocker);
    if (resumeRules) for (const item of resumeRules.items.filter(rule => !rule.ok && rule.fix).slice(0, 3)) fixes.push(item.fix);
    if (letterRules) for (const item of letterRules.items.filter(rule => !rule.ok && rule.fix).slice(0, 2)) fixes.push(`Cover letter: ${item.fix}`);

    let verdict = 'Maybe';
    if (blockers.length || legitimacy === 'Suspicious' || fit < 3) verdict = 'Reject';
    else if (fit >= 4 && ats >= 80 && rulesRatio >= 0.85 && letterRatio >= 0.75) verdict = 'Shortlist';
    return { verdict, reasons, fixes };
}

module.exports = {
    LETTER_CLICHES, LETTER_LIMITS, boldMetrics, checkCoverLetter, displayForm, earlierDates, earlierLine, metricGaps, headlineFor, headlineIsEvidenced, newestTitle, paragraphLines, pickAchievements, recruiterVerdict, wordCount,
};
