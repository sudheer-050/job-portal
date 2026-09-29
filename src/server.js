'use strict';

const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { createJobService } = require('./jobs/service');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'development-only-secret-change-me');
const HAGENT_URL = String(process.env.HAGENT_URL || '').replace(/\/$/, '');
const HAGENT_TOKEN = process.env.HAGENT_TOKEN || '';
const HAGENT_PROJECT_ID = process.env.HAGENT_PROJECT_ID || '';
const HAGENT_RECRUITER_AGENT_ID = process.env.HAGENT_RECRUITER_AGENT_ID || '';
const HAGENT_REVIEWER_AGENT_ID = process.env.HAGENT_REVIEWER_AGENT_ID || '';
const SUBMISSION_RUNNER_URL = String(process.env.SUBMISSION_RUNNER_URL || '').replace(/\/$/, '');
const SUBMISSION_RUNNER_TOKEN = process.env.SUBMISSION_RUNNER_TOKEN || '';
if (!JWT_SECRET) throw new Error('JWT_SECRET is required in production.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const jobService = createJobService({ pool });

const ready = (async () => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS job_users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(20) UNIQUE NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS job_roles (
            id SERIAL PRIMARY KEY,
            username VARCHAR(20) NOT NULL REFERENCES job_users(username) ON DELETE CASCADE,
            role TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS job_roles_username_role_idx ON job_roles (username, lower(role));
        CREATE TABLE IF NOT EXISTS job_locations (
            id SERIAL PRIMARY KEY,
            username VARCHAR(20) NOT NULL REFERENCES job_users(username) ON DELETE CASCADE,
            location TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS job_locations_username_location_idx ON job_locations (username, lower(location));
        CREATE TABLE IF NOT EXISTS job_profiles (
            username VARCHAR(20) PRIMARY KEY REFERENCES job_users(username) ON DELETE CASCADE,
            work_style VARCHAR(10) NOT NULL DEFAULT 'any',
            salary_min INTEGER,
            salary_max INTEGER,
            education_level VARCHAR(20) NOT NULL DEFAULT 'any',
            experience_years SMALLINT,
            employment_type VARCHAR(20) NOT NULL DEFAULT 'any',
            sponsorship VARCHAR(12) NOT NULL DEFAULT 'any',
            skills TEXT,
            full_name TEXT,
            phone TEXT,
            city TEXT,
            state TEXT,
            linkedin_url TEXT,
            portfolio_url TEXT,
            work_authorization TEXT,
            application_mode VARCHAR(12) NOT NULL DEFAULT 'auto',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS resumes (
            username VARCHAR(20) PRIMARY KEY REFERENCES job_users(username) ON DELETE CASCADE,
            resume_text TEXT NOT NULL,
            original_filename TEXT,
            uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS full_name TEXT;
        ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS phone TEXT;
        ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS city TEXT;
        ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS state TEXT;
        ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
        ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS portfolio_url TEXT;
        ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS work_authorization TEXT;
        ALTER TABLE job_profiles ADD COLUMN IF NOT EXISTS application_mode VARCHAR(12) NOT NULL DEFAULT 'auto';
        DO $$
        BEGIN
            IF to_regclass('public.job_preferences') IS NOT NULL THEN
                INSERT INTO job_roles (username, role)
                    SELECT DISTINCT username, trim(role) FROM job_preferences WHERE trim(role) <> ''
                    ON CONFLICT DO NOTHING;
                INSERT INTO job_locations (username, location)
                    SELECT DISTINCT username, trim(location) FROM job_preferences WHERE trim(COALESCE(location, '')) <> ''
                    ON CONFLICT DO NOTHING;
                INSERT INTO job_profiles (username, work_style, salary_min, salary_max)
                    SELECT DISTINCT ON (username) username, remote_pref, salary_min, salary_max
                    FROM job_preferences ORDER BY username, created_at DESC
                    ON CONFLICT (username) DO NOTHING;
            END IF;
        END $$;
    `);
    // job_applications references job_postings, so initialize the job catalog first.
    await jobService.initialize();
    await pool.query(`
        CREATE TABLE IF NOT EXISTS job_applications (
            id SERIAL PRIMARY KEY,
            username VARCHAR(20) NOT NULL REFERENCES job_users(username) ON DELETE CASCADE,
            job_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
            status VARCHAR(32) NOT NULL DEFAULT 'tailoring',
            hagent_issue_id TEXT,
            reviewer_issue_id TEXT,
            tailored_resume TEXT,
            cover_letter TEXT,
            quality_score SMALLINT,
            quality_verdict VARCHAR(12),
            quality_notes TEXT,
            requires_login BOOLEAN NOT NULL DEFAULT false,
            submission_mode VARCHAR(16) NOT NULL DEFAULT 'auto',
            submission_provider TEXT,
            confirmation_reference TEXT,
            error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            applied_at TIMESTAMPTZ,
            UNIQUE (username, job_id)
        );
        ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS submission_mode VARCHAR(16) NOT NULL DEFAULT 'auto';
        ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS submission_provider TEXT;
        ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS confirmation_reference TEXT;
        CREATE INDEX IF NOT EXISTS job_applications_user_status_idx
            ON job_applications (username, status, updated_at DESC);
        CREATE TABLE IF NOT EXISTS job_application_events (
            id BIGSERIAL PRIMARY KEY,
            application_id INTEGER NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
            event_type VARCHAR(40) NOT NULL,
            detail TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS job_messages (
            id BIGSERIAL PRIMARY KEY,
            username VARCHAR(20) NOT NULL REFERENCES job_users(username) ON DELETE CASCADE,
            application_id INTEGER REFERENCES job_applications(id) ON DELETE CASCADE,
            direction VARCHAR(12) NOT NULL DEFAULT 'inbound',
            sender TEXT NOT NULL,
            subject TEXT,
            body TEXT NOT NULL,
            read_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS job_notifications (
            id BIGSERIAL PRIMARY KEY,
            username VARCHAR(20) NOT NULL REFERENCES job_users(username) ON DELETE CASCADE,
            kind VARCHAR(40) NOT NULL,
            title TEXT NOT NULL,
            body TEXT,
            link TEXT,
            read_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
})();
ready.catch(error => {
    console.error('Database initialization failed:', error.message);
    setTimeout(() => process.exit(1), 0);
});

const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === undefined
        ? process.env.NODE_ENV === 'production'
        : process.env.COOKIE_SECURE === 'true',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
};
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

function signSession(username) {
    return jwt.sign({ jobUsername: username }, JWT_SECRET, { expiresIn: '7d' });
}

function requireAuth(req, res, next) {
    try {
        const payload = jwt.verify(req.cookies.jobs_token || '', JWT_SECRET);
        if (!payload.jobUsername) throw new Error('Invalid session payload.');
        req.jobUsername = payload.jobUsername;
        next();
    } catch (_) {
        res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    }
}

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

async function hagentCli(argv) {
    if (!(HAGENT_URL && HAGENT_TOKEN)) throw new Error('Hagent integration is not configured.');
    const response = await fetch(`${HAGENT_URL}/api/cli`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${HAGENT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ argv }),
        signal: AbortSignal.timeout(360000),
    });
    if (!response.ok) throw new Error(`Hagent returned HTTP ${response.status}`);
    const result = await response.json();
    if (result.exit_code !== 0) throw new Error(String(result.stderr || result.stdout || 'Hagent command failed').trim());
    return String(result.stdout || '');
}

function parseCreatedIssue(output) {
    const match = output.match(/Created issue ([0-9a-f-]{36})/i);
    if (!match) throw new Error('Hagent did not return a new issue ID.');
    return match[1];
}

function parseLastJson(output) {
    const raw = String(output || '');
    const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
    for (let index = fenced.length - 1; index >= 0; index -= 1) {
        try { return JSON.parse(fenced[index][1].trim()); } catch (_) { /* try an earlier fence */ }
    }
    const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    for (let index = cleaned.lastIndexOf('{'); index >= 0;) {
        try { return JSON.parse(cleaned.slice(index)); } catch (_) { /* try an earlier object */ }
        if (index === 0) break;
        index = cleaned.lastIndexOf('{', index - 1);
    }
    return null;
}

async function completedHagentOutput(issueId) {
    const details = await hagentCli(['issue', 'get', issueId]);
    const status = details.match(/^status:\s*(\S+)/m)?.[1] || '';
    if (!['in_review', 'done'].includes(status)) return null;
    const runs = await hagentCli(['issue', 'runs', issueId]);
    const completed = runs.split('\n').find(line => /\scompleted\s/i.test(line));
    const runId = completed?.match(/^([0-9a-f-]{36})/)?.[1];
    return runId ? await hagentCli(['issue', 'run-messages', runId]) : null;
}

function applicationPrompt(job, resumeText) {
    return [
        'Tailor the source resume for this exact job without inventing or upgrading any fact.',
        'Return exactly one JSON object in a ```json fenced block with this schema:',
        '{"resume_markdown":"string","cover_letter":"string","alignment_summary":"string","keywords_used":[],"factual_changes":[],"missing_requirements":[],"submission_recommendation":"PASS|NEEDS_REVIEW"}',
        '', `JOB TITLE: ${job.title}`, `COMPANY: ${job.company || 'Not listed'}`,
        `LOCATION: ${job.location || 'Not listed'}`, `APPLICATION URL: ${job.apply_url}`,
        '', 'JOB DESCRIPTION:', String(job.description || '').slice(0, 24000),
        '', 'SOURCE RESUME (the only allowed source of candidate facts):', String(resumeText || '').slice(0, 32000),
    ].join('\n');
}

async function recordApplicationEvent(applicationId, eventType, detail = null) {
    await pool.query(
        'INSERT INTO job_application_events (application_id,event_type,detail) VALUES ($1,$2,$3)',
        [applicationId, eventType, detail]
    );
}

async function submitApplication(applicationId, username) {
    const result = await pool.query(
        `SELECT a.*,p.title,p.company,p.location,p.apply_url,p.description,p.source,
                u.email,pr.full_name,pr.phone,pr.city,pr.state,pr.linkedin_url,pr.portfolio_url,
                pr.work_authorization,pr.application_mode
         FROM job_applications a JOIN job_postings p ON p.id=a.job_id
         JOIN job_users u ON u.username=a.username
         LEFT JOIN job_profiles pr ON pr.username=a.username
         WHERE a.id=$1 AND a.username=$2`, [applicationId, username]
    );
    if (!result.rows.length) throw Object.assign(new Error('Application not found.'), { statusCode: 404 });
    const application = result.rows[0];
    if (application.status !== 'ready_to_submit') {
        throw Object.assign(new Error('The application has not passed quality review.'), { statusCode: 409 });
    }
    if (!SUBMISSION_RUNNER_URL) {
        await pool.query(
            `UPDATE job_applications SET status='action_required',error=$2,updated_at=now() WHERE id=$1`,
            [applicationId, 'This employer portal needs a supported submission connector. Open the tracked link to finish safely.']
        );
        await recordApplicationEvent(applicationId, 'action_required', 'No supported automatic submission connector.');
        return { status: 'action_required' };
    }
    await pool.query("UPDATE job_applications SET status='submitting',error=NULL,updated_at=now() WHERE id=$1", [applicationId]);
    await recordApplicationEvent(applicationId, 'submission_started', application.apply_url);
    try {
        const response = await fetch(`${SUBMISSION_RUNNER_URL}/submit`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(SUBMISSION_RUNNER_TOKEN ? { Authorization: `Bearer ${SUBMISSION_RUNNER_TOKEN}` } : {}),
            },
            body: JSON.stringify({
                applicationId, applyUrl: application.apply_url,
                job: { title: application.title, company: application.company, location: application.location, description: application.description, source: application.source },
                candidate: { fullName: application.full_name, email: application.email, phone: application.phone, city: application.city,
                    state: application.state, linkedInUrl: application.linkedin_url, portfolioUrl: application.portfolio_url,
                    workAuthorization: application.work_authorization },
                documents: { resumeMarkdown: application.tailored_resume, coverLetter: application.cover_letter },
            }),
            signal: AbortSignal.timeout(120000),
        });
        const outcome = await response.json().catch(() => ({}));
        if (!response.ok || !['submitted', 'action_required', 'unsupported'].includes(outcome.status)) {
            throw new Error(outcome.error || `Submission runner returned HTTP ${response.status}`);
        }
        if (outcome.status === 'submitted' && outcome.confirmationReference) {
            await pool.query(
                `UPDATE job_applications SET status='applied',applied_at=now(),confirmation_reference=$2,
                 submission_provider=$3,error=NULL,updated_at=now() WHERE id=$1`,
                [applicationId, String(outcome.confirmationReference).slice(0, 500), String(outcome.provider || 'submission-runner').slice(0, 100)]
            );
            await recordApplicationEvent(applicationId, 'submitted', String(outcome.confirmationReference));
            return { status: 'applied' };
        }
        const reason = String(outcome.reason || (outcome.status === 'unsupported' ? 'This employer portal is not supported yet.' : 'Login or an unanswered question is required.')).slice(0, 1000);
        await pool.query(
            `UPDATE job_applications SET status='action_required',requires_login=$2,error=$3,updated_at=now() WHERE id=$1`,
            [applicationId, Boolean(outcome.requiresLogin), reason]
        );
        await recordApplicationEvent(applicationId, 'action_required', reason);
        return { status: 'action_required' };
    } catch (error) {
        await pool.query("UPDATE job_applications SET status='needs_review',error=$2,updated_at=now() WHERE id=$1", [applicationId, error.message]);
        await recordApplicationEvent(applicationId, 'submission_failed', error.message);
        throw error;
    }
}

async function syncApplication(row) {
    if (row.status === 'tailoring' && row.hagent_issue_id) {
        const output = await completedHagentOutput(row.hagent_issue_id);
        if (output) {
            const tailored = parseLastJson(output);
            if (!tailored?.resume_markdown) throw new Error('Recruiter output was not valid structured resume JSON.');
            const reviewPrompt = [
                'Independently audit this tailored resume for truthfulness, relevance, clarity, and ATS readability.',
                'Return exactly one JSON object in a ```json fenced block with this schema:',
                '{"verdict":"PASS|FAIL","score":0,"unsupported_claims":[],"missing_requirements":[],"notes":"string"}',
                '', 'SOURCE RESUME:', String(row.resume_text || '').slice(0, 24000),
                '', 'JOB DESCRIPTION:', String(row.description || '').slice(0, 18000),
                '', 'TAILORED RESULT:', JSON.stringify(tailored).slice(0, 30000),
            ].join('\n');
            const created = await hagentCli(['issue', 'create', '--project', HAGENT_PROJECT_ID,
                '--title', `Review tailored resume: ${row.title}`, '--description', reviewPrompt,
                '--assignee', HAGENT_REVIEWER_AGENT_ID, '--status', 'todo']);
            await pool.query(
                `UPDATE job_applications SET status='verifying',reviewer_issue_id=$2,tailored_resume=$3,
                 cover_letter=$4,quality_notes=$5,updated_at=now() WHERE id=$1`,
                [row.id, parseCreatedIssue(created), tailored.resume_markdown,
                    tailored.cover_letter || '', JSON.stringify(tailored.alignment_summary || '')]
            );
            await recordApplicationEvent(row.id, 'tailoring_complete', 'Independent resume review started.');
        }
    } else if (row.status === 'verifying' && row.reviewer_issue_id) {
        const output = await completedHagentOutput(row.reviewer_issue_id);
        if (output) {
            const review = parseLastJson(output);
            const score = Number(review?.score || 0);
            const passed = review?.verdict === 'PASS' && score >= 85 && !(review.unsupported_claims || []).length;
            await pool.query(
                `UPDATE job_applications SET status=$2,quality_score=$3,quality_verdict=$4,
                 quality_notes=$5,updated_at=now() WHERE id=$1`,
                [row.id, passed ? 'ready_to_submit' : 'needs_review', score,
                    review?.verdict || 'FAIL', JSON.stringify(review || {})]
            );
            await recordApplicationEvent(row.id, passed ? 'quality_passed' : 'quality_failed', JSON.stringify(review || {}));
            if (passed) {
                const profile = await pool.query('SELECT application_mode FROM job_profiles WHERE username=$1', [row.username]);
                if ((profile.rows[0]?.application_mode || 'auto') === 'auto') await submitApplication(row.id, row.username);
            }
        }
    }
}

app.get('/health', async (_req, res) => {
    try {
        await ready;
        await pool.query('SELECT 1');
        res.json({ ok: true });
    } catch (_) {
        res.status(503).json({ ok: false });
    }
});

app.get(['/jobs', '/jobs/'], (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.post('/api/jobs/auth/signup', authLimiter, async (req, res) => {
    const { username, email, password } = req.body || {};
    if (!USERNAME_PATTERN.test(username || '')) return res.status(400).json({ error: 'Username must be 3-20 characters using letters, numbers, or underscore.' });
    if (!EMAIL_PATTERN.test(email || '')) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    try {
        await ready;
        const hash = await bcrypt.hash(password, 12);
        const result = await pool.query(
            'INSERT INTO job_users (username,email,password_hash) VALUES ($1,$2,$3) RETURNING username',
            [username.toLowerCase(), email.toLowerCase(), hash]
        );
        res.cookie('jobs_token', signSession(result.rows[0].username), COOKIE_OPTIONS);
        res.status(201).json({ username: result.rows[0].username });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'That username or email is already registered.' });
        console.error('signup failed:', error.message);
        res.status(500).json({ error: 'Unable to create the account.' });
    }
});

app.post('/api/jobs/auth/login', authLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    try {
        await ready;
        const result = await pool.query('SELECT username,password_hash FROM job_users WHERE username=$1', [String(username || '').toLowerCase()]);
        if (!result.rows.length || !await bcrypt.compare(String(password || ''), result.rows[0].password_hash)) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }
        res.cookie('jobs_token', signSession(result.rows[0].username), COOKIE_OPTIONS);
        res.json({ username: result.rows[0].username });
    } catch (error) {
        console.error('login failed:', error.message);
        res.status(500).json({ error: 'Unable to log in.' });
    }
});

