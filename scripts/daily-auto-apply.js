// Daily unattended auto-apply runner.
// Syncs jobs, submits new supported-ATS applications up to DAILY_TARGET,
// then polls the application pipeline until everything reaches a terminal state.
const BASE_URL = process.env.PORTAL_URL || 'http://localhost:3000';
const USERNAME = process.env.PORTAL_USERNAME || 'admin';
const PASSWORD = process.env.PORTAL_PASSWORD || 'AutoApply-Local-2026!';
const DAILY_TARGET = Number(process.env.DAILY_TARGET || 15);
const SUPPORTED_ATS = /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com/i;
const POLL_INTERVAL_MS = 20000;
const MAX_POLL_MINUTES = 20;

let cookieJar = '';

function log(...args) {
    console.log(new Date().toISOString(), ...args);
}

async function request(path, options = {}) {
    const res = await fetch(`${BASE_URL}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(cookieJar ? { Cookie: cookieJar } : {}), ...(options.headers || {}) },
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookieJar = setCookie.split(',').map(c => c.split(';')[0]).join('; ');
    return res;
}

async function login() {
    const res = await request('/api/jobs/auth/login', { method: 'POST', body: JSON.stringify({ username: USERNAME, password: PASSWORD }) });
    if (!res.ok) throw new Error(`Login failed: HTTP ${res.status}`);
    log('Logged in as', USERNAME);
}

async function countAppliedToday() {
    const res = await request('/api/jobs/applications');
    const data = await res.json();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return data.applications.filter(a => ['applied', 'ready_to_submit', 'verifying', 'tailoring'].includes(a.status) && new Date(a.createdAt || a.updatedAt) >= todayStart).length;
}

async function submitNewApplications(remaining) {
    const res = await request('/api/jobs/recommendations');
    const data = await res.json();
    const recs = data.recommendations || [];
    const supported = recs.filter(r => SUPPORTED_ATS.test(r.applyUrl || ''));
    const toSubmit = supported.slice(0, remaining);
    const results = [];
    for (const job of toSubmit) {
        const r = await request('/api/jobs/applications', { method: 'POST', body: JSON.stringify({ jobId: job.id }) });
        const body = await r.json().catch(() => ({}));
        results.push({ id: job.id, title: job.title, company: job.company, httpStatus: r.status, error: body.error });
        log('Queued:', job.company, '-', job.title, '->', r.status, body.error || '');
    }
    return results;
}

async function pollUntilQuiet() {
    const deadline = Date.now() + MAX_POLL_MINUTES * 60000;
    while (Date.now() < deadline) {
        const res = await request('/api/jobs/applications');
        const data = await res.json();
        const pending = data.applications.filter(a => ['tailoring', 'verifying'].includes(a.status));
        const counts = {};
        for (const a of data.applications) counts[a.status] = (counts[a.status] || 0) + 1;
        log('Pipeline status:', JSON.stringify(counts));
        if (!pending.length) break;
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
}

(async () => {
    try {
        await login();
        const alreadyToday = await countAppliedToday();
        const remaining = Math.max(0, DAILY_TARGET - alreadyToday);
        log(`Already in progress today: ${alreadyToday}. Remaining target: ${remaining}`);
        if (remaining > 0) {
            await submitNewApplications(remaining);
            await pollUntilQuiet();
        } else {
            log('Daily target already met.');
        }
        log('Daily auto-apply run complete.');
    } catch (error) {
        console.error('Daily auto-apply run failed:', error.message);
        process.exit(1);
    }
})();
