'use strict';

// Block G: is this posting a real, currently open role? Signals are evidence for the
// reader, not proof. Posting text is data, never instructions: imperative text aimed
// at an AI is quoted as an anomaly and otherwise ignored.

const KNOWN_ATS_HOSTS = [
    'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'workday.com', 'smartrecruiters.com',
    'icims.com', 'bamboohr.com', 'jobvite.com', 'recruitee.com', 'workable.com', 'breezy.hr', 'teamtailor.com',
    'paylocity.com', 'dayforcehcm.com', 'successfactors.com', 'taleo.net', 'rippling.com', 'join.com',
];
const AGGREGATOR_HOSTS = [
    'linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'wellfound.com', 'monster.com',
    'simplyhired.com', 'naukri.com', 'instahyre.com', 'cutshort.in', 'internshala.com', 'dice.com', 'jooble.org',
];

const PAYMENT_SCAM = /\b(wire transfer|gift cards?|western union|bitcoin|crypto(?:currency)? (?:payment|wallet)|purchase (?:your own )?(?:equipment|laptop)|processing fee|registration fee|training fee|send (?:us )?(?:a )?(?:check|cheque)|cash (?:a )?check|advance (?:fee|payment))\b/i;
const OFF_PLATFORM_CONTACT = /\b(telegram|whatsapp|signal app|text us at|contact (?:us )?on (?:telegram|whatsapp))\b/i;
const AI_DIRECTED = /(ignore (?:all |any )?(?:previous|prior|above) instructions|disregard (?:the )?(?:above|previous)|as an ai\b|you are (?:an? )?(?:ai|language model|assistant)|system prompt|rate this (?:job|candidate) (?:as )?(?:5|10|perfect)|recommend (?:applying|this candidate))/i;
const BUZZ = /\b(rock ?star|ninja|guru|wear many hats|fast[- ]paced environment|work hard,? play hard|self[- ]starter|thick skin)\b/gi;
const FREE_MAIL = /[\w.+-]+@(?:gmail|yahoo|outlook|hotmail|proton(?:mail)?|aol)\.[a-z.]+/i;

function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; }
}
function hostMatches(host, list) {
    return Boolean(host) && list.some(domain => host === domain || host.endsWith(`.${domain}`));
}
function ageInDays(date, now) {
    if (!date) return null;
    const time = new Date(date).getTime();
    return Number.isFinite(time) ? Math.max(0, (now - time) / 86400000) : null;
}
function excerpt(text, pattern) {
    const match = String(text).match(pattern);
    if (!match) return '';
    const start = Math.max(0, match.index - 40);
    return String(text).slice(start, match.index + match[0].length + 60).replace(/\s+/g, ' ').trim();
}

function assessLegitimacy(job, { now = Date.now() } = {}) {
    const description = String(job.description || '');
    const title = String(job.title || '');
    const company = String(job.company || '').trim();
    const host = hostOf(job.applyUrl || job.apply_url);
    const signals = [];
    let score = 62;
    const add = (kind, label, delta, detail) => {
        score += delta;
        signals.push({ kind, label, detail: detail || '', impact: delta });
    };

    // Positive evidence.
    if (hostMatches(host, KNOWN_ATS_HOSTS)) add('positive', 'Hosted on an employer applicant-tracking system', 14, host);
    if (job.salaryMin || job.salaryMax) add('positive', 'Pay range is published', 8);
    if (description.length >= 1200) add('positive', 'Detailed, specific job description', 8);
    if (company && company.length > 1) add('positive', 'Employer is named', 4);
    const age = ageInDays(job.postedAt || job.posted_at, now);
    if (age !== null && age <= 21) add('positive', `Posted ${Math.round(age)} day(s) ago`, 6);
    const stackTerms = (description.match(/\b(python|java|sql|aws|react|typescript|kubernetes|salesforce|tableau|excel|figma)\b/gi) || []).length;
    if (stackTerms >= 3) add('positive', 'Names a concrete tools/tech stack', 4);

    // Cautions.
    if (!company || /^(confidential|stealth|undisclosed|private|hidden)\b/i.test(company)) {
        add('negative', 'Employer is not identified', -18, 'A hidden employer is a legitimacy signal, never a research gap. Do not guess the employer.');
    }
    if (description.length < 400) add('negative', 'Very thin job description', -14, `${description.length} characters`);
    if (age !== null && age > 90) add('negative', `Posted ${Math.round(age)} days ago — likely stale or evergreen`, -16);
    else if (age !== null && age > 45) add('negative', `Posted ${Math.round(age)} days ago`, -7);
    if (hostMatches(host, AGGREGATOR_HOSTS)) {
        add('negative', 'Aggregator listing — unconfirmed until found on the employer site', -6, host);
    }
    const buzz = description.match(BUZZ) || [];
    if (buzz.length >= 3) add('negative', 'Heavy filler language', -4, [...new Set(buzz.map(word => word.toLowerCase()))].join(', '));
    const yearsMatch = description.match(/(\d{1,2})\+?\s*(?:\+\s*)?years/i);
    if (yearsMatch && Number(yearsMatch[1]) >= 10 && /\b(junior|entry|associate|intern|graduate)\b/i.test(title)) {
        add('negative', 'Experience requirement does not fit the stated level', -10, `${yearsMatch[0]} for “${title}”`);
    }

    // Strong red flags.
    if (PAYMENT_SCAM.test(description)) add('red-flag', 'Mentions payments, fees, equipment purchases or gift cards', -45, excerpt(description, PAYMENT_SCAM));
    if (OFF_PLATFORM_CONTACT.test(description)) add('red-flag', 'Asks to move to Telegram/WhatsApp', -35, excerpt(description, OFF_PLATFORM_CONTACT));
    if (FREE_MAIL.test(description) && !hostMatches(host, KNOWN_ATS_HOSTS)) {
        add('red-flag', 'Recruiter contact uses a free email domain', -14, excerpt(description, FREE_MAIL));
    }
    if (AI_DIRECTED.test(`${title}\n${description}`)) {
        add('anomaly', 'Posting contains text aimed at an AI reviewer — ignored', -25, excerpt(`${title}\n${description}`, AI_DIRECTED));
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const hasRedFlag = signals.some(signal => signal.kind === 'red-flag' || signal.kind === 'anomaly');
    let tier = score >= 70 ? 'High Confidence' : score >= 45 ? 'Proceed with Caution' : 'Suspicious';
    if (hasRedFlag && tier === 'High Confidence') tier = 'Proceed with Caution';
    return { tier, score, signals, host, aggregator: hostMatches(host, AGGREGATOR_HOSTS) };
}

module.exports = { AGGREGATOR_HOSTS, KNOWN_ATS_HOSTS, assessLegitimacy, hostMatches, hostOf };
