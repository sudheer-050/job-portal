'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const {
    GENERIC_MESSAGE, INVALID_TOKEN, composeResetEmail, createMailer, createPasswordResetService,
    hashToken, newToken, registerPasswordReset, validTokenShape,
} = require('./passwordReset');

const NOW = Date.parse('2026-11-06T12:00:00Z');
const silent = { log() {}, warn() {}, error() {} };

// In-memory store with the same contract as the Postgres store.
function memoryStore(users) {
    const tokens = [];
    const db = { users: new Map(users.map(u => [u.username, { ...u }])), tokens };
    return {
        db,
        async findUser(id) { return [...db.users.values()].find(u => u.username.toLowerCase() === id || u.email.toLowerCase() === id) || null; },
        async countRecentRequests(username, since) { return tokens.filter(t => t.username === username && t.createdAt > since).length; },
        async createToken({ username, tokenHash, expiresAt, now }) {
            tokens.filter(t => t.username === username && !t.usedAt).forEach(t => { t.usedAt = now; });
            tokens.push({ username, tokenHash, expiresAt, usedAt: null, createdAt: now });
        },
        async consumeToken({ tokenHash, passwordHash, now }) {
            const row = tokens.find(t => t.tokenHash === tokenHash && !t.usedAt && t.expiresAt > now);
            if (!row) return null;
            row.usedAt = now;
            db.users.get(row.username).passwordHash = passwordHash;
            tokens.filter(t => t.username === row.username && !t.usedAt).forEach(t => { t.usedAt = now; });
            return row.username;
        },
    };
}

function setup({ clock = { t: NOW }, sendMailImpl } = {}) {
    const store = memoryStore([
        { username: 'jordan', email: 'Jordan@Example.com', passwordHash: 'old-hash-j' },
        { username: 'casey', email: 'casey@example.com', passwordHash: 'old-hash-c' },
    ]);
    const sent = [];
    const sendMail = sendMailImpl || (async details => { sent.push(details); });
    const service = createPasswordResetService({ store, sendMail, baseUrl: 'https://myhai.org', now: () => clock.t, bcryptRounds: 4, logger: silent });
    return { store, sent, service, clock };
}
const tokenFrom = link => link.split('#token=')[1];

test('tokens are 256-bit random, URL-safe, and only their hash is stored', () => {
    const a = newToken(), b = newToken();
    assert.notEqual(a, b);
    assert.ok(validTokenShape(a) && a.length === 43);
    assert.equal(hashToken(a).length, 64);
    assert.equal(hashToken(a), hashToken(a));
    assert.notEqual(hashToken(a), hashToken(b));
    for (const bad of ['', 'short', null, undefined, 42, 'a'.repeat(44), `${'a'.repeat(42)}!`]) assert.equal(validTokenShape(bad), false);
});

test('an unknown account gets no token and no email, but the same outcome shape', async () => {
    const { service, store, sent } = setup();
    const result = await service.requestReset('nobody@example.com');
    assert.equal(result.issued, false);
    assert.equal(store.db.tokens.length, 0);
    assert.equal(sent.length, 0);
    assert.equal((await service.requestReset('   ')).issued, false);
});

test('a known account (by username or email, any case) gets a link with the token in the URL fragment', async () => {
    for (const id of ['jordan', 'JORDAN', 'jordan@example.com', '  Jordan@EXAMPLE.com ']) {
        const { service, store, sent } = setup();
        assert.equal((await service.requestReset(id)).issued, true, id);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].to, 'Jordan@Example.com');
        assert.match(sent[0].link, /^https:\/\/myhai\.org\/jobs\/reset#token=[A-Za-z0-9_-]{43}$/);
        assert.ok(!sent[0].link.includes('?'), 'token must not be in the query string');
        const raw = tokenFrom(sent[0].link);
        assert.equal(store.db.tokens[0].tokenHash, hashToken(raw));
        assert.ok(!JSON.stringify(store.db.tokens).includes(raw), 'the raw token must never be stored');
    }
});

test('the reset completes once, sets a verifiable bcrypt hash, and the link then dies', async () => {
    const { service, store, sent } = setup();
    await service.requestReset('jordan');
    const token = tokenFrom(sent[0].link);
    assert.deepEqual(await service.completeReset(token, 'a brand new passphrase'), { ok: true });
    const stored = store.db.users.get('jordan').passwordHash;
    assert.notEqual(stored, 'old-hash-j');
    assert.equal(await bcrypt.compare('a brand new passphrase', stored), true);
    assert.equal(await bcrypt.compare('wrong', stored), false);
    assert.deepEqual(await service.completeReset(token, 'another passphrase 2'), { ok: false, error: INVALID_TOKEN });
    assert.equal(store.db.users.get('casey').passwordHash, 'old-hash-c', 'other accounts are untouched');
});

