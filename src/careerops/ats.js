'use strict';

// ATS-readiness score (an estimate: real applicant tracking systems differ) plus an optimiser that
// improves the resume in rounds until it reaches the target — using only changes that stay true.
// It never adds a keyword the candidate cannot evidence. If the honest maximum is below the target
// it stops there and says what is blocking.

const { countTerm, extractKeywords } = require('./keywords');
const { DATE_RANGE, tailorResume } = require('./resume');
const { describeRemoval, fitToPages } = require('./onepage');
const { applyResumeRules, checkResumeRules } = require('./rules');

const LEVEL_WORDS = new Set(['senior', 'junior', 'lead', 'staff', 'principal', 'sr', 'jr', 'associate', 'head', 'chief', 'intern', 'i', 'ii', 'iii', 'iv']);
const ACTION_START = /^(?:[A-Z][a-z]+ed|Built|Led|Wrote|Ran|Drove|Made|Grew|Cut|Won|Taught|Led|Led|Chose|Began|Sold|Set|Held|Kept|Spoke|Oversaw|Undertook|Rebuilt|Rewrote|Redesigned|Developed|Delivered|Saved|Shipped|Launched)\b/;
const FIRST_PERSON = /\b(?:I|my|me|we|our)\b/;

function plainText(t) {
    return [t.name, t.headline, ...Object.values(t.contact || {}).flat(), t.summary, t.skills.join(', '), ...(t.earlier || []),
        ...[...t.experience, ...t.projects].flatMap(entry => [...entry.header, ...entry.bullets]),
        ...t.education, ...t.certifications, ...t.other.flatMap(section => [section.title, ...section.lines])].filter(Boolean).join('\n');
}

const round1 = value => Math.round(value * 10) / 10;

