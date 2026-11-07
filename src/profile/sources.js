'use strict';

// Readers for the places a candidate's profile lives: GitHub (public API), a portfolio website (public page),
// and LinkedIn (the user's own data export: LinkedIn blocks automated page access and forbids scraping).
// Each reader returns *findings*: proposals the user reviews. Nothing is added to a resume without approval,
// and only public information from the user's own accounts is read.

const crypto = require('node:crypto');
const { assertPublicUrl } = require('../careerops/liveness');

const clean = (value, max = 300) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const fingerprint = (source, kind, title) => crypto.createHash('sha1').update(`${source}|${kind}|${clean(title, 200).toLowerCase()}`).digest('hex').slice(0, 24);
const finding = (source, kind, title, summary, url, meta = {}) => {
    const t = clean(title, 160);
    return t ? { source, kind, fingerprint: fingerprint(source, kind, t), title: t, summary: clean(summary, 400), url: url ? clean(url, 500) : null, meta } : null;
};

/* ---------------- GitHub ---------------- */

const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
function githubUsername(input) {
    const value = String(input || '').trim();
    if (!value) return null;
    const url = value.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)(?:[/?#].*)?$/i);
    const name = url ? url[1] : value.replace(/^@/, '');
    return GITHUB_NAME.test(name) ? name : null;
}

/** Projects and languages from the user's own, non-fork public repositories. */
function parseGithubRepos(repos, username, { limit = 30 } = {}) {
    const mine = (Array.isArray(repos) ? repos : []).filter(repo => repo && !repo.fork && !repo.private &&
        String(repo.owner?.login || '').toLowerCase() === username.toLowerCase() && String(repo.name || '').toLowerCase() !== username.toLowerCase());
    mine.sort((a, b) => String(b.pushed_at || '').localeCompare(String(a.pushed_at || '')));
    const kept = mine.slice(0, limit);
    const findings = kept.map(repo => finding('github', 'project', repo.name, repo.description, repo.html_url, {
        language: repo.language || null, topics: (repo.topics || []).slice(0, 8), stars: Number(repo.stargazers_count) || 0,
        pushedAt: repo.pushed_at || null, archived: !!repo.archived,
    })).filter(Boolean);
    const languages = new Map();
    for (const repo of mine) if (repo.language) languages.set(repo.language, (languages.get(repo.language) || 0) + 1);
    for (const [language, count] of [...languages.entries()].sort((a, b) => b[1] - a[1])) {
        if (count >= 2) findings.push(finding('github', 'skill', language, `Primary language in ${count} of your public repositories`, null, { repos: count }));
    }
    return findings;
}

async function fetchGithub(username, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN, timeoutMs = 10000 } = {}) {
    const response = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&type=owner&sort=pushed`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'JobPortalProfileSync/1.0', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) throw new Error('That GitHub user was not found.');
    if (response.status === 403 || response.status === 429) throw new Error('GitHub is limiting requests right now. Try again in about an hour.');
    if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
    return parseGithubRepos(await response.json(), username);
}

/* ---------------- Portfolio website ---------------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…' };
const decode = value => String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return code > 31 && code < 0x10ffff ? String.fromCodePoint(code) : ' '; }
    return ENTITIES[e.toLowerCase()] ?? m;
});
const textOf = html => clean(decode(String(html).replace(/<[^>]*>/g, ' ')), 600);

const PROJECT_HEADING = /\b(projects?|portfolio|selected work|case stud(?:y|ies)|things i(?:'|’)ve built|what i(?:'|’)ve built|work samples?)\b/i;
const EXPERIENCE_HEADING = /\b(experience|employment|career|work history|where i(?:'|’)ve worked|roles?)\b/i;
const OTHER_HEADING = /\b(about|contact|skills?|education|blog|writing|testimonials?|services|hire|resume|cv|awards?)\b/i;

/** Heuristic read of a portfolio page: candidate projects and roles under recognisable headings. */
function parsePortfolioHtml(html, pageUrl, { limit = 20 } = {}) {
    const source = String(html || '');
    const links = { github: null, linkedin: null };
    for (const m of source.matchAll(/href=["']([^"']+)["']/gi)) {
        const href = decode(m[1]);
        const gh = href.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/?(?:[?#].*)?$/i);
        if (gh && !links.github) links.github = gh[1];
        const li = href.match(/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9_%-]+)/i);
        if (li && !links.linkedin) links.linkedin = `https://www.linkedin.com/in/${li[1]}`;
    }
    const findings = [];
    const seen = new Set();
    const push = (kind, title, summary, url) => {
        const item = finding('portfolio', kind, title, summary, url);
        if (item && !seen.has(item.fingerprint) && findings.length < limit) { seen.add(item.fingerprint); findings.push(item); }
    };
    // Structured data first: it is explicit about what is a project.
    for (const m of source.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
            const data = JSON.parse(m[1].trim());
            for (const node of [].concat(data['@graph'] || data)) {
                const type = [].concat(node && node['@type'] || []).join(' ');
                if (/CreativeWork|SoftwareSourceCode|SoftwareApplication|Project|WebApplication/i.test(type) && node.name) push('project', node.name, node.description, typeof node.url === 'string' ? node.url : null);
            }
        } catch (_) { /* malformed JSON-LD is ignored */ }
    }
    const body = source.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');
    const tokens = [...body.matchAll(/<(h[1-4]|p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(m => ({ tag: m[1].toLowerCase(), text: textOf(m[2]), raw: m[2] }));
    let section = null; let sectionLevel = 0; let current = null;
    const flush = () => { if (current) { push(current.kind, current.title, current.summary, current.url); current = null; } };
    for (const token of tokens) {
        if (!token.text) continue;
        if (/^h[1-4]$/.test(token.tag)) {
            const level = Number(token.tag[1]);
            if (section && level > sectionLevel) { flush(); current = { kind: section, title: token.text, summary: '', url: null }; continue; }
            flush();
            section = PROJECT_HEADING.test(token.text) ? 'project' : EXPERIENCE_HEADING.test(token.text) && !OTHER_HEADING.test(token.text) ? 'experience' : null;
            sectionLevel = level;
            continue;
        }
        if (!section) continue;
        if (current) { if (!current.summary && token.text.length > 20) current.summary = token.text; continue; }
        if (token.tag === 'li') {
            const parts = token.text.split(/\s+[—–-]\s+|:\s+/);
            push(section, parts[0].slice(0, 100), parts.slice(1).join(' — ') || token.text.slice(0, 240), null);
        }
    }
    flush();
    const readable = findings.length > 0 || tokens.length > 8;
    return { findings, links, readable };
}

/** Fetch a public https page (SSRF-guarded, size-capped, redirects re-checked). */
async function fetchPage(rawUrl, { fetchImpl = fetch, lookup, timeoutMs = 10000, maxBytes = 600000 } = {}) {
    let url = await assertPublicUrl(rawUrl, lookup);
    for (let hop = 0; hop < 4; hop += 1) {
        const response = await fetchImpl(url.href, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'JobPortalProfileSync/1.0', Accept: 'text/html,application/xhtml+xml' } });
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { url = await assertPublicUrl(new URL(response.headers.get('location'), url).href, lookup); continue; }
        if (!response.ok) throw new Error(`The site returned ${response.status}.`);
        if (!/html|xml/i.test(response.headers.get('content-type') || '')) throw new Error('That address did not return a web page.');
        const reader = response.body.getReader(); const chunks = []; let size = 0;
        while (size < maxBytes) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.length; }
        reader.cancel().catch(() => {});
        return { html: Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'), finalUrl: url.href };
    }
    throw new Error('Too many redirects.');
}

