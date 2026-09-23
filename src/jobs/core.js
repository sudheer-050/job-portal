'use strict';

const STOPWORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'and', 'or', 'for', 'with', 'on', 'in', 'at',
    'to', 'of', 'this', 'that', 'we', 'you', 'our', 'your', 'will', 'be', 'as', 'by', 'from', 'it',
    'its', 'their', 'job', 'role', 'work', 'team', 'years', 'year', 'using', 'including', 'required',
]);

function cleanText(value) {
    return String(value || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeQuery(value) {
    return cleanText(value).toLowerCase();
}

function tokens(value) {
    return new Set(normalizeQuery(value).replace(/[^a-z0-9+#.\s-]/g, ' ').split(/[\s/-]+/)
        .filter(word => word.length > 2 && !STOPWORDS.has(word)));
}

function intersectionRatio(needles, haystack) {
    if (!needles.size) return 0;
    let matches = 0;
    needles.forEach(token => { if (haystack.has(token)) matches += 1; });
    return matches / needles.size;
}

function stableHash(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function canonicalizeUrl(value) {
    try {
        const url = new URL(String(value || ''));
        ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gh_src', 'lever-source']
            .forEach(key => url.searchParams.delete(key));
        url.hash = '';
        url.pathname = url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
        return url.toString().replace(/\/$/, '').toLowerCase();
    } catch (_) {
        return String(value || '').trim().toLowerCase();
    }
}

function toInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function normalizeWorkplace(job) {
    const explicit = normalizeQuery(job.workplaceType);
    if (explicit.includes('remote') || job.remote === true) return 'remote';
    if (explicit.includes('hybrid')) return 'hybrid';
    const text = `${job.title || ''} ${job.location || ''}`;
    if (/\bremote\b/i.test(text)) return 'remote';
    if (/\bhybrid\b/i.test(text)) return 'hybrid';
    return 'onsite';
}

function normalizeJob(raw) {
    const source = normalizeQuery(raw.source).replace(/[^a-z0-9_-]/g, '') || 'unknown';
    const title = cleanText(raw.title);
    const applyUrl = String(raw.applyUrl || raw.url || '').trim();
    if (!title || !/^https?:\/\//i.test(applyUrl)) return null;
    const company = cleanText(raw.company) || null;
    const location = cleanText(raw.location) || null;
    const sourceId = cleanText(raw.sourceId || raw.id || canonicalizeUrl(applyUrl));
    const id = `${source}:${sourceId}`.slice(0, 500);
    const canonicalKey = canonicalizeUrl(applyUrl) || normalizeQuery(`${company}|${title}|${location}`);
    return {
        id,
        source,
        sourceId,
        title,
        company,
        location,
        salaryMin: toInteger(raw.salaryMin),
        salaryMax: toInteger(raw.salaryMax),
        workplaceType: normalizeWorkplace(raw),
        remote: normalizeWorkplace(raw) === 'remote',
        description: cleanText(raw.description).slice(0, 100000),
        applyUrl,
        canonicalKey: canonicalKey.slice(0, 1500),
        postedAt: raw.postedAt && !Number.isNaN(Date.parse(raw.postedAt)) ? new Date(raw.postedAt) : null,
        metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
    };
}

function parseAnnualSalary(compensation) {
    const summary = compensation?.summaryComponents || [];
    const components = summary.length ? summary : (compensation?.compensationTiers || []).flatMap(t => t.components || []);
    const salary = components.find(c => c.compensationType === 'Salary' && c.currencyCode === 'USD' && /YEAR/i.test(c.interval || ''));
    return { min: toInteger(salary?.minValue), max: toInteger(salary?.maxValue) };
}

function locationScore(preference, job) {
    const wanted = normalizeQuery(preference.location);
    if (!wanted || ['any', 'anywhere'].includes(wanted)) return 1;
    const actual = normalizeQuery(job.location);
    if (actual.includes(wanted) || wanted.includes(actual)) return 1;
    const wantedParts = tokens(wanted);
    return intersectionRatio(wantedParts, tokens(actual));
}

function scoreJob(preference, resumeText, job) {
    const roleTokens = tokens(preference.role);
    const titleTokens = tokens(job.title);
    const bodyTokens = tokens(`${job.title} ${job.description || ''}`);
    const resumeTokens = tokens(resumeText);
    const roleTitle = intersectionRatio(roleTokens, titleTokens);
    const roleBody = intersectionRatio(roleTokens, bodyTokens);
    const resumeOverlap = resumeTokens.size ? intersectionRatio(resumeTokens, bodyTokens) : roleBody;
    const place = locationScore(preference, job);
    const wantedWorkplace = normalizeQuery(preference.remote_pref || preference.remotePref || 'any');
    const workStyle = wantedWorkplace === 'any' ? 1 : (wantedWorkplace === job.workplaceType ? 1 : 0);
    const salaryMin = toInteger(preference.salary_min ?? preference.salaryMin);
    const salaryFit = !salaryMin || !job.salaryMax ? 0.6 : (job.salaryMax >= salaryMin ? 1 : 0);
    const ageDays = job.postedAt ? Math.max(0, (Date.now() - new Date(job.postedAt).getTime()) / 86400000) : 30;
    const freshness = Math.max(0, 1 - (ageDays / 90));
    const weighted = (roleTitle * 0.48) + (roleBody * 0.12) + (resumeOverlap * 0.18) +
        (place * 0.08) + (workStyle * 0.06) + (salaryFit * 0.03) + (freshness * 0.05);
    const reasons = [];
    if (roleTitle >= 0.66) reasons.push(`Strong title match for ${preference.role}`);
    else if (roleBody >= 0.5) reasons.push(`Relevant to ${preference.role}`);
    if (resumeText && resumeOverlap >= 0.08) reasons.push('Matches skills in your resume');
    if (wantedWorkplace !== 'any' && workStyle === 1) reasons.push(`${job.workplaceType[0].toUpperCase()}${job.workplaceType.slice(1)} preference matched`);
    if (preference.location && place >= 0.5) reasons.push('Location preference matched');
    if (freshness >= 0.8) reasons.push('Recently posted');
    return { score: Math.max(0, Math.min(100, Math.round(weighted * 100))), reasons, roleRelevance: Math.max(roleTitle, roleBody) };
}

function rankJobs(preferences, resumeText, jobs, limit = 50) {
    const bestByCanonical = new Map();
    for (const job of jobs) {
        for (const preference of preferences) {
            const result = scoreJob(preference, resumeText, job);
            if (result.roleRelevance < 0.25) continue;
            const key = job.canonicalKey || canonicalizeUrl(job.applyUrl) || stableHash(`${job.company}|${job.title}|${job.location}`);
            const existing = bestByCanonical.get(key);
            const candidate = { ...job, matchScore: result.score, matchReasons: result.reasons, matchedRole: preference.role };
            if (!existing || candidate.matchScore > existing.matchScore) bestByCanonical.set(key, candidate);
        }
    }
    return [...bestByCanonical.values()]
        .sort((a, b) => b.matchScore - a.matchScore || new Date(b.postedAt || 0) - new Date(a.postedAt || 0))
        .slice(0, limit);
}

module.exports = { canonicalizeUrl, cleanText, normalizeJob, normalizeQuery, parseAnnualSalary, rankJobs, scoreJob, tokens };
