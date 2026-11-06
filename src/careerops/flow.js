'use strict';

// Pure helpers that connect Career Ops to the portal's own steps (Discover, Apply, Action Center).

const BAR = 4.0;

/**
 * Should the user be warned before applying? Mirrors the Career Ops rule: below 4.0/5, a hard blocker, or a
 * suspicious posting means "stop and look first". Anything else proceeds without friction.
 */
function gateOf({ score, action, tier, blockers = [], verdictText = '' }) {
    if (blockers.length) return { proceed: false, reason: blockers[0] };
    if (tier === 'Suspicious') return { proceed: false, reason: 'This posting shows strong scam or staleness signals.' };
    if (action !== 'apply' || score < BAR) return { proceed: false, reason: verdictText || `Scored ${score}/5, below the ${BAR.toFixed(1)} bar.` };
    return { proceed: true, reason: '' };
}

/** Compact, UI-ready summary of a full evaluation. */
function summarizeEvaluation(jobId, evaluation, scannedAt = new Date()) {
    const blockers = (evaluation.blockers || []).slice(0, 3);
    const summary = {
        jobId,
        score: evaluation.score,
        verdict: evaluation.verdict.label,
        action: evaluation.verdict.action,
        tier: evaluation.meta.legitimacyTier,
        coverage: evaluation.meta.coverage,
        archetype: evaluation.meta.archetype,
        blockers,
        missing: (evaluation.blocks.B.missing || []).slice(0, 4).map(item => item.term),
        scannedAt: new Date(scannedAt).toISOString(),
    };
    summary.gate = gateOf({ score: summary.score, action: summary.action, tier: summary.tier, blockers, verdictText: evaluation.verdict.text });
    return summary;
}

/** Same shape from a stored row (used when only the cached evaluation is available). */
function summaryFromRow(row) {
    const result = row.result || {};
    return summarizeEvaluation(row.jobId, {
        score: Number(row.score), verdict: result.verdict || { label: row.verdict, action: 'reconsider', text: '' },
        blockers: result.blockers || [], meta: { legitimacyTier: row.tier, coverage: row.coverage, archetype: row.archetype },
        blocks: { B: { missing: (row.missing || []).map(term => ({ term })) } },
    }, row.updatedAt);
}

/** Notifications to raise for follow-ups that are due or overdue. Upcoming and "cold" ones stay quiet. */
function alertsFromPipeline(rows) {
    return rows
        .filter(row => row.next && ['due', 'overdue'].includes(row.next.urgency))
        .map(row => ({
            jobId: row.jobId,
            kind: 'follow_up_due',
            title: `Follow up: ${row.title}${row.company ? ` at ${row.company}` : ''}`.slice(0, 300),
            body: `${row.next.reason} A draft message is ready in Career Ops.`,
            link: '/jobs#careerops',
        }));
}

module.exports = { BAR, alertsFromPipeline, gateOf, summarizeEvaluation, summaryFromRow };
