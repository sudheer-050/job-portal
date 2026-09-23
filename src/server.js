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
if (!JWT_SECRET) throw new Error('JWT_SECRET is required in production.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const app = express();
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const jobService = createJobService({ pool });

const ready = Promise.all([
    pool.query(`
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
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS resumes (
            username VARCHAR(20) PRIMARY KEY REFERENCES job_users(username) ON DELETE CASCADE,
            resume_text TEXT NOT NULL,
            original_filename TEXT,
            uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
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
    `),
    jobService.initialize(),
]);
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

app.get('/health', async (_req, res) => {
    try {
        await ready;
        await pool.query('SELECT 1');
        res.json({ ok: true });
    } catch (_) {
        res.status(503).json({ ok: false });
    }
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
    experienceYears: null, employmentType: 'any', sponsorship: 'any', skills: '',
};

app.get('/api/jobs/profile', requireAuth, asyncRoute(async (req, res) => {
    const [roles, locations, profile] = await Promise.all([
        pool.query('SELECT id,role FROM job_roles WHERE username=$1 ORDER BY created_at', [req.jobUsername]),
        pool.query('SELECT id,location FROM job_locations WHERE username=$1 ORDER BY created_at', [req.jobUsername]),
        pool.query(
            `SELECT work_style AS "workStyle",salary_min AS "salaryMin",salary_max AS "salaryMax",
                    education_level AS "educationLevel",experience_years AS "experienceYears",
                    employment_type AS "employmentType",sponsorship,skills
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
        employmentType = 'any', sponsorship = 'any', skills = '',
    } = req.body || {};
    if (!['any', 'remote', 'hybrid', 'onsite'].includes(workStyle)) return res.status(400).json({ error: 'Invalid work style.' });
    if (!['any', 'high_school', 'associate', 'bachelor', 'master', 'doctorate'].includes(educationLevel)) return res.status(400).json({ error: 'Invalid education level.' });
    if (!['any', 'full_time', 'part_time', 'contract', 'internship'].includes(employmentType)) return res.status(400).json({ error: 'Invalid employment type.' });
    if (!['any', 'required', 'not_required'].includes(sponsorship)) return res.status(400).json({ error: 'Invalid sponsorship preference.' });
    const optionalNumber = value => value === '' || value === null || value === undefined ? null : Number(value);
    const min = optionalNumber(salaryMin); const max = optionalNumber(salaryMax); const years = optionalNumber(experienceYears);
    if ((min !== null && (!Number.isInteger(min) || min < 0 || min > 10000000)) || (max !== null && (!Number.isInteger(max) || max < 0 || max > 10000000))) {
        return res.status(400).json({ error: 'Salary values must be whole numbers between 0 and 10,000,000.' });
    }
    if (min !== null && max !== null && max < min) return res.status(400).json({ error: 'Maximum salary cannot be lower than minimum salary.' });
    if (years !== null && (!Number.isInteger(years) || years < 0 || years > 60)) return res.status(400).json({ error: 'Experience must be between 0 and 60 years.' });
    const skillText = String(skills).trim();
    if (skillText.length > 1000) return res.status(400).json({ error: 'Skills must be 1,000 characters or fewer.' });
    const result = await pool.query(
        `INSERT INTO job_profiles (username,work_style,salary_min,salary_max,education_level,experience_years,employment_type,sponsorship,skills)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (username) DO UPDATE SET work_style=$2,salary_min=$3,salary_max=$4,education_level=$5,
             experience_years=$6,employment_type=$7,sponsorship=$8,skills=$9,updated_at=now()
         RETURNING work_style AS "workStyle",salary_min AS "salaryMin",salary_max AS "salaryMax",
                   education_level AS "educationLevel",experience_years AS "experienceYears",
                   employment_type AS "employmentType",sponsorship,skills`,
        [req.jobUsername, workStyle, min, max, educationLevel, years, employmentType, sponsorship, skillText || null]
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