app.post('/api/jobs/auth/logout', (_req, res) => {
    res.clearCookie('jobs_token', COOKIE_OPTIONS);
    res.json({ ok: true });
});
app.get('/api/jobs/auth/me', requireAuth, (req, res) => res.json({ username: req.jobUsername }));

const PROFILE_DEFAULTS = {
    workStyle: 'any', salaryMin: null, salaryMax: null, educationLevel: 'any',
    experienceYears: null, employmentType: 'any', sponsorship: 'any', skills: '', fullName: '',
    phone: '', city: '', state: '', linkedInUrl: '', portfolioUrl: '', workAuthorization: '',
    applicationMode: 'auto',
};

app.get('/api/jobs/profile', requireAuth, asyncRoute(async (req, res) => {
    const [roles, locations, profile] = await Promise.all([
        pool.query('SELECT id,role FROM job_roles WHERE username=$1 ORDER BY created_at', [req.jobUsername]),
        pool.query('SELECT id,location FROM job_locations WHERE username=$1 ORDER BY created_at', [req.jobUsername]),
        pool.query(
            `SELECT work_style AS "workStyle",salary_min AS "salaryMin",salary_max AS "salaryMax",
                    education_level AS "educationLevel",experience_years AS "experienceYears",
                    employment_type AS "employmentType",sponsorship,skills,full_name AS "fullName",
                    phone,city,state,linkedin_url AS "linkedInUrl",portfolio_url AS "portfolioUrl",
                    work_authorization AS "workAuthorization",application_mode AS "applicationMode"
             FROM job_profiles WHERE username=$1`,
            [req.jobUsername]
        ),
    ]);
    res.json({ roles: roles.rows, locations: locations.rows, profile: { ...PROFILE_DEFAULTS, ...(profile.rows[0] || {}) } });
}));

