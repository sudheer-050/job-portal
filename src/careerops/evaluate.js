'use strict';

const { detectMinimumExperience, detectSponsorship, scoreJob } = require('../jobs/core');
const { countTerm, extractKeywords, keywordCoverage } = require('./keywords');
const { assessLegitimacy } = require('./legitimacy');

const ARCHETYPES = [
    ['AI / Machine Learning', /\b(machine learning|ml engineer|data scientist|ai engineer|llm|deep learning|nlp|generative ai|prompt engineer)\b/i],
    ['Data & Analytics', /\b(data analyst|analytics|business intelligence|bi developer|data engineer|data engineering|etl|dashboard|reporting analyst)\b/i],
    ['Software Engineering', /\b(software (?:engineer|developer)|backend|back-end|frontend|front-end|full[- ]?stack|web developer|devops|sre|platform engineer|mobile developer)\b/i],
    ['Solutions / Sales Engineering', /\b(solutions? (?:engineer|architect|consultant)|sales engineer|pre-?sales|technical account|customer engineer|implementation)\b/i],
    ['Product Management', /\b(product (?:manager|owner|lead)|technical product|program manager|product operations)\b/i],
    ['Project / Program Management', /\b(project manager|program manager|scrum master|delivery manager|pmo)\b/i],
    ['Business Analysis', /\b(business analyst|systems analyst|requirements|process analyst|functional analyst)\b/i],
    ['Customer Success & Support', /\b(customer success|support engineer|account manager|client success|technical support)\b/i],
    ['Design / UX', /\b(ux|ui designer|product designer|user experience|graphic designer|visual designer)\b/i],
    ['Marketing & Growth', /\b(marketing|growth|seo|content strategist|demand gen|brand)\b/i],
    ['Finance & Accounting', /\b(financial analyst|accountant|accounting|fp&a|controller|auditor|treasury)\b/i],
    ['Operations', /\b(operations|supply chain|logistics|procurement|coordinator|administrator)\b/i],
];

const SENIORITY = [
    ['intern', 0, /\b(intern|internship|trainee|apprentice|co-?op)\b/i],
    ['junior', 1, /\b(?:junior|entry[- ]level|graduate|associate|jr\b\.?|(?:engineer|analyst|developer|specialist) i)(?![a-z])/i],
    ['senior', 3, /\b(senior|sr\.?|iii|lead)\b/i],
    ['staff', 4, /\b(staff|principal|architect|distinguished)\b/i],
    ['management', 4, /\b(manager|head of|director|vp|vice president|chief)\b/i],
];

function detectArchetype(title, description) {
    const headline = String(title || '');
    for (const [name, pattern] of ARCHETYPES) if (pattern.test(headline)) return name;
    const body = String(description || '').slice(0, 3000);
    let best = null;
    let bestCount = 0;
    for (const [name, pattern] of ARCHETYPES) {
        const matches = body.match(new RegExp(pattern.source, 'gi'));
        if (matches && matches.length > bestCount) { best = name; bestCount = matches.length; }
    }
    return best || 'General';
}

function detectSeniority(title) {
    const text = String(title || '');
    let found = { name: 'mid', rank: 2 };
    for (const [name, rank, pattern] of SENIORITY) if (pattern.test(text)) found = { name, rank };
    return found;
}

function candidateLevel(years) {
    if (!Number.isFinite(years)) return null;
    if (years < 1) return { name: 'entry', rank: 0.5 };
    if (years < 3) return { name: 'junior', rank: 1 };
    if (years < 6) return { name: 'mid', rank: 2 };
    if (years < 10) return { name: 'senior', rank: 3 };
    return { name: 'staff+', rank: 4 };
}

function splitLines(text) {
    return String(text || '').split(/\r?\n|•|·|•|(?<=\.)\s{2,}/).map(line => line.replace(/^[\s\-*–—]+/, '').trim()).filter(line => line.length > 12);
}