function scoreAts({ tailored, job = {}, candidateText = '' }) {
    const text = plainText(tailored);
    const roles = [...tailored.experience];
    const bullets = roles.flatMap(entry => entry.bullets);
    const breakdown = [];
    const issues = [];
    const add = (group, label, points, max, detail, issue) => {
        breakdown.push({ group, label, points: round1(points), max, detail });
        if (issue && points < max) issues.push(issue);
    };

    // 1. Parseable structure (25)
    add('Structure', 'Name', tailored.name ? 2 : 0, 2, tailored.name || 'Not found', { severity: 'high', text: 'No name detected at the top of your resume.', fix: 'Put your full name on the first line of your resume.' });
    add('Structure', 'Email', tailored.contact.email ? 3 : 0, 3, tailored.contact.email || 'Not found', { severity: 'high', text: 'No email address detected.', fix: 'Add your email to the top of your resume.' });
    add('Structure', 'Phone', tailored.contact.phone ? 2 : 0, 2, tailored.contact.phone || 'Not found', { severity: 'medium', text: 'No phone number detected.', fix: 'Add your phone number on the Profile page (Application identity).' });
    add('Structure', 'Experience section', roles.length ? 6 : 0, 6, roles.length ? `${roles.length} role(s)` : 'Not found', { severity: 'high', text: 'No Experience section was detected, so parsers will see little work history.', fix: 'Use a heading such as “Experience” or “Work Experience” above your jobs.' });
    add('Structure', 'Education section', tailored.education.length ? 4 : 0, 4, tailored.education.length ? 'Found' : 'Not found', { severity: 'medium', text: 'No Education section detected.', fix: 'Add an “Education” heading with your school and degree.' });
    add('Structure', 'Skills section', tailored.skills.length >= 3 ? 4 : tailored.skills.length ? 2 : 0, 4, `${tailored.skills.length} skill(s)`, { severity: 'medium', text: 'Few or no skills listed in a Skills section.', fix: 'Add a “Skills” heading, or list your key skills on the Profile page.' });
    const dated = roles.filter(entry => entry.header.some(line => DATE_RANGE.test(line))).length;
    add('Structure', 'Dates on every role', roles.length ? 4 * (dated / roles.length) : 0, 4, `${dated}/${roles.length} roles dated`, { severity: 'medium', text: 'Some roles have no recognisable dates.', fix: 'Give every role a date range such as “2022 – Present”.' });

    // 2. Keyword match (45), against the job's own top keywords
    const keywords = extractKeywords(`${job.title || ''}\n${job.description || ''}`, { limit: 20 });
    const totalWeight = keywords.reduce((sum, item) => sum + item.score, 0);
    let earned = 0;
    let claimable = 0;
    const missing = [];
    const unsurfaced = [];
    for (const { term, score } of keywords) {
        const count = countTerm(text, term);
        earned += score * (count === 0 ? 0 : count === 1 ? 0.85 : 1);
        const evidenced = countTerm(candidateText, term) > 0;
        if (evidenced) claimable += score;
        if (count === 0) (evidenced ? unsurfaced : missing).push(term);
    }
    const keywordMax = 45;
    const keywordPoints = totalWeight ? keywordMax * (earned / totalWeight) : keywordMax;
    const keywordCeiling = totalWeight ? keywordMax * (claimable / totalWeight) : keywordMax;
    add('Keywords', 'Job keywords found in your resume', keywordPoints, keywordMax,
        `${keywords.length - missing.length - unsurfaced.length}/${keywords.length} keywords present`, missing.length
            ? { severity: 'high', text: `Not in your resume: ${missing.slice(0, 8).join(', ')}.`, fix: 'If you genuinely have these skills, add them to Key skills on your Profile or to your resume and rebuild. If you do not, do not add them.' } : null);
    if (unsurfaced.length) issues.push({ severity: 'medium', text: `Evidenced in your resume but missing from this version: ${unsurfaced.join(', ')}.`, fix: 'Rebuild with optimisation on so they are listed under Skills.' });

    // 3. Content quality (20)
    const perRoleOk = roles.length ? roles.filter(entry => entry.bullets.length >= 3).length / roles.length : 0;
    add('Quality', 'At least 3 bullets per role', 5 * perRoleOk, 5, `${Math.round(perRoleOk * 100)}% of roles`, { severity: 'low', text: 'Some roles have fewer than three bullet points.', fix: 'Add a third achievement to thin roles in your source resume (only true ones).' });
    const withMetric = bullets.filter(line => /\d/.test(line)).length;
    const metricRatio = bullets.length ? withMetric / bullets.length : 0;
    add('Quality', 'Measurable results', 5 * Math.min(1, metricRatio / 0.3), 5, `${withMetric}/${bullets.length} bullets include a number`, { severity: 'medium', text: 'Few bullets include a measurable result.', fix: 'Where it is true, add the real number, percentage or time saved to your source bullets.' });
    const actionRatio = bullets.length ? bullets.filter(line => ACTION_START.test(line)).length / bullets.length : 0;
    add('Quality', 'Bullets start with action verbs', 4 * Math.min(1, actionRatio / 0.8), 4, `${Math.round(actionRatio * 100)}%`, { severity: 'low', text: 'Many bullets do not start with an action verb.', fix: 'Start bullets with verbs such as “Built”, “Reduced”, “Automated”.' });
    const words = text.split(/\s+/).filter(Boolean).length;
    // A resume is one page, which is about 250 to 600 words. Longer is not better here, so anything from 200 to 700 words is full marks.
    const lengthPoints = words >= 200 && words <= 700 ? 3 : (words >= 150 && words < 200) || (words > 700 && words <= 900) ? 1.5 : 0;
    add('Quality', 'Length (one page, 200–700 words)', lengthPoints, 3, `${words} words`, { severity: 'low', text: words < 200 ? 'The resume is very short for an ATS to judge.' : 'The resume is longer than one page of text.', fix: words < 200 ? 'Add real detail to your source resume.' : 'Remove older or less relevant content so it fits on one page.' });
    const clean = !bullets.some(line => FIRST_PERSON.test(line));
    add('Quality', 'No first-person wording', clean ? 2 : 0, 2, clean ? 'Clean' : 'First person found', { severity: 'low', text: 'Bullets use first-person wording.', fix: 'Rewrite bullets without “I”, “my” or “we”.' });
    add('Quality', 'Summary present', tailored.summary ? 1 : 0, 1, tailored.summary ? 'Yes' : 'No', null);

    // 4. Title alignment (10) — level words are ignored: never claim a seniority you do not have
    const titleWords = String(job.title || '').toLowerCase().match(/[a-z][a-z+#/.-]*/g) || [];
    const significant = [...new Set(titleWords.filter(word => word.length > 1 && !LEVEL_WORDS.has(word) && !['and', 'of', 'the', 'for', 'to', 'in', 'at'].includes(word)))];
    const titleHits = significant.filter(word => countTerm(text, word) > 0);
    add('Title', 'Job title words appear in your resume', significant.length ? 10 * (titleHits.length / significant.length) : 10, 10, significant.length ? `${titleHits.length}/${significant.length}: ${titleHits.join(', ') || 'none'}` : 'n/a',
        { severity: 'medium', text: `Your resume does not mention: ${significant.filter(word => !titleHits.includes(word)).join(', ')}.`, fix: 'Only mention role terms you can honestly claim.' });

    const score = Math.round(breakdown.reduce((sum, item) => sum + item.points, 0));
    const ceiling = Math.min(100, Math.round(score + (keywordCeiling - keywordPoints)));
    return {
        score, ceiling, breakdown, issues: issues.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity])),
        keywords: { total: keywords.length, missing, unsurfaced },
        note: 'An estimate of how well common applicant tracking systems can parse and match this resume. Real systems differ.',
    };
}

const STEPS = [
    ['Baseline tailoring', {}],
    ['List skills you already evidence under Skills', { surfaceSkills: true }],
    ['Keep more job-relevant bullets', { surfaceSkills: true, maxBullets: 8 }],
    ['Keep every job-relevant bullet', { surfaceSkills: true, maxBullets: 12 }],
];

