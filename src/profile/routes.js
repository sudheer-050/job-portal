'use strict';

const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const S = require('./sources');

const BASE = '/api/jobs/profile-sources';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RESUME_CHARS = 200000;

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS job_profile_sources (
        username VARCHAR(20) PRIMARY KEY REFERENCES job_users(username) ON DELETE CASCADE,
        github_user VARCHAR(39),
        auto_check BOOLEAN NOT NULL DEFAULT true,
        last_checked_at TIMESTAMPTZ,
        last_result JSONB
    );
    CREATE TABLE IF NOT EXISTS job_source_findings (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(20) NOT NULL REFERENCES job_users(username) ON DELETE CASCADE,
        source VARCHAR(16) NOT NULL,
        kind VARCHAR(16) NOT NULL,
        fingerprint CHAR(24) NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        url TEXT,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(10) NOT NULL DEFAULT 'new',
        found_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        decided_at TIMESTAMPTZ,
        UNIQUE (username, fingerprint)
    );
    CREATE INDEX IF NOT EXISTS job_source_findings_user_status_idx ON job_source_findings (username, status, kind);
`;

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

function registerProfileSources(app, { pool, requireAuth, asyncRoute, ready, fetchImpl = fetch, lookup, hooks = {}, logger = console }) {
    const schemaReady = ready.then(() => pool.query(SCHEMA));
    schemaReady.catch(error => { logger.error('Profile sources schema failed:', error.message); setTimeout(() => process.exit(1), 0); });
    app.use(BASE, (_req, _res, next) => { schemaReady.then(() => next(), next); });

    const checkLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 6 } });

    async function settings(username) {
        const [mine, profile] = await Promise.all([
            pool.query('SELECT github_user,auto_check,last_checked_at,last_result FROM job_profile_sources WHERE username=$1', [username]),
            pool.query('SELECT linkedin_url,portfolio_url FROM job_profiles WHERE username=$1', [username]),
        ]);
        const row = mine.rows[0] || {};
        return {
            githubUser: row.github_user || null, autoCheck: row.auto_check !== false,
            lastCheckedAt: row.last_checked_at || null, lastResult: row.last_result || null,
            linkedinUrl: profile.rows[0]?.linkedin_url || null, portfolioUrl: profile.rows[0]?.portfolio_url || null,
        };
    }

    async function counts(username) {
        const result = await pool.query('SELECT status, count(*)::int AS n FROM job_source_findings WHERE username=$1 GROUP BY status', [username]);
        return Object.fromEntries(['new', 'accepted', 'dismissed'].map(status => [status, result.rows.find(row => row.status === status)?.n || 0]));
    }

    // New findings only: anything the user already accepted or dismissed is remembered by its fingerprint.
    async function upsertFindings(username, findings) {
        let added = 0;
        for (const f of findings) {
            const result = await pool.query(
                `INSERT INTO job_source_findings (username,source,kind,fingerprint,title,summary,url,meta)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT (username,fingerprint) DO NOTHING`,
                [username, f.source, f.kind, f.fingerprint, f.title, f.summary || null, f.url, JSON.stringify(f.meta || {})]
            );
            added += result.rowCount || 0;
        }
        return added;
    }

    async function runCheck(username) {
        const current = await settings(username);
        const result = {};
        if (current.githubUser) {
            try {
                const found = await S.fetchGithub(current.githubUser, { fetchImpl });
                result.github = { ok: true, found: found.length, added: await upsertFindings(username, found) };
            } catch (error) { result.github = { ok: false, error: error.message }; }
        }
        if (current.portfolioUrl) {
            try {
                const page = await S.fetchPage(current.portfolioUrl, { fetchImpl, lookup });
                const parsed = S.parsePortfolioHtml(page.html, page.finalUrl);
                result.portfolio = { ok: true, found: parsed.findings.length, added: await upsertFindings(username, parsed.findings), readable: parsed.readable, links: parsed.links };
            } catch (error) { result.portfolio = { ok: false, error: error.message }; }
        }
        await pool.query(
            `INSERT INTO job_profile_sources (username,last_checked_at,last_result) VALUES ($1,now(),$2::jsonb)
             ON CONFLICT (username) DO UPDATE SET last_checked_at=now(), last_result=$2::jsonb`, [username, JSON.stringify(result)]
        );
        return result;
    }

    app.get(BASE, requireAuth, asyncRoute(async (req, res) => {
        res.json({ settings: await settings(req.jobUsername), counts: await counts(req.jobUsername) });
    }));

    app.put(BASE, requireAuth, asyncRoute(async (req, res) => {
        const raw = String(req.body?.github ?? '').trim();
        const github = raw ? S.githubUsername(raw) : null;
        if (raw && !github) return res.status(400).json({ error: 'Enter your GitHub username or your github.com profile link.' });
        await pool.query(
            `INSERT INTO job_profile_sources (username,github_user,auto_check) VALUES ($1,$2,$3)
             ON CONFLICT (username) DO UPDATE SET github_user=$2, auto_check=$3`, [req.jobUsername, github, req.body?.autoCheck !== false]
        );
        res.json({ settings: await settings(req.jobUsername) });
    }));

    app.post(`${BASE}/check`, requireAuth, checkLimiter, asyncRoute(async (req, res) => {
        const current = await settings(req.jobUsername);
        if (!current.githubUser && !current.portfolioUrl) return res.status(400).json({ error: 'Add your GitHub username or your portfolio link (in Application identity) first.' });
        const result = await runCheck(req.jobUsername);
        res.json({ result, counts: await counts(req.jobUsername) });
    }));

    // LinkedIn cannot be read automatically; the user uploads files from "Get a copy of your data".
    app.post(`${BASE}/linkedin`, requireAuth, checkLimiter, upload.array('files', 6), asyncRoute(async (req, res) => {
        const files = req.files || [];
        if (!files.length) return res.status(400).json({ error: 'Choose one or more CSV files from your LinkedIn data export.' });
        const report = []; let added = 0;
        for (const file of files) {
            try {
                if (!/\.csv$/i.test(file.originalname)) throw new Error('Only .csv files from the LinkedIn export are accepted.');
                const text = file.buffer.toString('utf8');
                if (text.includes('\u0000')) throw new Error('That file does not look like a CSV.');
                const found = S.parseLinkedinCsv(file.originalname, text);
                const newOnes = await upsertFindings(req.jobUsername, found);
                added += newOnes;
                report.push({ name: S.clean(file.originalname, 80), found: found.length, added: newOnes });
            } catch (error) { report.push({ name: S.clean(file.originalname, 80), error: error.message }); }
        }
        res.json({ files: report, added, counts: await counts(req.jobUsername) });
    }));

    app.get(`${BASE}/findings`, requireAuth, asyncRoute(async (req, res) => {
        const result = await pool.query(
            `SELECT id,source,kind,title,summary,url,meta,found_at AS "foundAt" FROM job_source_findings
             WHERE username=$1 AND status='new' ORDER BY kind, found_at DESC, id DESC LIMIT 300`, [req.jobUsername]
        );
        res.json({ findings: result.rows });
    }));

    // The user's approval is the only way anything reaches the resume or skills list.
    app.post(`${BASE}/decide`, requireAuth, asyncRoute(async (req, res) => {
        const ids = value => [...new Set((Array.isArray(value) ? value : []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 100);
        const accept = ids(req.body?.accept); const dismiss = ids(req.body?.dismiss).filter(id => !accept.includes(id));
        if (!accept.length && !dismiss.length) return res.status(400).json({ error: 'Choose at least one item.' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const picked = (await client.query(
                `SELECT id,source,kind,title,summary,url,meta FROM job_source_findings WHERE username=$1 AND status='new' AND id = ANY($2::bigint[]) FOR UPDATE`,
                [req.jobUsername, accept]
            )).rows;
            const skills = picked.filter(f => f.kind === 'skill').map(f => f.title);
            const forResume = picked.filter(f => f.kind !== 'skill');
            let resumeVersion = null; let skillResult = { added: [], skipped: [] };
            if (forResume.length) {
                const row = (await client.query('SELECT resume_text FROM resumes WHERE username=$1 FOR UPDATE', [req.jobUsername])).rows[0];
                if (!row) throw httpError(400, 'Upload your resume first so accepted projects and experience can be added to it.');
                const text = S.applyFindingsToResume(row.resume_text, forResume);
                if (text.length > MAX_RESUME_CHARS) throw httpError(400, 'Your resume would become too long. Accept fewer items at once.');
                resumeVersion = (await client.query('UPDATE resumes SET resume_text=$2, version=version+1, uploaded_at=now() WHERE username=$1 RETURNING version', [req.jobUsername, text])).rows[0].version;
            }
            if (skills.length) {
                await client.query('INSERT INTO job_profiles (username) VALUES ($1) ON CONFLICT (username) DO NOTHING', [req.jobUsername]);
                const current = (await client.query('SELECT skills FROM job_profiles WHERE username=$1', [req.jobUsername])).rows[0]?.skills || '';
                const merged = S.mergeSkills(current, skills);
                skillResult = merged;
                await client.query('UPDATE job_profiles SET skills=$2, updated_at=now() WHERE username=$1', [req.jobUsername, merged.skills]);
            }
            const acceptedIds = picked.map(f => f.id);
            if (acceptedIds.length) await client.query(`UPDATE job_source_findings SET status='accepted', decided_at=now() WHERE username=$1 AND id = ANY($2::bigint[])`, [req.jobUsername, acceptedIds]);
            const dismissed = dismiss.length ? (await client.query(`UPDATE job_source_findings SET status='dismissed', decided_at=now() WHERE username=$1 AND status='new' AND id = ANY($2::bigint[])`, [req.jobUsername, dismiss])).rowCount : 0;
            await client.query('COMMIT');
            res.json({ accepted: acceptedIds.length, dismissed, resumeVersion, skillsAdded: skillResult.added, skillsSkipped: skillResult.skipped, counts: await counts(req.jobUsername) });
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
            throw error;
        } finally { client.release(); }
    }));

    // Weekly, lazy and quiet: runs when the user is active, tells them only if something new was found.
    const lastAuto = new Map();
    async function maybeAutoCheck(username) {
        if (Date.now() - (lastAuto.get(username) || 0) < 60 * 60 * 1000) return null;
        lastAuto.set(username, Date.now());
        await schemaReady;
        const current = await settings(username);
        if (!current.autoCheck || (!current.githubUser && !current.portfolioUrl)) return null;
        if (current.lastCheckedAt && Date.now() - new Date(current.lastCheckedAt).getTime() < WEEK_MS) return null;
        const result = await runCheck(username);
        const added = (result.github?.added || 0) + (result.portfolio?.added || 0);
        if (added > 0) {
            await pool.query(
                `INSERT INTO job_notifications(username,kind,title,body,link)
                 SELECT $1::varchar(20),'profile_updates',$2::text,$3::text,'/jobs#profile'
                 WHERE NOT EXISTS (SELECT 1 FROM job_notifications WHERE username=$1 AND kind='profile_updates' AND created_at > now() - interval '7 days')`,
                [username, `${added} new item${added === 1 ? '' : 's'} found on your profiles`, 'Review them in Profile & resume. Nothing is added to your resume until you approve it.']
            );
        }
        return result;
    }

    return { maybeAutoCheck, runCheck, schemaReady };
}

module.exports = { SCHEMA, registerProfileSources };
