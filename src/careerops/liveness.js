'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const EXPIRED = /(no longer (?:accepting|available|open)|position (?:has been|is) (?:filled|closed)|job (?:has )?(?:expired|been removed|is closed)|this (?:job|posting|position|role) (?:is )?(?:no longer|has expired|has been closed)|posting (?:has )?(?:been )?(?:removed|closed|expired)|(?:job|position) not found|we are no longer hiring|applications? (?:are|is) closed|req(?:uisition)? (?:is )?closed|this opportunity (?:has )?closed)/i;
const APPLY_CONTROL = /\b(apply(?: now| for this job| for this position)?|submit (?:your )?application|easy apply)\b/i;

function isPrivateAddress(address) {
    if (net.isIPv4(address)) {
        const [a, b] = address.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    }
    if (net.isIPv6(address)) {
        const value = address.toLowerCase();
        if (value === '::1' || value === '::') return true;
        if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
        return /^f[cd]/.test(value) || /^fe[89ab]/.test(value);
    }
    return true;
}

async function assertPublicUrl(rawUrl, lookup = dns.lookup) {
    let url;
    try { url = new URL(rawUrl); } catch (_) { throw new Error('That is not a valid URL.'); }
    if (url.protocol !== 'https:') throw new Error('Only https:// posting URLs can be checked.');
    if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.');
    let addresses;
    try {
        addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
    } catch (_) {
        throw new Error('That website could not be found.');
    }
    if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) throw new Error('That address is not a public website.');
    return url;
}

/** Pure classification so it can be tested without network access. */
function classifyLiveness({ status, text = '', finalUrl = '' }) {
    if (status === 404 || status === 410) return { verdict: 'expired', reason: `Server returned ${status}.` };
    if (status >= 500) return { verdict: 'uncertain', reason: `Server error ${status}; try again later.` };
    if (status === 401 || status === 403 || status === 429) return { verdict: 'uncertain', reason: `Access was blocked (${status}); open the posting in your browser to confirm.` };
    const body = String(text);
    const expired = body.match(EXPIRED);
    if (expired) return { verdict: 'expired', reason: `Page says: “${expired[0]}”.` };
    if (/[?&](?:error|notfound)=/i.test(finalUrl) || /\/(?:404|not-found|job-not-found)\b/i.test(finalUrl)) return { verdict: 'expired', reason: 'Redirected to a not-found page.' };
    if (body.length >= 900 && APPLY_CONTROL.test(body)) return { verdict: 'active', reason: 'Page shows a job description and an apply control.' };
    return { verdict: 'uncertain', reason: 'The page did not show a readable job description. It may render in JavaScript — open it in your browser to confirm.' };
}

function stripHtml(html) {
    return String(html).replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

async function checkLiveness(rawUrl, { fetchImpl = fetch, lookup = dns.lookup, timeoutMs = 10000, maxBytes = 600000 } = {}) {
    let url = await assertPublicUrl(rawUrl, lookup);
    for (let hop = 0; hop < 5; hop += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url.href, {
                redirect: 'manual', signal: controller.signal,
                headers: { 'user-agent': 'JobPortalLivenessCheck/1.0', accept: 'text/html,application/xhtml+xml' },
            });
            if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
                url = await assertPublicUrl(new URL(response.headers.get('location'), url).href, lookup);
                continue;
            }
            let text = '';
            if (response.body && response.status < 400) {
                const reader = response.body.getReader();
                const chunks = [];
                let size = 0;
                while (size < maxBytes) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value); size += value.length;
                }
                reader.cancel().catch(() => {});
                text = stripHtml(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'));
            }
            return { ...classifyLiveness({ status: response.status, text, finalUrl: url.href }), status: response.status, checkedAt: new Date().toISOString(), url: url.href };
        } catch (error) {
            if (error.name === 'AbortError') return { verdict: 'uncertain', reason: 'The site took too long to respond.', status: 0, checkedAt: new Date().toISOString(), url: url.href };
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
    return { verdict: 'uncertain', reason: 'Too many redirects.', status: 0, checkedAt: new Date().toISOString(), url: url.href };
}

module.exports = { assertPublicUrl, checkLiveness, classifyLiveness, isPrivateAddress };