app.post('/api/jobs/profile/roles', requireAuth, asyncRoute(async (req, res) => {
    const role = String(req.body?.role || '').trim();
    if (!role || role.length > 100) return res.status(400).json({ error: 'Enter a role up to 100 characters.' });
    try {
        const result = await pool.query('INSERT INTO job_roles (username,role) VALUES ($1,$2) RETURNING id,role', [req.jobUsername, role]);
        res.status(201).json({ role: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'You are already tracking that role.' });
        throw error;
    }
}));

app.delete('/api/jobs/profile/roles/:id', requireAuth, asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM job_roles WHERE id=$1 AND username=$2', [req.params.id, req.jobUsername]);
    res.json({ ok: true });
}));

app.post('/api/jobs/profile/locations', requireAuth, asyncRoute(async (req, res) => {
    const location = String(req.body?.location || '').trim();
    if (!location || location.length > 100) return res.status(400).json({ error: 'Enter a location up to 100 characters.' });
    try {
        const result = await pool.query('INSERT INTO job_locations (username,location) VALUES ($1,$2) RETURNING id,location', [req.jobUsername, location]);
        res.status(201).json({ location: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'You already added that location.' });
        throw error;
    }
}));

app.delete('/api/jobs/profile/locations/:id', requireAuth, asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM job_locations WHERE id=$1 AND username=$2', [req.params.id, req.jobUsername]);
    res.json({ ok: true });
}));