/* ---------------- LinkedIn data export (CSV) ---------------- */

/** RFC 4180-style parser: quoted fields, escaped quotes, commas and newlines inside quotes, BOM, CRLF. */
function parseCsv(text) {
    const rows = []; let row = []; let field = ''; let quoted = false;
    const input = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < input.length; i += 1) {
        const c = input[i];
        if (quoted) {
            if (c === '"') { if (input[i + 1] === '"') { field += '"'; i += 1; } else quoted = false; } else field += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\n' || c === '\r') { if (c === '\r' && input[i + 1] === '\n') i += 1; row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(cell => cell.trim() !== ''));
}

function csvRecords(text, requiredHeader) {
    const rows = parseCsv(text);
    // LinkedIn sometimes puts note lines above the header.
    const at = rows.findIndex(r => r.some(cell => cell.trim().toLowerCase() === requiredHeader.toLowerCase()));
    if (at === -1) return [];
    const header = rows[at].map(cell => cell.trim());
    return rows.slice(at + 1).map(r => Object.fromEntries(header.map((name, i) => [name, (r[i] || '').trim()])));
}

const LINKEDIN_FILES = {
    positions: { header: 'Title', build: r => finding('linkedin', 'experience', `${r.Title} — ${r['Company Name']}`, r.Description, null, { title: clean(r.Title, 120), company: clean(r['Company Name'], 120), location: clean(r.Location, 120), start: clean(r['Started On'], 30), end: clean(r['Finished On'], 30), description: clean(r.Description, 1200) }) },
    education: { header: 'School Name', build: r => finding('linkedin', 'education', `${r['Degree Name'] || 'Studies'} — ${r['School Name']}`, r.Notes, null, { school: clean(r['School Name'], 160), degree: clean(r['Degree Name'], 160), start: clean(r['Start Date'], 30), end: clean(r['End Date'], 30) }) },
    skills: { header: 'Name', build: r => finding('linkedin', 'skill', r.Name, 'Listed on your LinkedIn profile', null) },
    certifications: { header: 'Name', build: r => finding('linkedin', 'certification', r.Name, r.Authority, r.Url, { authority: clean(r.Authority, 160), start: clean(r['Started On'], 30), end: clean(r['Finished On'], 30) }) },
    projects: { header: 'Title', build: r => finding('linkedin', 'project', r.Title, r.Description, r.Url, { start: clean(r['Started On'], 30), end: clean(r['Finished On'], 30) }) },
};

function parseLinkedinCsv(filename, text) {
    const key = Object.keys(LINKEDIN_FILES).find(name => new RegExp(`(^|[\\\\/])${name}\\.csv$`, 'i').test(String(filename || '')));
    if (!key) throw new Error(`“${clean(filename, 80)}” is not a file I can read. Use Positions.csv, Education.csv, Skills.csv, Certifications.csv or Projects.csv from your LinkedIn export.`);
    const { header, build } = LINKEDIN_FILES[key];
    return csvRecords(text, header).map(build).filter(Boolean);
}

/* ---------------- Writing accepted findings into the resume / profile ---------------- */

const SECTION_LINE = /^(summary|profile|objective|about( me)?|(professional |work |relevant |employment )?experience|employment( history)?|work history|education|(technical |core |key )?skills|competencies|projects?|certifications?|licenses?|awards?|publications?|volunteer(ing)?|languages|interests)$/i;

const SAME_SECTION = {
    EXPERIENCE: /experience|employment|work history/i,
    PROJECTS: /^projects?$/i,
    EDUCATION: /^education/i,
    CERTIFICATIONS: /^(certifications?|licenses?)/i,
};

/**
 * Add lines to the end of the resume's existing section of that kind (e.g. a new job inside "Experience", before
 * "Education"); only when there is no such section is a new one added at the end.
 */
function appendToSection(resumeText, heading, lines) {
    const all = String(resumeText || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
    const isHeading = line => SECTION_LINE.test(line.trim().replace(/:$/, ''));
    const matches = SAME_SECTION[heading];
    let at = -1;
    all.forEach((line, i) => { if (isHeading(line) && matches && matches.test(line.trim().replace(/:$/, ''))) at = i; });
    if (at === -1) return `${all.join('\n')}\n\n${heading}\n${lines.join('\n')}\n`;
    let end = all.findIndex((line, i) => i > at && isHeading(line));
    if (end === -1) end = all.length;
    while (end > at + 1 && !all[end - 1].trim()) end -= 1; // insert right after the section's last line
    const insert = heading === 'EXPERIENCE' ? ['', ...lines] : lines; // a blank line between jobs; project and certificate bullets stay together
    // `all.slice(end)` still starts with the section's original blank line(s) followed by the next heading.
    return `${[...all.slice(0, end), ...insert, ...all.slice(end)].join('\n')}\n`;
}

const bullet = value => `- ${clean(value, 300)}`;

/** The resume text a finding turns into, or null when it belongs in the skills list instead. */
function resumeBlock(f) {
    const m = f.meta || {};
    if (f.kind === 'project') {
        const tail = [m.language ? `(${clean(m.language, 40)})` : '', f.url || ''].filter(Boolean).join(' ');
        return { heading: 'PROJECTS', lines: [bullet(`${f.title}${f.summary ? `: ${f.summary}` : ''}${tail ? ` ${tail}` : ''}`)] };
    }
    if (f.kind === 'experience') {
        const parts = f.title.split(' — ');
        const dates = [m.start, m.end || (m.start ? 'Present' : '')].filter(Boolean).join(' - ');
        const bullets = clean(m.description || f.summary, 1200).split(/(?<=[.!?])\s+/).filter(s => s.length > 12).slice(0, 4).map(bullet);
        return { heading: 'EXPERIENCE', lines: [`${m.title || parts[0]} — ${m.company || parts[1] || ''}${m.location ? `, ${m.location}` : ''}`, dates, ...bullets].filter(Boolean) };
    }
    if (f.kind === 'education') {
        const dates = [m.start, m.end].filter(Boolean).join(' - ');
        return { heading: 'EDUCATION', lines: [`${[m.degree, m.school].filter(Boolean).join(', ') || f.title}${dates ? `, ${dates}` : ''}`] };
    }
    if (f.kind === 'certification') return { heading: 'CERTIFICATIONS', lines: [bullet(`${f.title}${m.authority ? ` — ${m.authority}` : ''}`)] };
    return null;
}

function applyFindingsToResume(resumeText, accepted) {
    let text = resumeText;
    for (const f of accepted) { const block = resumeBlock(f); if (block) text = appendToSection(text, block.heading, block.lines); }
    return text;
}

/** Add skill names to the comma-separated profile list without duplicates, within the 1,000-character profile limit. */
function mergeSkills(existing, names, max = 1000) {
    const list = String(existing || '').split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
    const have = new Set(list.map(s => s.toLowerCase()));
    const added = []; const skipped = [];
    for (const raw of names) {
        const name = clean(raw, 60);
        if (!name || have.has(name.toLowerCase())) continue;
        if ([...list, name].join(', ').length > max) { skipped.push(name); continue; }
        list.push(name); have.add(name.toLowerCase()); added.push(name);
    }
    return { skills: list.join(', '), added, skipped };
}

module.exports = {
    appendToSection, applyFindingsToResume, clean, csvRecords, fetchGithub, fetchPage, fingerprint, githubUsername,
    mergeSkills, parseCsv, parseGithubRepos, parseLinkedinCsv, parsePortfolioHtml, resumeBlock,
};
