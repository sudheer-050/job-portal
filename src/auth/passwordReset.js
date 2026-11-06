'use strict';

// Forgot-password flow.
//  - POST /api/jobs/auth/forgot  { identifier }          always answers the same way (no account enumeration)
//  - POST /api/jobs/auth/reset   { token, password }     single-use, 30-minute token
//  - GET  /jobs/reset                                    standalone page; the token travels in the URL fragment,
//                                                        so it is never sent to a server, proxy log or Referer header
// Only a SHA-256 hash of each token is stored. Delivery is by SMTP (see createMailer).

const crypto = require('node:crypto');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');

const TOKEN_TTL_MINUTES = 30;
const MAX_REQUESTS_PER_HOUR = 3;
const GENERIC_MESSAGE = `If an account matches, a password reset link has been sent to its email address. The link expires in ${TOKEN_TTL_MINUTES} minutes.`;
const INVALID_TOKEN = 'This reset link is invalid or has expired. Request a new one.';

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');
const validTokenShape = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function composeResetEmail({ username, link, minutes = TOKEN_TTL_MINUTES }) {
    const text = [
        `Hi ${username},`, '',
        'We received a request to reset your Job Portal password. Open this link to choose a new one:', '',
        link, '',
        `The link works once and expires in ${minutes} minutes. If you did not ask for this, you can ignore this email; your password will not change.`,
    ].join('\n');
    const html = `<p>Hi ${escapeHtml(username)},</p><p>We received a request to reset your Job Portal password.</p>` +
        `<p><a href="${escapeHtml(link)}">Choose a new password</a></p>` +
        `<p>The link works once and expires in ${minutes} minutes. If you did not ask for this, you can ignore this email; your password will not change.</p>`;
    return { subject: 'Reset your Job Portal password', text, html };
}

/**
 * SMTP mailer. Needs SMTP_HOST and SMTP_FROM (plus SMTP_USER / SMTP_PASS for most providers).
 * Without SMTP nothing is sent; set PASSWORD_RESET_LOG_LINKS=true to print the link to the server log instead
 * (owner-assisted mode: anyone who can read the server log can then reset that account).
 */
function createMailer(env = process.env, logger = console, createTransport = options => require('nodemailer').createTransport(options)) {
    const configured = Boolean(env.SMTP_HOST && env.SMTP_FROM);
    let transport = null;
    return {
        configured,
        async send({ to, username, link }) {
            const message = composeResetEmail({ username, link });
            if (!configured) {
                if (env.PASSWORD_RESET_LOG_LINKS === 'true') logger.log(`[password-reset] link for ${username}: ${link}`);
                else logger.warn('[password-reset] SMTP is not configured, so no email was sent.');
                return { sent: false };
            }
            transport = transport || createTransport({
                host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587), secure: env.SMTP_SECURE === 'true',
                auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
            });
            await transport.sendMail({ from: env.SMTP_FROM, to, ...message });
            return { sent: true };
        },
    };
}