const REQUIREMENTS_HEADER = /^(?:key |minimum |basic |preferred |required )?(?:requirements?|qualifications?|what you(?:'|’)ll need|what we(?:'|’)re looking for|about you|you have|must[- ]haves?|skills(?: (?:and|&) experience)?)\s*:?$/i;
const OTHER_HEADER = /^(?:responsibilities|what you(?:'|’)ll do|about (?:us|the (?:company|role|team))|benefits|perks|compensation|salary|why join|our (?:mission|culture)|how to apply|equal opportunity)\b.{0,30}:?$/i;
const PREFERRED = /\b(?:a plus|is a plus|nice to have|nice-to-have|preferred|bonus|desirable|ideally|an advantage|would be great)\b/i;

// Lines under a Requirements/Qualifications heading when the posting has one, otherwise
// the lines that read like requirements. Never silently drops a line from a real list.
function requirementLines(description, limit = 14) {
    const raw = String(description || '').split(/\r?\n/).map(line => line.replace(/^[\s\-*–—•·•]+/, '').trim()).filter(Boolean);
    const collected = [];
    let inside = false;
    for (const line of raw) {
        if (REQUIREMENTS_HEADER.test(line)) { inside = true; continue; }
        if (OTHER_HEADER.test(line) || /^(?:salary|compensation|pay range|apply|benefits|location)\b/i.test(line) ||
            (/^[A-Z][^.!?]{2,40}:$/.test(line) && !REQUIREMENTS_HEADER.test(line))) { inside = false; continue; }
        if (inside && line.length > 12 && line.length < 300) collected.push(line);
    }
    if (collected.length) return collected.slice(0, limit);
    const lines = splitLines(description);
    const marked = lines.filter(line => /\b(must|required|requirements?|years?|experience (?:with|in|building|using)|proficien|knowledge of|degree|certif|ability to|familiar|skills?)\b/i.test(line) && line.length < 280);
    return (marked.length ? marked : lines.filter(line => line.length < 220)).slice(0, limit);
}

// A skills list or a contact line is not evidence of anything; prefer a real achievement line.
function isListLike(line) {
    const parts = line.split(/\s*[,|;•·]\s*/);
    return parts.length >= 3 && parts.every(part => part.split(/\s+/).length <= 3);
}
const isContactLine = line => /@|linkedin\.com|github\.com|\(\d{3}\)|\d{3}[-.\s]\d{3}[-.\s]\d{4}/i.test(line);

function evidenceCandidates(resumeText) {
    return splitLines(resumeText).filter(line => line.length >= 25 && !isListLike(line) && !isContactLine(line));
}

function findEvidence(resumeText, terms, used = new Set()) {
    const lines = evidenceCandidates(resumeText);
    const pick = lines.find(line => !used.has(line) && terms.some(term => countTerm(line, term)))
        || lines.find(line => terms.some(term => countTerm(line, term)));
    if (!pick) return '';
    used.add(pick);
    return pick.slice(0, 220);
}

// `candidateText` (resume + saved skills) decides whether a requirement is met;
// `resumeText` alone supplies the quoted evidence so a skills string is never cited as proof.
function mapRequirements(description, candidateText, resumeText = candidateText) {
    const used = new Set();
    return requirementLines(description).map(line => {
        const priority = PREFERRED.test(line) ? 'preferred' : 'required';
        const terms = extractKeywords(line, { limit: 6 }).map(item => item.term);
        if (!terms.length) return { requirement: line, priority, status: 'unknown', evidence: '' };
        const hits = terms.filter(term => countTerm(candidateText, term) > 0);
        // “X or Y” alternatives: any one of them satisfies the requirement.
        const alternatives = /\b[\w.+#/ ]+\s+or\s+[\w.+#/ ]+/i.test(line) && hits.length > 0;
        const ratio = hits.length / terms.length;
        const status = ratio >= 0.6 || (alternatives && ratio >= 0.4) ? 'match' : ratio > 0 ? 'partial' : 'gap';
        return { requirement: line, priority, status, evidence: hits.length ? findEvidence(resumeText, hits, used) : '', matchedTerms: hits, missingTerms: terms.filter(term => !hits.includes(term)) };
    });
}

function compensationBlock(job, profile) {
    const jobMin = job.salaryMin || job.salaryMax || null;
    const jobMax = job.salaryMax || job.salaryMin || null;
    const wantMin = Number(profile.salary_min ?? profile.salaryMin) || null;
    const wantMax = Number(profile.salary_max ?? profile.salaryMax) || null;
    if (!jobMin && !jobMax) {
        return { fit: 'unknown', score: 0.6, advertised: null, summary: 'No pay range is published. Ask for the range before investing in interviews.' };
    }
    const advertised = { min: jobMin, max: jobMax };
    if (wantMin && jobMax < wantMin) return { fit: 'below', score: 0, advertised, summary: `Advertised top of range ($${jobMax.toLocaleString()}) is below your minimum ($${wantMin.toLocaleString()}).` };
    if (wantMax && jobMin > wantMax) return { fit: 'above', score: 1, advertised, summary: 'Advertised pay starts above your stated maximum — you may be able to negotiate toward the top of your target.' };
    if (wantMin && jobMin < wantMin) return { fit: 'overlap', score: 0.8, advertised, summary: 'The range overlaps your target; aim for the upper half when negotiating.' };
    return { fit: 'within', score: 1, advertised, summary: 'Advertised pay is within your target range.' };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function verdictFor(score, blockers) {
    if (blockers.length && score < 4) return { label: 'Do not apply', action: 'skip', text: `Hard blocker: ${blockers[0]}` };
    if (score >= 4.5) return { label: 'Strong match', action: 'apply', text: 'Apply now. Tailor your resume and send it while the posting is fresh.' };
    if (score >= 4.0) return { label: 'Good match', action: 'apply', text: 'Worth applying. Address the listed gaps honestly in your cover letter.' };
    if (score >= 3.5) return { label: 'Marginal', action: 'reconsider', text: 'Below the 4.0/5 bar. Apply only if you have a specific reason to override this score.' };
    return { label: 'Not recommended', action: 'skip', text: 'Below 4.0/5. Applying here costs time better spent on stronger matches.' };
}

/**
 * Evaluate one posting against a candidate. Pure and deterministic: all inputs come
 * from the posting, the saved profile and the resume. Nothing is invented.
 */
function evaluateOffer({ job, profile = {}, resumeText = '', roles = [], now = Date.now() }) {
    const description = String(job.description || '');
    const title = String(job.title || '');
    const candidateText = `${profile.skills || ''}\n${resumeText}`.trim();
    const years = profile.experience_years === null || profile.experience_years === undefined || profile.experience_years === ''
        ? null : Number(profile.experience_years ?? profile.experienceYears);

    const archetype = detectArchetype(title, description);
    const seniority = detectSeniority(title);
    const requiredYears = detectMinimumExperience(description);
    const legit = assessLegitimacy(job, { now });
    const coverage = keywordCoverage(`${title}\n${description}`, candidateText);
    const requirements = mapRequirements(description, candidateText, resumeText || candidateText);
    const comp = compensationBlock(job, profile);

    const targetRoles = (roles.length ? roles : [profile.role || title]).filter(Boolean);
    const preferenceScores = targetRoles.map(role => scoreJob({ ...profile, role, remote_pref: profile.remote_pref || profile.work_style || 'any' }, candidateText, job));
    const bestPreference = preferenceScores.sort((a, b) => b.score - a.score)[0] || { score: 50, reasons: [], preferenceMismatches: [] };

    const level = candidateLevel(years);
    let levelFit = 'unknown';
    if (level) {
        const gap = seniority.rank - level.rank;
        levelFit = gap > 1.5 ? 'stretch' : gap > 0.5 ? 'slight-stretch' : gap < -2 ? 'over-qualified' : 'aligned';
    }

    // Hard blockers.
    const blockers = [];
    if ((profile.sponsorship === 'required') && detectSponsorship(description) === 'unavailable') blockers.push('The posting says it cannot sponsor visas and you require sponsorship.');
    if (legit.tier === 'Suspicious') blockers.push('The posting shows strong scam or staleness signals.');
    if (comp.fit === 'below') blockers.push('Advertised pay is below your minimum.');

    // Weighted fit, 0..1 → 1..5.
    const coverageRatio = coverage.coverage / 100;
    // Required items carry full weight; nice-to-haves count a third as much and never read as hard gaps.
    const weightOf = item => (item.priority === 'preferred' ? 0.35 : 1);
    const totalWeight = requirements.reduce((sum, item) => sum + weightOf(item), 0);
    const requirementRatio = totalWeight
        ? requirements.reduce((sum, item) => sum + weightOf(item) * (item.status === 'match' ? 1 : item.status === 'partial' || item.status === 'unknown' ? 0.5 : 0), 0) / totalWeight
        : coverageRatio;
    const levelScore = { aligned: 1, 'slight-stretch': 0.8, unknown: 0.7, stretch: 0.35, 'over-qualified': 0.55 }[levelFit];
    const fit = (coverageRatio * 0.28) + (requirementRatio * 0.27) + ((bestPreference.score / 100) * 0.25) + (levelScore * 0.1) + (comp.score * 0.1);
    let score = 1 + fit * 4;
    if (legit.tier === 'Proceed with Caution') score -= 0.3;
    if (legit.tier === 'Suspicious') score = Math.min(score, 2);
    if (comp.fit === 'below') score = Math.min(score, 3);
    if (blockers.some(item => /sponsor/i.test(item))) score = Math.min(score, 2.5);
    if (requiredYears !== null && Number.isFinite(years) && years < requiredYears * 0.5) score = Math.min(score, 3);
    score = Math.round(clamp(score, 1, 5) * 10) / 10;

    const verdict = verdictFor(score, blockers);
    const gaps = requirements.filter(item => item.status === 'gap' && item.priority !== 'preferred').map(item => item.requirement);
    const niceToHaveGaps = requirements.filter(item => item.status === 'gap' && item.priority === 'preferred').map(item => item.requirement);
    const strengths = requirements.filter(item => item.status === 'match').slice(0, 5);
    const topPresent = coverage.present.slice(0, 8).map(item => item.term);

    return {
        score,
        verdict,
        blockers,
        legitimacy: legit,
        blocks: {
            A: {
                title: 'Role summary', archetype, seniority: seniority.name, workplace: job.workplaceType || 'unknown',
                location: job.location || 'Not listed', company: job.company || 'Not identified',
                requiredYears, tldr: `${seniority.name === 'mid' ? '' : `${seniority.name[0].toUpperCase()}${seniority.name.slice(1)} `}${archetype} role at ${job.company || 'an unnamed employer'}${job.location ? ` (${job.location})` : ''}.`,
            },
            B: { title: 'CV match', coverage: coverage.coverage, requirements, present: coverage.present, thin: coverage.thin, missing: coverage.missing, preferenceScore: bestPreference.score, reasons: bestPreference.reasons, mismatches: bestPreference.preferenceMismatches },
            C: {
                title: 'Level & strategy', jdLevel: seniority.name, yourLevel: level ? level.name : 'unknown', fit: levelFit,
                plan: levelFit === 'stretch' ? 'Lead with the largest-scope work you have shipped and be explicit about growth trajectory; expect the level to be probed.'
                    : levelFit === 'over-qualified' ? 'Frame your seniority as leverage (mentoring, ownership) and confirm the scope is a real fit before applying.'
                        : levelFit === 'unknown' ? 'Add your years of experience to your profile so level fit can be assessed.'
                            : 'Your experience level aligns with the posting; emphasise measurable outcomes.',
            },
            D: { title: 'Compensation', ...comp },
            E: {
                title: 'Personalisation',
                emphasise: strengths.map(item => ({ requirement: item.requirement, evidence: item.evidence })),
                keywordsToFeature: topPresent,
                honestGaps: gaps.slice(0, 5),
                niceToHaveGaps: niceToHaveGaps.slice(0, 5),
                note: 'Gaps are for you to address honestly (adjacent experience, learning plan). They are never added to your resume as claims.',
            },
            F: {
                title: 'Interview preparation',
                topics: topPresent.slice(0, 5).map(term => `Prepare a STAR story that shows real, measurable work with ${term}.`),
                questions: gaps.slice(0, 3).map(gap => `Expect to be asked about: ${gap.slice(0, 140)}`),
                askThem: ['What does success look like in the first 90 days?', 'How is this team measured, and what changed since the role opened?', ...(comp.fit === 'unknown' ? ['What is the compensation range for this role?'] : [])],
            },
            G: { title: 'Posting legitimacy', ...legit },
        },
        meta: { archetype, coverage: coverage.coverage, legitimacyTier: legit.tier, evaluatedAt: new Date(now).toISOString() },
    };
}

module.exports = { candidateLevel, detectArchetype, detectSeniority, evaluateOffer, mapRequirements, verdictFor };