test('tokens expire after 30 minutes', async () => {
    const { service, sent, clock } = setup();
    await service.requestReset('jordan');
    const token = tokenFrom(sent[0].link);
    clock.t = NOW + 31 * 60 * 1000;
    assert.deepEqual(await service.completeReset(token, 'long enough password'), { ok: false, error: INVALID_TOKEN });
});

test('a new request invalidates the previous link', async () => {
    const { service, sent } = setup();
    await service.requestReset('jordan');
    await service.requestReset('jordan');
    const [first, second] = sent.map(item => tokenFrom(item.link));
    assert.deepEqual(await service.completeReset(first, 'long enough password'), { ok: false, error: INVALID_TOKEN });
    assert.deepEqual(await service.completeReset(second, 'long enough password'), { ok: true });
});

test('completing a reset kills any other outstanding links for that account', async () => {
    const { service, store, sent } = setup();
    await service.requestReset('jordan');
    store.db.tokens.push({ username: 'jordan', tokenHash: hashToken('x'.repeat(43)), expiresAt: new Date(NOW + 1e6), usedAt: null, createdAt: new Date(NOW) });
    assert.equal((await service.completeReset(tokenFrom(sent[0].link), 'long enough password')).ok, true);
    assert.deepEqual(await service.completeReset('x'.repeat(43), 'long enough password'), { ok: false, error: INVALID_TOKEN });
});

test('a link for one account cannot change another account', async () => {
    const { service, store, sent } = setup();
    await service.requestReset('casey');
    await service.completeReset(tokenFrom(sent[0].link), 'long enough password');
    assert.equal(store.db.users.get('jordan').passwordHash, 'old-hash-j');
    assert.notEqual(store.db.users.get('casey').passwordHash, 'old-hash-c');
});

test('weak, huge, malformed and wrong tokens are rejected without touching anything', async () => {
    const { service, store, sent } = setup();
    await service.requestReset('jordan');
    const token = tokenFrom(sent[0].link);
    assert.match((await service.completeReset(token, 'short')).error, /at least 8/);
    assert.match((await service.completeReset(token, 'x'.repeat(129))).error, /128/);
    assert.equal((await service.completeReset(token, 12345678)).ok, false);
    assert.deepEqual(await service.completeReset('not-a-token', 'long enough password'), { ok: false, error: INVALID_TOKEN });
    assert.deepEqual(await service.completeReset(newToken(), 'long enough password'), { ok: false, error: INVALID_TOKEN });
    assert.equal(store.db.users.get('jordan').passwordHash, 'old-hash-j');
    assert.equal((await service.completeReset(token, 'long enough password')).ok, true, 'a rejected attempt must not burn the token');
});

test('requests are throttled to 3 per hour per account, silently', async () => {
    const { service, sent, clock } = setup();
    for (let i = 0; i < 3; i += 1) assert.equal((await service.requestReset('jordan')).issued, true);
    const fourth = await service.requestReset('jordan');
    assert.deepEqual([fourth.issued, fourth.throttled], [false, true]);
    assert.equal(sent.length, 3);
    clock.t = NOW + 61 * 60 * 1000;
    assert.equal((await service.requestReset('jordan')).issued, true);
});

test('an email delivery failure never throws or leaks', async () => {
    const { service } = setup({ sendMailImpl: async () => { throw new Error('smtp down'); } });
    assert.equal((await service.requestReset('jordan')).issued, true);
});

test('the email escapes the username and carries the link and expiry', () => {
    const { subject, text, html } = composeResetEmail({ username: '<b>x</b>', link: 'https://myhai.org/jobs/reset#token=abc' });
    assert.match(subject, /Reset/);
    assert.ok(text.includes('https://myhai.org/jobs/reset#token=abc') && text.includes('30 minutes'));
    assert.ok(!html.includes('<b>x</b>') && html.includes('&lt;b&gt;'));
});

test('mailer: without SMTP nothing is sent and links are logged only when explicitly enabled', async () => {
    const logs = [];
    const logger = { log: m => logs.push(['log', m]), warn: m => logs.push(['warn', m]), error() {} };
    const off = createMailer({}, logger);
    assert.equal(off.configured, false);
    assert.deepEqual(await off.send({ to: 'a@b.c', username: 'jordan', link: 'https://x/jobs/reset#token=T' }), { sent: false });
    assert.equal(logs.at(-1)[0], 'warn');
    assert.ok(!logs.some(([, m]) => String(m).includes('#token=T')), 'the link must not be logged by default');
    await createMailer({ PASSWORD_RESET_LOG_LINKS: 'true' }, logger).send({ to: 'a@b.c', username: 'jordan', link: 'https://x/jobs/reset#token=T' });
    assert.ok(logs.some(([kind, m]) => kind === 'log' && String(m).includes('#token=T')));
});