/**
 * Rebuild in rounds until the ATS score reaches `target`. `askAi` (optional) returns validated rewrite
 * suggestions for the current bullets. Returns the best attempt and an honest account of what happened.
 */
async function optimizeForAts({ resumeText, job, profile = {}, rewrites = [], target = 90, askAi = null }) {
    const candidateText = `${resumeText}\n${profile.skills || ''}`;
    const rounds = [];
    let best = null;
    const attempt = (label, options, extraRewrites = rewrites) => {
        const built = tailorResume({ resumeText, job, profile, rewrites: extraRewrites, ...options });
        // Hard rules: the standard resume rules first (they only remove or reorder), then one page. The fact check above still holds.
        const jobKeywords = extractKeywords(`${job.title || ''}\n${job.description || ''}`, { limit: 20 }).map(item => item.term);
        const ruled = applyResumeRules(built.tailored, { keywords: jobKeywords });
        built.tailored = ruled.tailored;
        built.changes = [...built.changes, ...ruled.changes];
        const fitted = fitToPages(built.tailored, { pages: 1 });
        built.tailored = fitted.tailored;
        built.pages = fitted.pages;
        built.rules = checkResumeRules(built.tailored, { pages: fitted.pages, keywords: jobKeywords });
        if (fitted.removed.length) built.changes = [...built.changes, describeRemoval(fitted.removed)];
        if (!fitted.fits) built.warnings = [...built.warnings, 'This resume still runs past one page after removing everything that could be left out. Shorten your name line, contact details or education in your source resume.'];
        const ats = scoreAts({ tailored: built.tailored, job, candidateText });
        rounds.push({ label, score: ats.score, factCheckOk: built.factCheck.ok });
        const result = { label, options, built, ats };
        // A round whose output fails the fact gate can never win.
        if (built.factCheck.ok && (!best || ats.score > best.ats.score)) best = result;
        return result;
    };

    for (const [label, options] of STEPS) {
        attempt(label, options);
        if (best && best.ats.score >= target) break;
    }
    let aiError = null;
    let aiUsed = false;
    if (best && best.ats.score < target && askAi && !rewrites.length) {
        try {
            const suggestions = await askAi(best.built.tailored);
            const accepted = suggestions.filter(item => item.status === 'improved').map(({ original, suggested }) => ({ original, suggested }));
            if (accepted.length) {
                const before = best.ats.score;
                const reworded = attempt('AI wording pass (validated against the hard rules)', best.options, accepted);
                // The user opted in: keep valid rewording whenever it does not lower the score.
                if (reworded.built.factCheck.ok && reworded.built.appliedRewrites.length && reworded.ats.score >= before) { best = reworded; aiUsed = true; }
            }
        } catch (error) { aiError = error.message; }
    }
    const reached = best.ats.score >= target;
    return {
        best, rounds, target, reached, aiUsed, aiError,
        explanation: reached
            ? `Reached an estimated ATS score of ${best.ats.score}/100.`
            : best.ats.ceiling < target
                ? `The most this resume can honestly score for this job is about ${best.ats.ceiling}/100 (now ${best.ats.score}). The gap is job keywords your resume does not evidence${best.ats.keywords.missing.length ? `: ${best.ats.keywords.missing.slice(0, 8).join(', ')}` : ''}. If you genuinely have them, add them to your Profile skills or source resume and rebuild; otherwise a lower score is the truthful result.`
                : `Reached ${best.ats.score}/100 after all safe changes; remaining points depend on details in your source resume (see the issues list).`,
    };
}

const clip = (line, max = 150) => (line.length > max ? `${line.slice(0, max - 1)}…` : line);

/**
 * Where an ATS score loses points and what the person can do about it, in plain terms. Pure: it only reads the
 * score and the tailored resume, so the advice always matches the numbers.
 */
function improvementDetails({ ats, tailored }) {
    const gains = ats.breakdown
        .map(item => ({ group: item.group, label: item.label, lost: round1(item.max - item.points), detail: item.detail }))
        .filter(item => item.lost >= 0.5)
        .sort((a, b) => b.lost - a.lost)
        .slice(0, 6);
    const roles = tailored.experience || [];
    const bulletsOf = entry => entry.bullets.map(line => ({ role: entry.header[0] || 'A role', line }));
    const all = roles.flatMap(bulletsOf);
    return {
        gains,
        specifics: {
            noNumber: all.filter(item => !/[0-9]/.test(item.line)).slice(0, 4).map(item => ({ role: clip(item.role, 80), line: clip(item.line) })),
            noActionVerb: all.filter(item => !ACTION_START.test(item.line)).slice(0, 4).map(item => ({ role: clip(item.role, 80), line: clip(item.line) })),
            thinRoles: roles.filter(entry => entry.bullets.length < 3).map(entry => clip(entry.header[0] || 'A role', 80)),
            firstPerson: all.filter(item => FIRST_PERSON.test(item.line)).slice(0, 3).map(item => ({ role: clip(item.role, 80), line: clip(item.line) })),
        },
    };
}

module.exports = { improvementDetails, optimizeForAts, plainText, scoreAts };
