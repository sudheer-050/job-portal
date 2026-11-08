'use strict';

const crypto = require('node:crypto');
const { rateLimit } = require('express-rate-limit');
const { canonicalizeUrl, cleanText } = require('../jobs/core');
const { evaluateOffer } = require('./evaluate');
const { checkLiveness } = require('./liveness');
const { READER_VERSION, buildCoverLetter, parseResume, readingIssues, renderHtml, renderMarkdown, tailorResume } = require('./resume');
const { aiConfig, suggestRewrites } = require('./rewrite');
const { improvementDetails, optimizeForAts } = require('./ats');
const { pageCount, renderDocument } = require('../documents/export');
const { checkCoverLetter, metricGaps, recruiterVerdict } = require('./recruiter');
const { applyConfirmedSkills } = require('./confirm');
const { mergeSkills } = require('../profile/sources');
const { acceptBulkSkills, rememberedUsedFor, visibleGaps } = require('./remembered');
const { alertsFromPipeline, summarizeEvaluation, summaryFromRow } = require('./flow');
const { analyzePatterns, canonicalState, nextFollowUp } = require('./tracker');

const MAX_DESCRIPTION = 30000;
const BASE = '/api/jobs/careerops';

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS job_evaluations (
        username VARCHAR(20) NOT NULL REFERENCES job_users(username) ON DELETE CASCADE,
        job_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
        score NUMERIC(2,1) NOT NULL,
        verdict VARCHAR(24) NOT NULL,
        archetype TEXT,
        legitimacy_tier VARCHAR(24),
        coverage SMALLINT,
        missing JSONB NOT NULL DEFAULT '[]'::jsonb,
        result JSONB NOT NULL,
        liveness JSONB,
        tailored JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (username, job_id)
    );
    CREATE INDEX IF NOT EXISTS job_evaluations_user_score_idx ON job_evaluations (username, score DESC);
    CREATE TABLE IF NOT EXISTS job_followups (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(20) NOT NULL REFERENCES job_users(username) ON DELETE CASCADE,
        job_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
        channel VARCHAR(24) NOT NULL DEFAULT 'email',
        note TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS job_followups_user_job_idx ON job_followups (username, job_id, sent_at);
    -- Skills the person said they have. Remembered so later jobs that ask for them use them automatically.
    CREATE TABLE IF NOT EXISTS job_confirmed_skills (
        username VARCHAR(20) NOT NULL REFERENCES job_users(username) ON DELETE CASCADE,
        skill_key TEXT NOT NULL,
        skill TEXT NOT NULL,
        job_id TEXT,
        confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (username, skill_key)
    );
`;

function toJob(row) {
    return {
        id: row.id, title: row.title, company: row.company, location: row.location, description: row.description || '',
        salaryMin: row.salary_min, salaryMax: row.salary_max, workplaceType: row.workplace_type,
        applyUrl: row.apply_url, postedAt: row.posted_at, source: row.source, metadata: row.metadata || {},
    };
}

function pastedJob(body) {
    const title = cleanText(body.title).slice(0, 200);
    const description = String(body.description || '').slice(0, MAX_DESCRIPTION);
    if (!title || description.trim().length < 80) return null;
    const url = String(body.url || '').trim().slice(0, 2000);
    const salaryMin = Number(body.salaryMin) || null;
    const salaryMax = Number(body.salaryMax) || null;
    return {
        id: null, title, company: cleanText(body.company).slice(0, 200) || null, location: cleanText(body.location).slice(0, 200) || null,
        description, salaryMin, salaryMax, workplaceType: ['remote', 'hybrid', 'onsite'].includes(body.workplaceType) ? body.workplaceType : 'onsite',
        applyUrl: url, postedAt: null, source: 'manual', metadata: {},
    };
}

// The shape returned by POST /resume and stored with the evaluation; also used to prepare applications.
function buildPayload({ job, evaluation, built, ats, cover }) {
    // the cover letter is held to its own rules, and the whole package gets a recruiter's verdict
    const letterRules = checkCoverLetter(cover.text, { title: job.title, company: job.company });
    const recruiter = recruiterVerdict({ fit: evaluation.score, ats: ats.score, resumeRules: built.rules, letterRules, blockers: evaluation.blockers || [], legitimacy: evaluation.legitimacy && evaluation.legitimacy.tier });
    return {
        recruiter, letterRules, metricPrompts: metricGaps(built.tailored),
        jobId: job.id, job: { title: job.title, company: job.company },
        score: evaluation.score, verdict: evaluation.verdict, coverage: evaluation.meta.coverage,
        resume: { structured: built.tailored, markdown: renderMarkdown(built.tailored), html: renderHtml(built.tailored) },
        coverLetter: cover, changes: built.changes, factCheck: built.factCheck, keywords: built.keywords, warnings: built.warnings, pages: built.pages, rules: built.rules,
        appliedRewrites: built.appliedRewrites, rejectedRewrites: built.rejectedRewrites, ats,
        generatedAt: new Date().toISOString(),
    };
}

const HTTPS_URL = /^https:\/\/[^\s]+$/i;
const httpError = (statusCode, message, extra = {}) => Object.assign(new Error(message), { statusCode, ...extra });

function registerCareerOps(app, { pool, requireAuth, asyncRoute, ready, env = process.env, fetchImpl = fetch, hooks = {} }) {
    const recordApplicationEvent = hooks.recordApplicationEvent || (async () => {});
    const notifyUser = hooks.notifyUser || (async () => {});
    const outbound = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false });
    const aiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false });
    const scanLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });

    const schemaReady = ready.then(() => pool.query(SCHEMA));
    schemaReady.catch(error => {
        console.error('Career Ops schema failed:', error.message);
        setTimeout(() => process.exit(1), 0);
    });
    // Every Career Ops route waits for its tables to exist.
    app.use(BASE, (_req, _res, next) => { schemaReady.then(() => next(), next); });

    async function rememberedSkills(username) {
        const result = await pool.query('SELECT skill, confirmed_at AS "confirmedAt" FROM job_confirmed_skills WHERE username=$1 ORDER BY confirmed_at DESC', [username]);
        return result.rows;
    }

    // Everything Career Ops knows about the person. Skills they confirmed before are folded into their skills,
    // so every evaluation, scan, resume and application uses them without asking again.
    async function context(username) {
        const [profile, roles, resume, remembered] = await Promise.all([
            pool.query('SELECT * FROM job_profiles WHERE username=$1', [username]),
            pool.query('SELECT role FROM job_roles WHERE username=$1', [username]),
            pool.query('SELECT resume_text FROM resumes WHERE username=$1', [username]),
            rememberedSkills(username),
        ]);
        const row = profile.rows[0] || {};
        const names = remembered.map(item => item.skill);
        return {
            profile: { ...row, skills: mergeSkills(row.skills, names, 100000).skills, remote_pref: row.work_style || 'any', experience_years: row.experience_years },
            roles: roles.rows.map(item => item.role),
            resumeText: resume.rows[0]?.resume_text || '',
            remembered: names,
        };
    }

    async function loadJob(jobId) {
        const found = await pool.query('SELECT * FROM job_postings WHERE id=$1', [String(jobId || '')]);
        return found.rows[0] ? toJob(found.rows[0]) : null;
    }

    async function saveManualJob(job) {
        const key = job.applyUrl ? canonicalizeUrl(job.applyUrl) : '';
        const hash = crypto.createHash('sha1').update(key || `${job.title}|${job.company}|${job.description.slice(0, 200)}`).digest('hex').slice(0, 16);
        const id = `manual:${hash}`;
        await pool.query(
            `INSERT INTO job_postings (id, source, source_job_id, title, company, location, salary_min, salary_max, workplace_type,
                description, apply_url, canonical_key, last_seen_at, active)
             VALUES ($1,'manual',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),true)
             ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, company=EXCLUDED.company, location=EXCLUDED.location,
                salary_min=EXCLUDED.salary_min, salary_max=EXCLUDED.salary_max, workplace_type=EXCLUDED.workplace_type,
                description=EXCLUDED.description, apply_url=EXCLUDED.apply_url, last_seen_at=now(), active=true`,
            [id, hash, job.title, job.company, job.location, job.salaryMin, job.salaryMax, job.workplaceType,
                job.description, job.applyUrl || `manual://${hash}`, key || `manual:${hash}`]
        );
        return { ...job, id };
    }

    async function persist(username, job, evaluation) {
        await pool.query(
            `INSERT INTO job_evaluations (username, job_id, score, verdict, archetype, legitimacy_tier, coverage, missing, result)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
             ON CONFLICT (username, job_id) DO UPDATE SET score=$3, verdict=$4, archetype=$5, legitimacy_tier=$6,
                coverage=$7, missing=$8::jsonb, result=$9::jsonb, updated_at=now()`,
            [username, job.id, evaluation.score, evaluation.verdict.label, evaluation.meta.archetype, evaluation.meta.legitimacyTier,
                evaluation.meta.coverage, JSON.stringify(evaluation.blocks.B.missing.map(item => item.term)), JSON.stringify(evaluation)]
        );
    }

    // Evaluate a saved posting (jobId) or a pasted one (title + description); pasted ones can be saved to the pipeline.
    app.post(`${BASE}/evaluate`, requireAuth, asyncRoute(async (req, res) => {
        await ready;
        let job = null;
        if (req.body?.jobId) {
            job = await loadJob(req.body.jobId);
            if (!job) return res.status(404).json({ error: 'That job is no longer available.' });
        } else {
            job = pastedJob(req.body || {});
            if (!job) return res.status(400).json({ error: 'Provide a job title and at least a short job description.' });
        }
        const { profile, roles, resumeText } = await context(req.jobUsername);
        const evaluation = evaluateOffer({ job, profile, roles, resumeText });
        if (!resumeText) evaluation.warnings = ['Upload your resume for an accurate CV match — scores without it only reflect your saved preferences.'];
        if (!job.id && req.body?.save) job = await saveManualJob(job);
        if (job.id) await persist(req.jobUsername, job, evaluation);
        res.json({ jobId: job.id, job: { title: job.title, company: job.company, location: job.location, applyUrl: job.applyUrl }, evaluation });
    }));

    app.get(`${BASE}/evaluations`, requireAuth, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `SELECT e.job_id AS "jobId", e.score::float AS score, e.verdict, e.archetype, e.legitimacy_tier AS "legitimacyTier",
                    e.coverage, e.liveness->>'verdict' AS liveness, e.updated_at AS "updatedAt",
                    (e.tailored IS NOT NULL) AS "hasResume", p.title, p.company, p.location, p.apply_url AS "applyUrl"
             FROM job_evaluations e JOIN job_postings p ON p.id=e.job_id
             WHERE e.username=$1 ORDER BY e.score DESC, e.updated_at DESC LIMIT 200`, [req.jobUsername]
        );
        res.json({ evaluations: result.rows });
    }));

    app.get(`${BASE}/evaluations/:jobId`, requireAuth, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `SELECT e.result, e.liveness, e.updated_at AS "updatedAt", p.title, p.company, p.location, p.apply_url AS "applyUrl"
             FROM job_evaluations e JOIN job_postings p ON p.id=e.job_id WHERE e.username=$1 AND e.job_id=$2`,
            [req.jobUsername, req.params.jobId]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'No evaluation yet for that job.' });
        const row = result.rows[0];
        res.json({ jobId: req.params.jobId, job: { title: row.title, company: row.company, location: row.location, applyUrl: row.applyUrl }, evaluation: row.result, liveness: row.liveness, updatedAt: row.updatedAt });
    }));

    // Is the posting still open? Only public https hosts are fetched.
    app.post(`${BASE}/liveness`, requireAuth, outbound, asyncRoute(async (req, res) => {
        const job = await loadJob(req.body?.jobId);
        if (!job) return res.status(404).json({ error: 'Job not found.' });
        let liveness;
        try { liveness = await checkLiveness(job.applyUrl); }
        catch (error) { return res.status(400).json({ error: error.message }); }
        await pool.query('UPDATE job_evaluations SET liveness=$3::jsonb, updated_at=now() WHERE username=$1 AND job_id=$2', [req.jobUsername, job.id, JSON.stringify(liveness)]);
        if (liveness.verdict === 'expired') {
            await pool.query(`INSERT INTO job_notifications(username,kind,title,body,link) VALUES($1,'posting_expired',$2,$3,$4)`,
                [req.jobUsername, `Posting closed: ${job.title}`.slice(0, 300), liveness.reason, '/jobs#careerops']).catch(() => {});
        }
        res.json({ jobId: job.id, liveness });
    }));

    // Tailored resume + cover letter from the user's own resume. Draft only; nothing is submitted.
    app.post(`${BASE}/resume`, requireAuth, asyncRoute(async (req, res) => {
        await ready;
        const { profile: savedProfile, roles, resumeText, remembered } = await context(req.jobUsername);
        if (!resumeText) return res.status(400).json({ error: 'Upload your source resume first — tailored resumes are built only from it.' });
        let job = req.body?.jobId ? await loadJob(req.body.jobId) : pastedJob(req.body || {});
        if (!job) return res.status(req.body?.jobId ? 404 : 400).json({ error: req.body?.jobId ? 'That job is no longer available.' : 'Provide a job title and job description.' });
        // Skills the person says they have. They count as evidence, but only for keywords this job asks for,
        // and they go into the Skills list only, never into job history.
        const stated = applyConfirmedSkills({ requested: req.body?.confirmedSkills, job, profile: savedProfile });
        if (stated.rejected.length) return res.status(400).json({ error: `These are not skills this job asks for: ${stated.rejected.join(', ')}.` });
        const profile = stated.profile;
        // Remember what they confirmed so it is reused for any later job that asks for it.
        if (stated.confirmed.length) {
            await pool.query(
                `INSERT INTO job_confirmed_skills (username, skill_key, skill, job_id)
                 SELECT $1, lower(s), s, $3 FROM unnest($2::text[]) AS s
                 ON CONFLICT (username, skill_key) DO NOTHING`,
                [req.jobUsername, stated.confirmed, job.id || null]
            );
        }
        const evaluation = evaluateOffer({ job, profile, roles, resumeText });
        // Rebuild in rounds until the ATS estimate reaches the target (default 90), using only changes that stay true.
        const target = Math.min(100, Math.max(50, Number(req.body?.targetScore) || 90));
        const aiAllowed = req.body?.aiConsent === true && aiConfig(env).configured;
        const optimized = await optimizeForAts({
            resumeText, job, profile, target, rewrites: Array.isArray(req.body?.rewrites) ? req.body.rewrites : [],
            askAi: aiAllowed ? async tailored => (await suggestRewrites({ roles: tailored.experience, job, env, fetchImpl })).suggestions : null,
        });
        const built = optimized.best.built;
        const ats = { ...optimized.best.ats, target, reached: optimized.reached, rounds: optimized.rounds, explanation: optimized.explanation, aiUsed: optimized.aiUsed, aiError: optimized.aiError };
        const cover = buildCoverLetter({ resumeText, job, profile, requirements: evaluation.blocks.B.requirements });
        const payload = buildPayload({ job, evaluation, built, ats, cover });
        if (stated.confirmed.length) {
            payload.confirmedSkills = stated.confirmed;
            payload.changes = [`Added to Skills because you confirmed you have them: ${stated.confirmed.join(', ')}. Remembered, so any later job that asks for them uses them automatically.`, ...payload.changes];
        }
        const reused = rememberedUsedFor({ remembered, job, resumeText, confirmedNow: stated.confirmed });
        if (reused.length) {
            payload.rememberedUsed = reused;
            payload.changes = [`Used skills you confirmed on earlier jobs: ${reused.join(', ')}.`, ...payload.changes];
        }
        if (job.id) {
            await persist(req.jobUsername, job, evaluation);
            await pool.query('UPDATE job_evaluations SET tailored=$3::jsonb, updated_at=now() WHERE username=$1 AND job_id=$2', [req.jobUsername, job.id, JSON.stringify(payload)]);
        }
        if (stated.confirmed.length) payload.propagated = await propagateSkills(req.jobUsername);
        res.json(payload);
    }));

    // The skills the person has confirmed, so they can see and remove what is remembered.
    app.get(`${BASE}/skills`, requireAuth, asyncRoute(async (req, res) => {
        res.json({ skills: await rememberedSkills(req.jobUsername) });
    }));

    app.delete(`${BASE}/skills/:skill`, requireAuth, asyncRoute(async (req, res) => {
        const key = String(req.params.skill || '').trim().toLowerCase();
        const result = await pool.query('DELETE FROM job_confirmed_skills WHERE username=$1 AND skill_key=$2', [req.jobUsername, key]);
        if (!result.rowCount) return res.status(404).json({ error: 'That skill is not in your confirmed list.' });
        res.json({ removed: key });
    }));

    // Turn the resume or cover letter on screen into a PDF, a Word file or Markdown.
    app.post(`${BASE}/export`, requireAuth, scanLimiter, asyncRoute(async (req, res) => {
        const markdown = String(req.body?.markdown || '');
        if (!markdown.trim()) return res.status(400).json({ error: 'There is nothing to download yet.' });
        if (markdown.length > 200000) return res.status(413).json({ error: 'That document is too large to export.' });
        const kind = req.body?.kind === 'cover' ? 'Cover letter' : 'Resume';
        const named = await pool.query('SELECT full_name FROM job_profiles WHERE username=$1', [req.jobUsername]);
        const who = String(named.rows[0]?.full_name || '').trim() || (markdown.match(/^#\s+(.+)$/m) || [])[1] || '';
        const file = renderDocument({ markdown, format: req.body?.format, baseName: [who, kind, String(req.body?.company || req.body?.title || '').slice(0, 60)].filter(Boolean).join(' - ') });
        if (!file) return res.status(400).json({ error: 'Choose pdf, docx or md.' });
        res.set('X-Content-Type-Options', 'nosniff');
        res.attachment(file.filename).type(file.contentType).send(file.buffer);
    }));

    // Exactly how Career Ops reads the uploaded resume, so a role that was scrambled by a PDF is easy to spot.
    app.get(`${BASE}/resume-reading`, requireAuth, asyncRoute(async (req, res) => {
        const { resumeText } = await context(req.jobUsername);
        if (!resumeText) return res.status(400).json({ error: 'Upload your resume first.' });
        const read = parseResume(resumeText);
        res.json({
            name: read.name,
            roles: read.experience.map(entry => ({ heading: entry.header, bullets: entry.bullets })),
            projects: read.projects.map(entry => ({ title: entry.header[0] || '', bullets: entry.bullets.length })),
            education: read.education,
            certifications: read.certifications,
            skills: read.skills.length,
            summaryWords: read.summary ? read.summary.split(/\s+/).length : 0,
            sections: read.sectionCount,
            issues: readingIssues(read),
        });
    }));

    app.get(`${BASE}/ai`, requireAuth, (_req, res) => {
        const { configured, model } = aiConfig(env);
        res.json({ configured, model: configured ? model : null });
    });

    // AI bullet rewording. Suggestions only: each is validated against hard rules and nothing is applied until the user accepts it.
    app.post(`${BASE}/rewrite`, requireAuth, aiLimiter, asyncRoute(async (req, res) => {
        await ready;
        if (!aiConfig(env).configured) return res.status(503).json({ error: 'AI rewriting is not set up on this server. Ask the administrator to set CAREEROPS_AI_KEY.' });
        if (req.body?.consent !== true) return res.status(400).json({ error: 'Confirm that you agree to send your resume bullets and this job description to the AI provider.' });
        const { profile, resumeText } = await context(req.jobUsername);
        if (!resumeText) return res.status(400).json({ error: 'Upload your source resume first.' });
        const job = req.body?.jobId ? await loadJob(req.body.jobId) : pastedJob(req.body || {});
        if (!job) return res.status(req.body?.jobId ? 404 : 400).json({ error: req.body?.jobId ? 'That job is no longer available.' : 'Provide a job title and job description.' });
        const built = tailorResume({ resumeText, job, profile });
        try {
            const result = await suggestRewrites({ roles: built.tailored.experience, job, env, fetchImpl });
            res.json({ jobId: job.id, ...result, rules: 'Suggestions never add numbers, tools, titles, credentials, leadership or authorship that are not already in the original line.' });
        } catch (error) {
            console.error('AI rewrite failed:', error.message);
            res.status(502).json({ error: error.code === 'AI_NOT_CONFIGURED' ? error.message : 'The AI service could not complete that request. Try again in a moment.' });
        }
    }));

    // Print-ready HTML of the last tailored resume (use the browser's Save as PDF).
    app.get(`${BASE}/resume/:jobId/html`, requireAuth, asyncRoute(async (req, res) => {
        const result = await pool.query('SELECT tailored FROM job_evaluations WHERE username=$1 AND job_id=$2', [req.jobUsername, req.params.jobId]);
        const html = result.rows[0]?.tailored?.resume?.html;
        if (!html) return res.status(404).json({ error: 'Build a tailored resume for that job first.' });
        res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
        res.send(html);
    }));

    async function pipelineRows(username) {
        const result = await pool.query(
            `WITH ids AS (
                SELECT job_id FROM job_applications WHERE username=$1
                UNION SELECT job_id FROM job_focus_plans WHERE username=$1
                UNION SELECT job_id FROM job_evaluations WHERE username=$1
             )
             SELECT p.id AS "jobId", p.title, p.company, p.apply_url AS "applyUrl", p.source,
                    a.status AS "applicationStatus", a.created_at AS "createdAt", a.applied_at AS "appliedAt", a.updated_at AS "updatedAt",
                    f.stage AS "focusStage", f.next_follow_up AS "nextFollowUp",
                    e.score::float AS score, e.verdict, e.archetype, e.legitimacy_tier AS "legitimacyTier", e.missing AS "missingKeywords",
                    (SELECT max(i.scheduled_at) FROM job_interviews i WHERE i.username=$1 AND i.application_id=a.id AND i.scheduled_at <= now()) AS "interviewAt",
                    EXISTS(SELECT 1 FROM job_interviews i WHERE i.username=$1 AND i.application_id=a.id) AS "hasInterview",
                    (SELECT o.status FROM job_offers o WHERE o.username=$1 AND o.application_id=a.id ORDER BY o.created_at DESC LIMIT 1) AS "offerStatus",
                    (SELECT array_agg(fu.sent_at ORDER BY fu.sent_at) FROM job_followups fu WHERE fu.username=$1 AND fu.job_id=p.id) AS "followUps",
                    EXISTS(SELECT 1 FROM job_hidden_jobs h WHERE h.username=$1 AND h.job_id=p.id) AS hidden
             FROM ids JOIN job_postings p ON p.id=ids.job_id
             LEFT JOIN job_applications a ON a.username=$1 AND a.job_id=p.id
             LEFT JOIN job_focus_plans f ON f.username=$1 AND f.job_id=p.id
             LEFT JOIN job_evaluations e ON e.username=$1 AND e.job_id=p.id
             ORDER BY COALESCE(a.updated_at, e.updated_at, p.last_seen_at) DESC LIMIT 500`, [username]
        );
        return result.rows.map(row => ({ ...row, state: canonicalState(row) }));
    }

    app.get(`${BASE}/pipeline`, requireAuth, asyncRoute(async (req, res) => {
        await ready;
        const { profile } = await context(req.jobUsername);
        const rows = await pipelineRows(req.jobUsername);
        const withNext = rows.map(row => ({ ...row, next: nextFollowUp(row, { profileName: profile.full_name || '' }) }));
        const order = { overdue: 0, due: 1, upcoming: 2, cold: 3 };
        const actions = withNext.filter(row => row.next).sort((a, b) => (order[a.next.urgency] ?? 9) - (order[b.next.urgency] ?? 9) || String(a.next.dueAt).localeCompare(String(b.next.dueAt)));
        res.json({ pipeline: withNext, actions });
    }));

    app.post(`${BASE}/followups`, requireAuth, asyncRoute(async (req, res) => {
        const job = await loadJob(req.body?.jobId);
        if (!job) return res.status(404).json({ error: 'Job not found.' });
        const channel = ['email', 'linkedin', 'phone', 'portal', 'other'].includes(req.body?.channel) ? req.body.channel : 'email';
        const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
        await pool.query('INSERT INTO job_followups(username,job_id,channel,note) VALUES($1,$2,$3,$4)', [req.jobUsername, job.id, channel, note]);
        res.status(201).json({ ok: true });
    }));

    app.get(`${BASE}/patterns`, requireAuth, asyncRoute(async (req, res) => {
        await ready;
        res.json({ patterns: analyzePatterns(await pipelineRows(req.jobUsername)) });
    }));

    // ---- Integration with the portal's own steps ----

    const cleanIds = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map(item => String(item).trim()))]
        .filter(id => id && id.length <= 200).slice(0, 100);

    // Scan a batch of jobs (the user's ranked matches) against their resume and profile, storing each evaluation.
    app.post(`${BASE}/scan`, requireAuth, scanLimiter, asyncRoute(async (req, res) => {
        await ready;
        const ids = cleanIds(req.body?.jobIds);
        if (!ids.length) return res.status(400).json({ error: 'Provide the job ids to scan.' });
        const { profile, roles, resumeText } = await context(req.jobUsername);
        if (!resumeText) return res.json({ results: [], resumeMissing: true, message: 'Upload your resume so Career Ops can scan your matches.' });
        const rows = (await pool.query('SELECT * FROM job_postings WHERE id = ANY($1::text[])', [ids])).rows;
        const results = [];
        for (const row of rows) {
            const job = toJob(row);
            try {
                const evaluation = evaluateOffer({ job, profile, roles, resumeText });
                await persist(req.jobUsername, job, evaluation);
                results.push(summarizeEvaluation(job.id, evaluation));
            } catch (error) { console.error('scan failed for one job:', error.message); }
        }
        results.sort((a, b) => b.score - a.score);
        res.json({ results, scanned: results.length, requested: ids.length, resumeMissing: false });
    }));

    // Cached scores (no recomputation). `stale` means the resume changed after the evaluation.
    app.get(`${BASE}/scores`, requireAuth, asyncRoute(async (req, res) => {
        const ids = cleanIds(req.query.ids);
        if (!ids.length) return res.json({ scores: {} });
        const result = await pool.query(
            `SELECT e.job_id AS "jobId", e.score::float AS score, e.verdict, e.legitimacy_tier AS tier, e.coverage, e.archetype,
                    e.missing, e.result, e.updated_at AS "updatedAt", (r.uploaded_at IS NOT NULL AND e.updated_at < r.uploaded_at) AS stale
             FROM job_evaluations e LEFT JOIN resumes r ON r.username=e.username
             WHERE e.username=$1 AND e.job_id = ANY($2::text[])`, [req.jobUsername, ids]
        );
        const scores = {};
        for (const row of result.rows) scores[row.jobId] = { ...summaryFromRow(row), stale: row.stale };
        res.json({ scores });
    }));

    // Called when an application is started, so every application carries a Career Ops evaluation.
    async function evaluateJobForUser(username, jobId) {
        await schemaReady;
        const { profile, roles, resumeText } = await context(username);
        if (!resumeText) return null;
        const job = await loadJob(jobId);
        if (!job) return null;
        const evaluation = evaluateOffer({ job, profile, roles, resumeText });
        await persist(username, job, evaluation);
        return summarizeEvaluation(job.id, evaluation);
    }

    async function pipelineWithNext(username) {
        const { profile } = await context(username);
        return (await pipelineRows(username)).map(row => ({ ...row, next: nextFollowUp(row, { profileName: profile.full_name || '' }) }));
    }

    // The two Career Ops numbers on the dashboard: strong jobs not started yet, and follow-ups that are due.
    const statsCache = new Map();
    async function dashboardStats(username) {
        const hit = statsCache.get(username);
        if (hit && Date.now() - hit.at < 60 * 1000) return hit.value;
        await schemaReady;
        const strong = (await pool.query(
            `SELECT count(*)::int AS n FROM job_evaluations e JOIN job_postings p ON p.id=e.job_id
             WHERE e.username=$1 AND e.score >= 4 AND e.legitimacy_tier <> 'Suspicious' AND p.active=true
               AND jsonb_array_length(COALESCE(e.result->'blockers','[]'::jsonb)) = 0
               AND NOT EXISTS (SELECT 1 FROM job_applications a WHERE a.username=e.username AND a.job_id=e.job_id)
               AND NOT EXISTS (SELECT 1 FROM job_hidden_jobs h WHERE h.username=e.username AND h.job_id=e.job_id)`, [username]
        )).rows[0].n;
        const followups = (await pipelineWithNext(username)).filter(row => row.next && ['due', 'overdue'].includes(row.next.urgency)).length;
        const value = { strong, followups };
        statsCache.set(username, { at: Date.now(), value });
        return value;
    }

    // Turn due or overdue follow-ups into Action Center notifications (once per follow-up per week).
    const lastAlertSync = new Map();
    async function syncAlerts(username, { force = false, minIntervalMs = 5 * 60 * 1000 } = {}) {
        const last = lastAlertSync.get(username) || 0;
        if (!force && Date.now() - last < minIntervalMs) return 0;
        lastAlertSync.set(username, Date.now());
        await schemaReady;
        const rows = await pipelineWithNext(username);
        let created = 0;
        for (const alert of alertsFromPipeline(rows)) {
            const result = await pool.query(
                `INSERT INTO job_notifications(username,kind,title,body,link)
                 SELECT $1::varchar(20),$2::varchar(40),$3::text,$4::text,$5::text
                 WHERE NOT EXISTS (SELECT 1 FROM job_notifications WHERE username=$1 AND kind=$2 AND title=$3 AND created_at > now() - interval '7 days')`,
                [username, alert.kind, alert.title, alert.body, alert.link]
            );
            created += result.rowCount;
        }
        return created;
    }

    // ---- Submission: applications prepared by Career Ops ----

    // Evaluate, build the ATS-optimised fact-checked resume and the cover letter, and store them with the evaluation.
    // Deterministic (no AI, no cost). The documents are drafts for the user to review; nothing is sent anywhere.
    async function prepareDocuments(username, job, ctx) {
        const evaluation = evaluateOffer({ job, profile: ctx.profile, roles: ctx.roles, resumeText: ctx.resumeText });
        const optimized = await optimizeForAts({ resumeText: ctx.resumeText, job, profile: ctx.profile, target: 90 });
        const built = optimized.best.built;
        const ats = { ...optimized.best.ats, target: 90, reached: optimized.reached, rounds: optimized.rounds, explanation: optimized.explanation, aiUsed: false, aiError: null };
        const cover = buildCoverLetter({ resumeText: ctx.resumeText, job, profile: ctx.profile, requirements: evaluation.blocks.B.requirements });
        const payload = buildPayload({ job, evaluation, built, ats, cover });
        await persist(username, job, evaluation);
        await pool.query('UPDATE job_evaluations SET tailored=$3::jsonb, updated_at=now() WHERE username=$1 AND job_id=$2', [username, job.id, JSON.stringify(payload)]);
        return { evaluation, payload, summary: summarizeEvaluation(job.id, evaluation), ats };
    }

    /**
     * Start an application for a job without Hagent: Career Ops prepares the documents and the application waits,
     * "ready to submit", for the user to review it and apply on the employer's site. It is never submitted automatically.
     */
    async function createPreparedApplication(username, jobId) {
        await schemaReady;
        const ctx = await context(username);
        if (!ctx.resumeText) throw httpError(400, 'Upload your source resume before starting an application.');
        const found = await pool.query('SELECT * FROM job_postings WHERE id=$1 AND active=true', [String(jobId || '')]);
        if (!found.rows.length) throw httpError(404, 'That job is no longer available.');
        const job = toJob(found.rows[0]);
        const existing = await pool.query('SELECT id,status,job_id FROM job_applications WHERE username=$1 AND job_id=$2', [username, job.id]);
        if (existing.rows.length) throw httpError(409, 'This job is already in your application tracker.', { application: existing.rows[0] });

        const docs = await prepareDocuments(username, job, ctx);
        const { payload, ats } = docs;
        const status = payload.factCheck.ok ? 'ready_to_submit' : 'needs_review';
        const notes = JSON.stringify({
            source: 'career-ops',
            reader: READER_VERSION,
            jobFit: { score: payload.score, verdict: payload.verdict.label },
            ats: { score: ats.score, target: ats.target, reached: ats.reached, explanation: ats.explanation },
            changes: payload.changes, warnings: payload.warnings, notEvidenced: payload.keywords.notEvidenced,
        });
        let inserted;
        try {
            inserted = await pool.query(
                `INSERT INTO job_applications (username,job_id,status,tailored_resume,cover_letter,quality_score,quality_verdict,quality_notes,requires_login)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false) RETURNING id,job_id,status,quality_score,created_at`,
                [username, job.id, status, payload.resume.markdown, payload.coverLetter.text, ats.score, payload.factCheck.ok ? 'PASS' : 'REVIEW', notes]
            );
        } catch (error) {
            if (error.code === '23505') throw httpError(409, 'This job is already in your application tracker.');
            throw error;
        }
        const application = inserted.rows[0];
        await recordApplicationEvent(application.id, 'created', `Prepared with Career Ops: fact-checked resume and cover letter (ATS ${ats.score}/100). Waiting for your review.`);
        await notifyUser(username, 'application_ready', `Application ready: ${job.title}`,
            `Career Ops prepared a fact-checked resume and cover letter (ATS ${ats.score}/100). Review them, then open the employer page to apply.`, '/jobs#applications');
        return {
            application, applyUrl: job.applyUrl, summary: docs.summary,
            ats: { score: ats.score, target: ats.target, reached: ats.reached, explanation: ats.explanation },
            verdict: payload.verdict, warnings: payload.warnings,
        };
    }

    // Apply to one job from start to finish in the Career Ops tab: a saved job id, or a pasted posting with its https link.
    app.post(`${BASE}/apply`, requireAuth, scanLimiter, asyncRoute(async (req, res) => {
        await ready;
        let jobId = req.body?.jobId ? String(req.body.jobId) : '';
        if (!jobId) {
            const pasted = pastedJob(req.body || {});
            if (!pasted) return res.status(400).json({ error: 'Provide a job title and the full job description.' });
            if (!HTTPS_URL.test(pasted.applyUrl)) return res.status(400).json({ error: 'Add the https link to the posting so you can open the employer application.' });
            jobId = (await saveManualJob(pasted)).id;
        }
        try {
            res.status(201).json(await createPreparedApplication(req.jobUsername, jobId));
        } catch (error) {
            if (!error.statusCode) throw error;
            res.status(error.statusCode).json({ error: error.message, ...(error.application ? { application: error.application } : {}) });
        }
    }));

    // Replace the draft of an application that is stuck or failed Hagent's review with a Career Ops one.
    // The new resume must pass the same fact check as any other; otherwise nothing changes.
    async function rewriteApplication(username, applicationId, reason = 'it needed a rewrite', { includeReady = false } = {}) {
        await schemaReady;
        const found = await pool.query('SELECT id,job_id,status,quality_score FROM job_applications WHERE id=$1 AND username=$2', [applicationId, username]);
        const row = found.rows[0];
        if (!row) throw httpError(404, 'Application not found.');
        const rewritable = includeReady ? ['needs_review', 'tailoring', 'verifying', 'ready_to_submit', 'action_required'] : ['needs_review', 'tailoring', 'verifying'];
        if (!rewritable.includes(row.status)) throw httpError(409, 'Only applications that are being prepared or need review can be rewritten.');
        const ctx = await context(username);
        if (!ctx.resumeText) throw httpError(400, 'Upload your source resume first.');
        const posting = await pool.query('SELECT * FROM job_postings WHERE id=$1', [row.job_id]);
        if (!posting.rows.length) throw httpError(404, 'That job is no longer available.');
        const job = toJob(posting.rows[0]);
        const { payload, ats } = await prepareDocuments(username, job, ctx);
        if (!payload.factCheck.ok) throw httpError(422, 'The rewritten resume did not pass the fact check, so it was not used.');
        // Hard rule: a resume is one page. A draft that cannot be brought to one page is not swapped in (the old one stays and the reason is shown).
        if (pageCount(payload.resume.markdown) > 1) throw httpError(422, 'Even after leaving out everything that can go, this resume does not fit on one page. Shorten the header, contact or education lines in your source resume.');
        const notes = JSON.stringify({
            source: 'career-ops',
            reader: READER_VERSION,
            rewrittenFrom: { status: row.status, previousScore: row.quality_score, reason },
            jobFit: { score: payload.score, verdict: payload.verdict.label },
            ats: { score: ats.score, target: ats.target, reached: ats.reached, explanation: ats.explanation },
            changes: payload.changes, warnings: payload.warnings, notEvidenced: payload.keywords.notEvidenced,
        });
        const updated = await pool.query(
            `UPDATE job_applications SET status=CASE WHEN status='action_required' THEN status ELSE 'ready_to_submit' END, tailored_resume=$3, cover_letter=$4,
                    resume_version=resume_version+1, cover_letter_version=cover_letter_version+1,
                    quality_score=$5, quality_verdict='PASS', quality_notes=$6, error=CASE WHEN status='action_required' THEN error ELSE NULL END, updated_at=now()
             WHERE id=$1 AND username=$2 AND status = ANY($7::text[]) RETURNING id,job_id,status`,
            [applicationId, username, payload.resume.markdown, payload.coverLetter.text, ats.score, notes, rewritable]
        );
        if (!updated.rows.length) throw httpError(409, 'The application changed while it was being rewritten.');
        await recordApplicationEvent(applicationId, 'auto_rewritten', `Rewritten with Career Ops (ATS ${ats.score}/100) because ${reason}. Waiting for your review.`);
        return { application: updated.rows[0], ats: { score: ats.score, reached: ats.reached }, title: job.title };
    }

    // Score every job the person has already looked at again, after what Career Ops knows about them changed.
    async function reevaluateAll(username, limit = 300) {
        const ctx = await context(username);
        if (!ctx.resumeText) return { jobs: 0 };
        const rows = (await pool.query(
            `SELECT p.*, e.coverage AS prev_coverage, e.score::float AS prev_score FROM job_evaluations e
             JOIN job_postings p ON p.id=e.job_id WHERE e.username=$1 ORDER BY e.updated_at DESC LIMIT $2`, [username, limit]
        )).rows;
        let before = 0, after = 0, scoreBefore = 0, scoreAfter = 0;
        for (const row of rows) {
            try {
                const evaluation = evaluateOffer({ job: toJob(row), profile: ctx.profile, roles: ctx.roles, resumeText: ctx.resumeText });
                await persist(username, toJob(row), evaluation);
                before += Number(row.prev_coverage) || 0; after += evaluation.meta.coverage;
                scoreBefore += row.prev_score || 0; scoreAfter += evaluation.score;
            } catch (error) { console.error('re-evaluation failed for one job:', error.message); }
        }
        const n = rows.length || 1;
        return {
            jobs: rows.length,
            coverage: { before: Math.round(before / n), after: Math.round(after / n) },
            fit: { before: Math.round(scoreBefore / n * 10) / 10, after: Math.round(scoreAfter / n * 10) / 10 },
        };
    }

    // Keywords many of the person's jobs ask for that their resume does not show, most common first.
    async function gapRows(username) {
        const result = await pool.query(
            `SELECT lower(term) AS key, min(term) AS skill, count(*)::int AS jobs
             FROM job_evaluations e, jsonb_array_elements_text(e.missing) AS term
             WHERE e.username=$1 GROUP BY lower(term) ORDER BY jobs DESC, key LIMIT 120`, [username]
        );
        return result.rows;
    }

    // What would raise this job's ATS score, in plain terms: where points are lost, which lines to change,
    // and which skills would help if the person genuinely has them. Nothing here changes the resume.
    app.get(`${BASE}/improve/:jobId`, requireAuth, asyncRoute(async (req, res) => {
        const ctx = await context(req.jobUsername);
        if (!ctx.resumeText) return res.status(400).json({ error: 'Upload your source resume first.' });
        const job = await loadJob(req.params.jobId);
        if (!job) return res.status(404).json({ error: 'That job is no longer available.' });
        const best = (await optimizeForAts({ resumeText: ctx.resumeText, job, profile: ctx.profile, target: 100 })).best;
        const missingSkills = best.ats.keywords.missing;
        let ifAllConfirmed = best.ats.score;
        if (missingSkills.length) {
            const withAll = mergeSkills(ctx.profile.skills, missingSkills, 100000).skills;
            ifAllConfirmed = (await optimizeForAts({ resumeText: ctx.resumeText, job, profile: { ...ctx.profile, skills: withAll }, target: 100 })).best.ats.score;
        }
        res.json({
            jobId: job.id, title: job.title, score: best.ats.score, ceiling: best.ats.ceiling, ifAllConfirmed,
            missingSkills, issues: best.ats.issues, rules: best.built.rules, ...improvementDetails({ ats: best.ats, tailored: best.built.tailored }),
        });
    }));

    app.get(`${BASE}/skill-gaps`, requireAuth, asyncRoute(async (req, res) => {
        const ctx = await context(req.jobUsername);
        const gaps = visibleGaps({ rows: await gapRows(req.jobUsername), resumeText: ctx.resumeText, profileSkills: ctx.profile.skills || '' }).slice(0, 25);
        const total = await pool.query('SELECT count(*)::int AS n, round(avg(coverage))::int AS coverage FROM job_evaluations WHERE username=$1', [req.jobUsername]);
        res.json({ gaps, jobs: total.rows[0].n, averageCoverage: total.rows[0].coverage });
    }));

    // "I have these": confirm several skills at once, then score everything again.
    app.post(`${BASE}/skills/bulk`, requireAuth, scanLimiter, asyncRoute(async (req, res) => {
        const ctx = await context(req.jobUsername);
        if (!ctx.resumeText) return res.status(400).json({ error: 'Upload your source resume first.' });
        const allowed = new Map(visibleGaps({ rows: await gapRows(req.jobUsername), resumeText: ctx.resumeText, profileSkills: ctx.profile.skills || '' }).map(gap => [gap.skill.toLowerCase(), gap.skill]));
        const { accepted, rejected } = acceptBulkSkills({ requested: req.body?.skills, allowed });
        if (rejected.length) return res.status(400).json({ error: `These are not skills your jobs ask for: ${rejected.join(', ')}.` });
        if (!accepted.length) return res.status(400).json({ error: 'Tick at least one skill you genuinely have.' });
        await pool.query(
            `INSERT INTO job_confirmed_skills (username, skill_key, skill, job_id)
             SELECT $1, lower(s), s, NULL FROM unnest($2::text[]) AS s ON CONFLICT (username, skill_key) DO NOTHING`,
            [req.jobUsername, accepted]
        );
        res.json({ added: accepted, ...(await propagateSkills(req.jobUsername)) });
    }));

    // Rebuild the drafts that have not been sent yet, so they use everything Career Ops now knows.
    async function refreshDrafts(username) {
        const rows = (await pool.query(
            `SELECT id, status, quality_score FROM job_applications WHERE username=$1
             AND (status IN ('needs_review','tailoring','verifying') OR (status='ready_to_submit' AND quality_notes LIKE '{"source":"career-ops"%'))
             ORDER BY updated_at DESC LIMIT 60`, [username]
        )).rows;
        let refreshed = 0, failed = 0, before = 0, after = 0;
        for (const row of rows) {
            try {
                const done = await rewriteApplication(username, row.id, 'your confirmed skills changed', { includeReady: true });
                refreshed += 1; before += row.quality_score || 0; after += done.ats.score;
            } catch (error) { failed += 1; }
        }
        return { refreshed, failed, ats: refreshed ? { before: Math.round(before / refreshed), after: Math.round(after / refreshed) } : null };
    }

    // When what Career Ops knows about the person changes, every score is brought up to date in one go:
    // all scored jobs, and every draft that has not been sent.
    const scoringUsers = new Set();
    async function propagateSkills(username) {
        scoringUsers.add(username);
        try {
            const rescored = await reevaluateAll(username);
            const drafts = await refreshDrafts(username);
            return { rescored, drafts };
        } finally { scoringUsers.delete(username); }
    }

    app.post(`${BASE}/refresh-drafts`, requireAuth, scanLimiter, asyncRoute(async (req, res) => {
        res.json(await refreshDrafts(req.jobUsername));
    }));

    return { createPreparedApplication, isScoring: username => scoringUsers.has(username), rewriteApplication, dashboardStats, evaluateJobForUser, rememberedSkills: async username => (await rememberedSkills(username)).map(item => item.skill), schemaReady, syncAlerts };
}

module.exports = { SCHEMA, pastedJob, registerCareerOps, toJob };