test('mailer: with SMTP it builds the transport from env and sends through nodemailer', async () => {
    let options, mail;
    const mailer = createMailer({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'Job Portal <no-reply@example.com>' }, silent,
        opts => { options = opts; return { sendMail: async m => { mail = m; } }; });
    assert.equal(mailer.configured, true);
    assert.deepEqual(await mailer.send({ to: 'jordan@example.com', username: 'jordan', link: 'https://x/jobs/reset#token=T' }), { sent: true });
    assert.deepEqual(options, { host: 'smtp.example.com', port: 465, secure: true, auth: { user: 'u', pass: 'p' } });
    assert.equal(mail.to, 'jordan@example.com');
    assert.equal(mail.from, 'Job Portal <no-reply@example.com>');
    assert.ok(mail.text.includes('#token=T') && mail.html.includes('#token=T'));
});

test('mailer: the real nodemailer transport produces a well-formed message', async () => {
    const mailer = createMailer({ SMTP_HOST: 'h', SMTP_FROM: 'no-reply@example.com' }, silent, () => require('nodemailer').createTransport({ jsonTransport: true }));
    const transport = require('nodemailer').createTransport({ jsonTransport: true });
    const info = await transport.sendMail({ from: 'no-reply@example.com', to: 'jordan@example.com', ...composeResetEmail({ username: 'jordan', link: 'https://x/jobs/reset#token=T' }) });
    const message = JSON.parse(info.message);
    assert.equal(message.subject, 'Reset your Job Portal password');
    assert.equal(message.to[0].address, 'jordan@example.com');
    assert.equal(mailer.configured, true);
});

// ---- HTTP layer (no database: the pool answers every query with "no rows") ----
async function startApp() {
    const pool = { query: async () => ({ rows: [] }), connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
    const app = express();
    app.use(express.json());
    registerPasswordReset(app, { pool, ready: Promise.resolve(), env: { PUBLIC_BASE_URL: 'https://myhai.org' }, logger: silent });
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { base, post, close: () => new Promise(resolve => server.close(resolve)) };
}

test('POST /forgot answers identically for any input and validates the body', async () => {
    const app = await startApp();
    try {
        assert.equal((await app.post('/api/jobs/auth/forgot', {})).status, 400);
        assert.equal((await app.post('/api/jobs/auth/forgot', { identifier: ['x'] })).status, 400);
        const unknown = await app.post('/api/jobs/auth/forgot', { identifier: 'nobody' });
        assert.equal(unknown.status, 200);
        assert.deepEqual(await unknown.json(), { ok: true, message: GENERIC_MESSAGE });
        const emailLike = await app.post('/api/jobs/auth/forgot', { identifier: 'someone@example.com' });
        assert.deepEqual(await emailLike.json(), { ok: true, message: GENERIC_MESSAGE });
    } finally { await app.close(); }
});

test('POST /reset rejects bad tokens and weak passwords with 400', async () => {
    const app = await startApp();
    try {
        const badToken = await app.post('/api/jobs/auth/reset', { token: 'nope', password: 'long enough password' });
        assert.deepEqual([badToken.status, (await badToken.json()).error], [400, INVALID_TOKEN]);
        const weak = await app.post('/api/jobs/auth/reset', { token: newToken(), password: 'short' });
        assert.equal(weak.status, 400);
        const unknownToken = await app.post('/api/jobs/auth/reset', { token: newToken(), password: 'long enough password' });
        assert.deepEqual([unknownToken.status, (await unknownToken.json()).error], [400, INVALID_TOKEN]);
    } finally { await app.close(); }
});

test('forgot-password requests are rate limited per IP', async () => {
    const app = await startApp();
    try {
        const statuses = [];
        for (let i = 0; i < 7; i += 1) statuses.push((await app.post('/api/jobs/auth/forgot', { identifier: 'nobody' })).status);
        assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
        assert.equal(statuses[5], 429);
    } finally { await app.close(); }
});

test('GET /jobs/reset serves the page uncached with no referrer', async () => {
    const app = await startApp();
    try {
        const res = await fetch(`${app.base}/jobs/reset`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /html/);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
        assert.match(await res.text(), /Choose a new password/);
    } finally { await app.close(); }
});