/** Business logic with an injected store, so it is testable without a database. */
function createPasswordResetService({ store, sendMail, baseUrl, now = () => Date.now(), bcryptRounds = 12, logger = console }) {
    return {
        async requestReset(identifier) {
            const id = String(identifier || '').trim().toLowerCase().slice(0, 255);
            if (!id) return { issued: false };
            const user = await store.findUser(id);
            if (!user) return { issued: false };
            const since = new Date(now() - 60 * 60 * 1000);
            if (await store.countRecentRequests(user.username, since) >= MAX_REQUESTS_PER_HOUR) return { issued: false, throttled: true };
            const token = newToken();
            await store.createToken({ username: user.username, tokenHash: hashToken(token), expiresAt: new Date(now() + TOKEN_TTL_MINUTES * 60 * 1000), now: new Date(now()) });
            const link = `${baseUrl}/jobs/reset#token=${token}`;
            try { await sendMail({ to: user.email, username: user.username, link }); }
            catch (error) { logger.error('[password-reset] email failed:', error.message); }
            return { issued: true };
        },
        async completeReset(token, password) {
            if (!validTokenShape(token)) return { ok: false, error: INVALID_TOKEN };
            if (typeof password !== 'string' || password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
            if (password.length > 128) return { ok: false, error: 'Password must be 128 characters or fewer.' };
            const passwordHash = await bcrypt.hash(password, bcryptRounds);
            const username = await store.consumeToken({ tokenHash: hashToken(token), passwordHash, now: new Date(now()) });
            return username ? { ok: true } : { ok: false, error: INVALID_TOKEN };
        },
    };
}

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS job_password_resets (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(20) NOT NULL REFERENCES job_users(username) ON DELETE CASCADE,
        token_hash CHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS job_password_resets_user_idx ON job_password_resets (username, created_at DESC);
`;

function createPgStore(pool) {
    return {
        async findUser(id) {
            // Usernames cannot contain "@" and emails always do, so one value never matches two accounts.
            const result = await pool.query('SELECT username,email FROM job_users WHERE lower(username)=$1 OR lower(email)=$1 LIMIT 1', [id]);
            return result.rows[0] || null;
        },
        async countRecentRequests(username, since) {
            const result = await pool.query('SELECT count(*)::int AS n FROM job_password_resets WHERE username=$1 AND created_at > $2', [username, since]);
            return result.rows[0].n;
        },
        async createToken({ username, tokenHash, expiresAt, now }) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query("DELETE FROM job_password_resets WHERE created_at < now() - interval '7 days'");
                await client.query('UPDATE job_password_resets SET used_at=$2 WHERE username=$1 AND used_at IS NULL', [username, now]);
                await client.query('INSERT INTO job_password_resets (username,token_hash,expires_at) VALUES ($1,$2,$3)', [username, tokenHash, expiresAt]);
                await client.query('COMMIT');
            } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        },
        async consumeToken({ tokenHash, passwordHash, now }) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const used = await client.query(
                    'UPDATE job_password_resets SET used_at=$2 WHERE token_hash=$1 AND used_at IS NULL AND expires_at > $2 RETURNING username',
                    [tokenHash, now]
                );
                if (!used.rows.length) { await client.query('ROLLBACK'); return null; }
                const username = used.rows[0].username;
                await client.query('UPDATE job_users SET password_hash=$2 WHERE username=$1', [username, passwordHash]);
                await client.query('UPDATE job_password_resets SET used_at=$2 WHERE username=$1 AND used_at IS NULL', [username, now]);
                await client.query('COMMIT');
                return username;
            } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        },
    };
}

function registerPasswordReset(app, { pool, ready, env = process.env, logger = console, mailer = createMailer(env, logger) }) {
    const schemaReady = ready.then(() => pool.query(SCHEMA));
    schemaReady.catch(error => { logger.error('Password reset schema failed:', error.message); setTimeout(() => process.exit(1), 0); });
    const baseUrl = String(env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/+$/, '');
    const service = createPasswordResetService({ store: createPgStore(pool), sendMail: details => mailer.send(details), baseUrl, logger });
    const limiter = (limit) => rateLimit({ windowMs: 15 * 60 * 1000, limit, standardHeaders: 'draft-7', legacyHeaders: false });

    if (!mailer.configured) logger.warn(`[password-reset] SMTP is not configured; reset ${env.PASSWORD_RESET_LOG_LINKS === 'true' ? 'links will be printed to this log' : 'emails cannot be sent'}.`);

    app.use(['/api/jobs/auth/forgot', '/api/jobs/auth/reset'], (_req, _res, next) => { schemaReady.then(() => next(), next); });

    app.post('/api/jobs/auth/forgot', limiter(5), (req, res) => {
        const identifier = req.body?.identifier;
        if (typeof identifier !== 'string' || !identifier.trim()) return res.status(400).json({ error: 'Enter your username or email.' });
        // Answer first and do the work afterwards, so the response is identical in content and timing for every input.
        res.json({ ok: true, message: GENERIC_MESSAGE });
        service.requestReset(identifier).catch(error => logger.error('[password-reset] request failed:', error.message));
    });

    app.post('/api/jobs/auth/reset', limiter(10), async (req, res, next) => {
        try {
            const result = await service.completeReset(req.body?.token, req.body?.password);
            if (!result.ok) return res.status(400).json({ error: result.error });
            res.json({ ok: true });
        } catch (error) { next(error); }
    });

    app.get(['/jobs/reset', '/jobs/reset/'], (_req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.sendFile(path.join(__dirname, '..', '..', 'public', 'reset.html'));
    });
}

module.exports = { GENERIC_MESSAGE, INVALID_TOKEN, SCHEMA, composeResetEmail, createMailer, createPasswordResetService, createPgStore, hashToken, newToken, registerPasswordReset, validTokenShape };
