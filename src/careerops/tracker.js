'use strict';

// Canonical pipeline states, follow-up cadence and outcome patterns (career-ops tracker
// semantics, mapped from the portal's own application / focus / interview / offer data).

const STATES = ['Evaluated', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'];
const STATE_RANK = { Evaluated: 0, SKIP: 0, Discarded: 0, Applied: 1, Responded: 2, Assessment: 2, Interview: 3, Offer: 4, Hired: 5, Rejected: 1 };
const DAY = 86400000;

function canonicalState(row) {
    const offer = String(row.offerStatus || '').toLowerCase();
    if (offer === 'accepted') return 'Hired';
    if (offer === 'declined' || offer === 'rejected' || offer === 'expired') return 'Discarded';
    if (offer) return 'Offer';
    if (row.focusStage === 'offer') return 'Offer';
    if (row.interviewAt || row.hasInterview || row.focusStage === 'interview') return 'Interview';
    if (row.focusStage === 'recruiter_contact') return 'Responded';
    if (row.hidden) return 'SKIP';
    if (['applied', 'submitted'].includes(String(row.applicationStatus || '').toLowerCase())) return 'Applied';
    return 'Evaluated';
}

const asTime = value => {
    const time = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(time) ? time : null;
};
const iso = time => new Date(time).toISOString();

function draftFollowUp(kind, row, profileName = '') {
    const company = row.company || 'your team';
    const role = row.title || 'the role';
    const sign = profileName || '[Your name]';
    if (kind === 'thank_you') {
        return `Subject: Thank you — ${role}\n\nHi [Interviewer name],\n\nThank you for taking the time to speak with me about the ${role} position at ${company}. I enjoyed learning more about the team and remain very interested. Please let me know if I can provide anything further.\n\nBest regards,\n${sign}`;
    }
    if (kind === 'respond') {
        return `Subject: Re: ${role} at ${company}\n\nHi [Contact name],\n\nThank you for getting back to me. I'm happy to continue — please let me know what times work for a conversation.\n\nBest regards,\n${sign}`;
    }
    if (kind === 'check_in') {
        return `Subject: Checking in — ${role}\n\nHi [Contact name],\n\nI wanted to check in on the status of the ${role} position at ${company}. I remain very interested and happy to provide anything that would help.\n\nBest regards,\n${sign}`;
    }
    return `Subject: Following up — ${role} application\n\nHi [Contact name],\n\nI applied for the ${role} position at ${company} and wanted to briefly reiterate my interest. I'd welcome the chance to discuss how my background fits the role.\n\nBest regards,\n${sign}`;
}

/**
 * Next follow-up action for one pipeline row. Cadence: first follow-up 7 days after applying,
 * one more 7 days later, then stop (never spam). Replies and interviews get faster actions.
 */
function nextFollowUp(row, { now = Date.now(), profileName = '' } = {}) {
    const state = row.state || canonicalState(row);
    const followUps = (row.followUps || []).map(asTime).filter(Boolean).sort((a, b) => a - b);
    const last = followUps.length ? followUps[followUps.length - 1] : null;
    const applied = asTime(row.appliedAt) ?? asTime(row.createdAt);
    const make = (kind, dueAt, reason) => {
        const delta = dueAt - now;
        const urgency = delta < -DAY ? 'overdue' : delta <= DAY ? 'due' : 'upcoming';
        return { kind, state, dueAt: iso(dueAt), urgency, reason, draft: draftFollowUp(kind, row, profileName) };
    };

    if (['Evaluated', 'SKIP', 'Discarded', 'Rejected', 'Hired'].includes(state)) return null;
    if (state === 'Offer') return null;
    if (state === 'Interview') {
        const interviewAt = asTime(row.interviewAt);
        if (interviewAt && interviewAt <= now && (!last || last < interviewAt)) return make('thank_you', interviewAt + DAY / 2, 'Send a thank-you within a day of the interview.');
        if (interviewAt && interviewAt <= now && followUps.length < 2) return make('check_in', Math.max(interviewAt, last || 0) + 7 * DAY, 'No decision yet — check in a week after the interview.');
        return null;
    }
    if (state === 'Responded') {
        const respondedAt = asTime(row.updatedAt) ?? now;
        if (!last || last < respondedAt) return make('respond', respondedAt + DAY / 2, 'A recruiter replied — answer within a day.');
        return null;
    }
    // Applied / Assessment
    if (!applied) return null;
    if (followUps.length >= 2) {
        return (now - last) > 7 * DAY ? { kind: 'cold', state, dueAt: null, urgency: 'cold', reason: 'Two follow-ups sent with no reply. Treat as closed and focus on stronger leads.', draft: '' } : null;
    }
    const base = last ?? applied;
    return make('follow_up', base + 7 * DAY, followUps.length ? 'Second and final follow-up.' : 'No reply after a week — send one polite follow-up.');
}

function bandOf(score) {
    if (score === null || score === undefined) return 'unscored';
    return score >= 4.5 ? '4.5+' : score >= 4.0 ? '4.0–4.4' : '<4.0';
}

const rate = (numerator, denominator) => (denominator ? Math.round((numerator / denominator) * 100) : null);

/** Funnel, score-band and source analysis over a user's pipeline rows. */
function analyzePatterns(rows, { minSample = 3 } = {}) {
    const items = rows.map(row => ({ ...row, state: row.state || canonicalState(row), rank: STATE_RANK[row.state || canonicalState(row)] ?? 0 }));
    const applied = items.filter(item => item.rank >= 1);
    const funnel = {
        evaluated: items.length,
        applied: applied.length,
        responded: items.filter(item => item.rank >= 2).length,
        interviewing: items.filter(item => item.rank >= 3).length,
        offers: items.filter(item => item.rank >= 4).length,
        hired: items.filter(item => item.rank >= 5).length,
    };
    const conversion = {
        applyRate: rate(funnel.applied, funnel.evaluated),
        responseRate: rate(funnel.responded, funnel.applied),
        interviewRate: rate(funnel.interviewing, funnel.applied),
        offerRate: rate(funnel.offers, funnel.interviewing),
    };

    const group = (keyFn) => {
        const map = new Map();
        for (const item of items.filter(entry => entry.rank >= 1)) {
            const key = keyFn(item);
            if (!key) continue;
            const bucket = map.get(key) || { key, applied: 0, advanced: 0 };
            bucket.applied += 1;
            if (item.rank >= 2) bucket.advanced += 1;
            map.set(key, bucket);
        }
        return [...map.values()].map(bucket => ({ ...bucket, advanceRate: rate(bucket.advanced, bucket.applied), reliable: bucket.applied >= minSample }))
            .sort((a, b) => b.applied - a.applied);
    };
    const byScoreBand = group(item => bandOf(item.score));
    const byArchetype = group(item => item.archetype);
    const bySource = group(item => item.source);

    const gapCounts = new Map();
    for (const item of items) for (const term of item.missingKeywords || []) gapCounts.set(term, (gapCounts.get(term) || 0) + 1);
    const topGaps = [...gapCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([term, count]) => ({ term, count }));

    const insights = [];
    const low = byScoreBand.find(entry => entry.key === '<4.0');
    const high = byScoreBand.filter(entry => ['4.5+', '4.0–4.4'].includes(entry.key)).reduce((acc, entry) => ({ applied: acc.applied + entry.applied, advanced: acc.advanced + entry.advanced }), { applied: 0, advanced: 0 });
    if (low && low.applied >= minSample) {
        insights.push(`${low.applied} of your applications were to roles scored below 4.0/5 — ${low.advanceRate}% advanced${high.applied ? `, versus ${rate(high.advanced, high.applied)}% for 4.0+ roles` : ''}. Fewer, better-fit applications work better.`);
    }
    const bestArchetype = byArchetype.filter(entry => entry.reliable).sort((a, b) => b.advanceRate - a.advanceRate)[0];
    if (bestArchetype && bestArchetype.advanceRate > 0) insights.push(`${bestArchetype.key} roles advance most often for you (${bestArchetype.advanceRate}% of ${bestArchetype.applied}).`);
    if (topGaps.length) insights.push(`Most common missing skills across your evaluated jobs: ${topGaps.slice(0, 4).map(gap => gap.term).join(', ')}. Build or evidence these if you have them.`);
    if (funnel.applied >= minSample && funnel.responded === 0) insights.push('No responses yet. Check resume keyword coverage and apply to higher-scored roles first.');
    if (!items.length) insights.push('Evaluate a few jobs to start building your pattern analysis.');

    return {
        funnel, conversion, byScoreBand, byArchetype, bySource, topGaps, insights,
        sampleNote: `Rates need at least ${minSample} applications per group to be marked reliable. Funnel stages are derived from current status.`,
        totals: { rows: items.length, withApplications: applied.length },
    };
}

module.exports = { STATES, analyzePatterns, bandOf, canonicalState, draftFollowUp, nextFollowUp };