app.put('/api/jobs/profile', requireAuth, asyncRoute(async (req, res) => {
    const {
        workStyle = 'any', salaryMin, salaryMax, educationLevel = 'any', experienceYears,
        employmentType = 'any', sponsorship = 'any', skills = '', fullName = '', phone = '',
        city = '', state = '', linkedInUrl = '', portfolioUrl = '', workAuthorization = '',
        applicationMode = 'auto',
    } = req.body || {};
    if (!['any', 'remote', 'hybrid', 'onsite'].includes(workStyle)) return res.status(400).json({ error: 'Invalid work style.' });
    if (!['any', 'high_school', 'associate', 'bachelor', 'master', 'doctorate'].includes(educationLevel)) return res.status(400).json({ error: 'Invalid education level.' });
    if (!['any', 'full_time', 'part_time', 'contract', 'internship'].includes(employmentType)) return res.status(400).json({ error: 'Invalid employment type.' });
    if (!['any', 'required', 'not_required'].includes(sponsorship)) return res.status(400).json({ error: 'Invalid sponsorship preference.' });
    if (!['auto', 'hybrid', 'review'].includes(applicationMode)) return res.status(400).json({ error: 'Invalid application mode.' });
    const optionalNumber = value => value === '' || value === null || value === undefined ? null : Number(value);
    const min = optionalNumber(salaryMin); const max = optionalNumber(salaryMax); const years = optionalNumber(experienceYears);
    if ((min !== null && (!Number.isInteger(min) || min < 0 || min > 10000000)) || (max !== null && (!Number.isInteger(max) || max < 0 || max > 10000000))) {
        return res.status(400).json({ error: 'Salary values must be whole numbers between 0 and 10,000,000.' });
    }
    if (min !== null && max !== null && max < min) return res.status(400).json({ error: 'Maximum salary cannot be lower than minimum salary.' });
    if (years !== null && (!Number.isInteger(years) || years < 0 || years > 60)) return res.status(400).json({ error: 'Experience must be between 0 and 60 years.' });
    const skillText = String(skills).trim();
    if (skillText.length > 1000) return res.status(400).json({ error: 'Skills must be 1,000 characters or fewer.' });
    const clean = (value, max) => String(value || '').trim().slice(0, max);
    const url = (value, label) => {
        const result = clean(value, 500);
        if (result && !/^https:\/\//i.test(result)) throw Object.assign(new Error(`${label} must start with https://`), { statusCode: 400 });
        return result || null;
    };
    let linkedIn; let portfolio;
    try { linkedIn = url(linkedInUrl, 'LinkedIn URL'); portfolio = url(portfolioUrl, 'Portfolio URL'); }
    catch (error) { return res.status(error.statusCode).json({ error: error.message }); }
    const result = await pool.query(
        `INSERT INTO job_profiles (username,work_style,salary_min,salary_max,education_level,experience_years,employment_type,sponsorship,skills,
             full_name,phone,city,state,linkedin_url,portfolio_url,work_authorization,application_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (username) DO UPDATE SET work_style=$2,salary_min=$3,salary_max=$4,education_level=$5,
             experience_years=$6,employment_type=$7,sponsorship=$8,skills=$9,full_name=$10,phone=$11,city=$12,
             state=$13,linkedin_url=$14,portfolio_url=$15,work_authorization=$16,application_mode=$17,updated_at=now()
         RETURNING work_style AS "workStyle",salary_min AS "salaryMin",salary_max AS "salaryMax",
                   education_level AS "educationLevel",experience_years AS "experienceYears",
                   employment_type AS "employmentType",sponsorship,skills,full_name AS "fullName",phone,city,state,
                   linkedin_url AS "linkedInUrl",portfolio_url AS "portfolioUrl",work_authorization AS "workAuthorization",
                   application_mode AS "applicationMode"`,
        [req.jobUsername, workStyle, min, max, educationLevel, years, employmentType, sponsorship, skillText || null,
            clean(fullName, 160) || null, clean(phone, 40) || null, clean(city, 100) || null, clean(state, 100) || null,
            linkedIn, portfolio, clean(workAuthorization, 200) || null, applicationMode]
    );
    res.json({ profile: result.rows[0] });
}));

const resumeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
app.post('/api/jobs/resume', requireAuth, resumeUpload.single('resume'), async (req, res) => {
    try {
        let text = String(req.body?.resumeText || '').trim();
        let filename = null;
        if (req.file) {
            if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Only PDF resumes are accepted.' });
            text = String((await pdfParse(req.file.buffer)).text || '').trim();
            filename = path.basename(req.file.originalname).slice(0, 255);
        }
        if (!text) return res.status(400).json({ error: 'The resume contains no readable text.' });
        if (text.length > 200000) return res.status(400).json({ error: 'Resume text is too long.' });
        await pool.query(
            `INSERT INTO resumes (username,resume_text,original_filename) VALUES ($1,$2,$3)
             ON CONFLICT (username) DO UPDATE SET resume_text=$2,original_filename=$3,uploaded_at=now()`,
            [req.jobUsername, text, filename]
        );
        res.json({ ok: true, length: text.length });
    } catch (error) {
        console.error('resume upload failed:', error.message);
        res.status(400).json({ error: 'Unable to read that resume.' });
    }
});

app.get('/api/jobs/resume', requireAuth, asyncRoute(async (req, res) => {
    const result = await pool.query(
        'SELECT original_filename AS "originalFilename",uploaded_at AS "uploadedAt",length(resume_text)::int AS length FROM resumes WHERE username=$1',
        [req.jobUsername]
    );
    res.json({ resume: result.rows[0] || null });
}));

app.get('/api/jobs/recommendations', requireAuth, async (req, res) => {
    try {
        await ready;
        const [rolesResult, locationsResult, profileResult, resumeResult] = await Promise.all([
            pool.query('SELECT role FROM job_roles WHERE username=$1', [req.jobUsername]),
            pool.query('SELECT location FROM job_locations WHERE username=$1', [req.jobUsername]),
            pool.query(
                `SELECT work_style AS remote_pref,salary_min,salary_max,education_level,experience_years,
                        employment_type,sponsorship,skills FROM job_profiles WHERE username=$1`,
                [req.jobUsername]
            ),
            pool.query('SELECT resume_text FROM resumes WHERE username=$1', [req.jobUsername]),
        ]);
        if (!rolesResult.rows.length) return res.json({ recommendations: [], message: 'Add a job role to get recommendations.' });
        const profile = profileResult.rows[0] || { remote_pref: 'any', education_level: 'any', employment_type: 'any', sponsorship: 'any', skills: '' };
        const locations = locationsResult.rows.length ? locationsResult.rows : [{ location: null }];
        const preferences = rolesResult.rows.flatMap(role => locations.map(location => ({ ...profile, role: role.role, location: location.location })));
        await jobService.refreshForPreferences(preferences);
        const candidateText = `${profile.skills || ''} ${resumeResult.rows[0]?.resume_text || ''}`.trim();
        const recommendations = await jobService.recommendations(preferences, candidateText);
        res.json({ recommendations });
    } catch (error) {
        console.error('recommendations failed:', error.message);
        res.status(502).json({ error: 'Unable to refresh job recommendations right now.' });
    }
});

app.get('/api/jobs/status', requireAuth, asyncRoute(async (_req, res) => {
    await ready;
    res.json(await jobService.status());
}));

app.post('/api/jobs/applications', requireAuth, asyncRoute(async (req, res) => {
    if (!(HAGENT_URL && HAGENT_TOKEN && HAGENT_PROJECT_ID && HAGENT_RECRUITER_AGENT_ID && HAGENT_REVIEWER_AGENT_ID)) {
        return res.status(503).json({ error: 'The Hagent recruiter is not configured yet.' });
    }
    const jobId = String(req.body?.jobId || '');
    const [jobResult, resumeResult] = await Promise.all([
        pool.query('SELECT * FROM job_postings WHERE id=$1 AND active=true', [jobId]),
        pool.query('SELECT resume_text FROM resumes WHERE username=$1', [req.jobUsername]),
    ]);
    if (!jobResult.rows.length) return res.status(404).json({ error: 'That job is no longer available.' });
    if (!resumeResult.rows.length) return res.status(400).json({ error: 'Upload your source resume before starting an application.' });
    const job = jobResult.rows[0];
    const existing = await pool.query('SELECT * FROM job_applications WHERE username=$1 AND job_id=$2', [req.jobUsername, jobId]);
    if (existing.rows.length) return res.status(409).json({ error: 'This job is already in your application tracker.', application: existing.rows[0] });
    const created = await hagentCli(['issue', 'create', '--project', HAGENT_PROJECT_ID,
        '--title', `Tailor resume: ${job.title} at ${job.company || 'Unknown company'}`,
        '--description', applicationPrompt(job, resumeResult.rows[0].resume_text),
        '--assignee', HAGENT_RECRUITER_AGENT_ID, '--status', 'todo']);
    const result = await pool.query(
        `INSERT INTO job_applications (username,job_id,hagent_issue_id,status,requires_login)
         VALUES ($1,$2,$3,'tailoring',false) RETURNING *`,
        [req.jobUsername, jobId, parseCreatedIssue(created)]
    );
    await recordApplicationEvent(result.rows[0].id, 'created', 'Resume tailoring queued with Hagent.');
    res.status(202).json({ application: result.rows[0] });
}));

app.get('/api/jobs/applications', requireAuth, asyncRoute(async (req, res) => {
    let rows = (await pool.query(
        `SELECT a.*,p.title,p.company,p.location,p.apply_url,p.source,p.description,r.resume_text
         FROM job_applications a JOIN job_postings p ON p.id=a.job_id
         LEFT JOIN resumes r ON r.username=a.username
         WHERE a.username=$1 ORDER BY a.updated_at DESC`, [req.jobUsername]
    )).rows;
    for (const row of rows.filter(item => ['tailoring', 'verifying'].includes(item.status))) {
        try { await syncApplication(row); }
        catch (error) {
            await pool.query("UPDATE job_applications SET status='needs_review',error=$2,updated_at=now() WHERE id=$1", [row.id, error.message]);
        }
    }
    rows = (await pool.query(
        `SELECT a.id,a.job_id,a.status,a.tailored_resume,a.cover_letter,a.quality_score,a.quality_verdict,
                a.quality_notes,a.requires_login,a.submission_mode,a.submission_provider,a.confirmation_reference,
                a.error,a.created_at,a.updated_at,a.applied_at,
                p.title,p.company,p.location,p.apply_url AS "applyUrl",p.source
         FROM job_applications a JOIN job_postings p ON p.id=a.job_id
         WHERE a.username=$1 ORDER BY a.updated_at DESC`, [req.jobUsername]
    )).rows;
    res.json({ applications: rows });
}));

app.post('/api/jobs/applications/:id/submit', requireAuth, asyncRoute(async (req, res) => {
    const outcome = await submitApplication(Number(req.params.id), req.jobUsername);
    res.status(outcome.status === 'applied' ? 200 : 202).json(outcome);
}));

app.get('/api/jobs/applications/:id/events', requireAuth, asyncRoute(async (req, res) => {
    const result = await pool.query(
        `SELECT e.id,e.event_type AS "eventType",e.detail,e.created_at AS "createdAt"
         FROM job_application_events e JOIN job_applications a ON a.id=e.application_id
         WHERE e.application_id=$1 AND a.username=$2 ORDER BY e.created_at`,
        [req.params.id, req.jobUsername]
    );
    res.json({ events: result.rows });
}));

app.post('/api/jobs/applications/:id/action-required', requireAuth, asyncRoute(async (req, res) => {
    const reason = String(req.body?.reason || 'login_required');
    const result = await pool.query(
        `UPDATE job_applications SET status='action_required',requires_login=$3,
         quality_notes=COALESCE(quality_notes,'') || $4,updated_at=now()
         WHERE id=$1 AND username=$2 RETURNING *`,
        [req.params.id, req.jobUsername, reason === 'login_required', `\nAction required: ${reason}`]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Application not found.' });
    res.json({ application: result.rows[0] });
}));

app.post('/api/jobs/applications/:id/applied', requireAuth, asyncRoute(async (req, res) => {
    const result = await pool.query(
        `UPDATE job_applications SET status='applied',applied_at=now(),updated_at=now()
         WHERE id=$1 AND username=$2 AND status IN ('ready_to_submit','action_required') RETURNING *`,
        [req.params.id, req.jobUsername]
    );
    if (!result.rows.length) return res.status(409).json({ error: 'Application is not ready to mark as applied.' });
    res.json({ application: result.rows[0] });
}));

app.get('/api/jobs/applications/:id/resume', requireAuth, asyncRoute(async (req, res) => {
    const result = await pool.query(
        'SELECT tailored_resume FROM job_applications WHERE id=$1 AND username=$2',
        [req.params.id, req.jobUsername]
    );
    if (!result.rows.length || !result.rows[0].tailored_resume) return res.status(404).json({ error: 'Tailored resume is not ready.' });
    res.type('text/markdown').attachment(`tailored-resume-${req.params.id}.md`).send(result.rows[0].tailored_resume);
}));

app.get('/api/jobs/messages', requireAuth, asyncRoute(async (req, res) => {
    const result = await pool.query(
        `SELECT m.id,m.application_id AS "applicationId",m.direction,m.sender,m.subject,m.body,
                m.read_at AS "readAt",m.created_at AS "createdAt",p.title,p.company
         FROM job_messages m LEFT JOIN job_applications a ON a.id=m.application_id
         LEFT JOIN job_postings p ON p.id=a.job_id
         WHERE m.username=$1 ORDER BY m.created_at DESC LIMIT 200`, [req.jobUsername]
    );
    res.json({ messages: result.rows });
}));

app.post('/api/jobs/messages/:id/read', requireAuth, asyncRoute(async (req, res) => {
    await pool.query('UPDATE job_messages SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND username=$2', [req.params.id, req.jobUsername]);
    res.json({ ok: true });
}));

app.get('/api/jobs/notifications', requireAuth, asyncRoute(async (req, res) => {
    const result = await pool.query(
        `SELECT id,kind,title,body,link,read_at AS "readAt",created_at AS "createdAt"
         FROM job_notifications WHERE username=$1 ORDER BY created_at DESC LIMIT 100`, [req.jobUsername]
    );
    res.json({ notifications: result.rows });
}));

app.post('/api/jobs/notifications/:id/read', requireAuth, asyncRoute(async (req, res) => {
    await pool.query('UPDATE job_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND username=$2', [req.params.id, req.jobUsername]);
    res.json({ ok: true });
}));

app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.message });
    console.error('request failed:', error.message);
    res.status(500).json({ error: 'Unexpected server error.' });
});

const server = app.listen(PORT, () => console.log(`Job Portal listening on port ${PORT}`));
async function shutdown() {
    jobService.stop();
    server.close(async () => { await pool.end(); process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app };
