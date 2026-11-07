'use strict';

// Tailored resume + cover letter builder. Everything comes from the user's source resume
// and saved profile: lines are reordered and trimmed for relevance, never invented or
// reworded, and a fact gate proves every output line traces back to the source.

const { countTerm, escapeRegExp, extractKeywords } = require('./keywords');
const { requirementEvidence } = require('./evidence');
const { validateRewrite } = require('./rewrite');

const BULLET = /^\s*[-*•·▪▫◦‣–—]\s+/;
const DATE_RANGE = /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(19|20)\d{2}\s*(?:[-–—]|to)\s*(?:((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(19|20)\d{2}|present|current|now)|\b(19|20)\d{2}\b/i;

const SECTION_TYPES = [
    ['summary', /^(professional\s+)?(summary|profile|objective|about( me)?|career summary)$/i],
    ['experience', /^((work|professional|relevant|employment)\s+)?(experience|history)|^employment( history)?$/i],
    ['education', /^(education|academic background|academics|education (?:&|and) training)$/i],
    // Sections a resume should not carry (references, hobbies, personal details). Recognised so they are left out
    // instead of being absorbed into the section above them.
    ['filler', /^(references?|hobbies( (?:&|and) interests)?|personal (?:details|information)|declaration)$/i],
    ['skills', /^((technical|core|key|professional)\s+)?(skills|competencies|technologies|tools|expertise)(\s+(?:&|and)\s+\w+)?$/i],
    ['projects', /^(selected |personal |key |academic )?projects?$/i],
    ['certifications', /^(certifications?|licenses?(?: (?:&|and) certifications?)?|training|courses)$/i],
    ['other', /^(awards?|honou?rs|publications?|volunteer(?:ing)?( experience)?|languages|interests|activities|leadership|achievements)$/i],
];

const clean = value => String(value || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();
const squash = value => clean(value).toLowerCase().replace(/[^a-z0-9+#%$.]+/g, ' ').trim();

function sectionTypeOf(line) {
    const text = clean(line).replace(/[:：]\s*$/, '');
    if (!text || text.length > 40 || /[.@]/.test(text.replace(/&/g, ''))) return null;
    for (const [type, pattern] of SECTION_TYPES) if (pattern.test(text)) return type;
    return null;
}

function parseContact(lines) {
    const head = lines.slice(0, 10).join(' | ');
    return {
        email: (head.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0] || '',
        phone: (head.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/) || [])[0] || '',
        links: [...new Set((head.match(/(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com)\/[\w\-./]+/gi) || []))],
    };
}

function parseExperience(lines) {
    const entries = [];
    let current = null;
    for (const raw of lines) {
        const line = clean(raw);
        if (!line) continue;
        const isBullet = BULLET.test(raw);
        if (isBullet) {
            if (!current) { current = { header: [], bullets: [] }; entries.push(current); }
            current.bullets.push(line.replace(BULLET, '').trim());
            continue;
        }
        const hasDate = DATE_RANGE.test(line);
        const startsLower = /^[a-z(]/.test(line);
        const lastBullet = current && current.bullets.length;
        if (lastBullet && startsLower && !hasDate) {
            current.bullets[current.bullets.length - 1] += ` ${line}`; // wrapped bullet text from PDF extraction
            continue;
        }
        if (!current || (lastBullet && (hasDate || line.length < 90))) {
            current = { header: [], bullets: [] };
            entries.push(current);
        }
        current.header.push(line);
    }
    return entries;
}

function splitList(lines) {
    const items = [];
    for (const raw of lines) {
        const line = clean(raw).replace(BULLET, '');
        if (!line) continue;
        const colon = line.match(/^([A-Za-z &/]{2,30}):\s*(.+)$/);
        const body = colon ? colon[2] : line;
        for (const part of body.split(/\s*[,;|•·]\s*/)) {
            const value = clean(part);
            if (value && value.length <= 60) items.push(value);
        }
    }
    return [...new Set(items)];
}

function parseResume(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const nonEmpty = lines.filter(line => clean(line));
    const sections = [];
    let current = { type: 'header', title: '', lines: [] };
    sections.push(current);
    for (const line of lines) {
        const type = sectionTypeOf(line);
        if (type) {
            current = { type, title: clean(line).replace(/[:：]\s*$/, ''), lines: [] };
            sections.push(current);
        } else current.lines.push(line);
    }
    const header = sections.find(section => section.type === 'header');
    const headerLines = header.lines.map(clean).filter(Boolean);
    const name = headerLines.find(line => line.length <= 60 && !/[@\d]/.test(line) && line.split(/\s+/).length <= 5) || '';
    const byType = type => sections.filter(section => section.type === type);
    return {
        name,
        contact: parseContact(headerLines.length ? headerLines : nonEmpty),
        headerLines,
        droppedFiller: byType('filler').map(section => section.title),
        summary: clean(byType('summary').flatMap(section => section.lines).join(' ')),
        experience: byType('experience').flatMap(section => parseExperience(section.lines)),
        skills: splitList(byType('skills').flatMap(section => section.lines)),
        education: byType('education').flatMap(section => section.lines.map(clean).filter(Boolean)),
        projects: byType('projects').flatMap(section => parseExperience(section.lines)),
        certifications: byType('certifications').flatMap(section => section.lines.map(clean).filter(line => line).map(line => line.replace(BULLET, ''))),
        other: byType('other').map(section => ({ title: section.title, lines: section.lines.map(clean).filter(Boolean) })),
        sectionCount: sections.length - 1,
    };
}

function lineRelevance(line, keywords) {
    return keywords.reduce((sum, keyword) => sum + (countTerm(line, keyword.term) ? keyword.score : 0), 0);
}

function displayForm(term, text) {
    const found = String(text || '').match(new RegExp(`(?<![A-Za-z0-9+#])${escapeRegExp(term)}(?![A-Za-z0-9+#])`, 'i'));
    return found ? found[0] : term;
}

function tailorResume({ resumeText, job = {}, profile = {}, maxBullets = 6, rewrites = [], surfaceSkills = false }) {
    const parsed = parseResume(resumeText);
    // Approved AI rewrites, keyed by the exact original line. Each is re-validated here: the client is never trusted.
    const rewriteByOriginal = new Map();
    for (const item of Array.isArray(rewrites) ? rewrites.slice(0, 40) : []) {
        if (item && typeof item.original === 'string' && typeof item.suggested === 'string') rewriteByOriginal.set(squash(item.original), String(item.suggested).trim());
    }
    const appliedRewrites = [];
    const rejectedRewrites = [];
    const keywords = extractKeywords(`${job.title || ''}\n${job.description || ''}`, { limit: 30 });
    const changes = [];
    const keywordTerms = keywords.map(item => item.term);

    // Experience: keep chronological order, put the most relevant bullets first, cap length.
    const experience = parsed.experience.map(entry => {
        const scored = entry.bullets.map((text, index) => ({ text, index, relevance: lineRelevance(text, keywords) }));
        const ordered = [...scored].sort((a, b) => b.relevance - a.relevance || a.index - b.index);
        // Keep what is relevant to this job (capped); never leave a role with fewer than three bullets.
        const floor = Math.min(3, ordered.length);
        let kept = ordered.filter(item => item.relevance > 0).slice(0, maxBullets);
        if (kept.length < floor) kept = [...kept, ...ordered.filter(item => !kept.includes(item))].slice(0, floor);
        if (kept.some((item, position) => item.index !== scored[position]?.index)) changes.push(`Reordered bullets under “${entry.header[0] || 'role'}” by relevance to this job.`);
        if (ordered.length > kept.length) changes.push(`Trimmed ${ordered.length - kept.length} lower-relevance bullet(s) under “${entry.header[0] || 'role'}” (still in your source resume).`);
        const context = `${entry.header.join(' ')} ${entry.bullets.join(' ')}`;
        const bullets = kept.map(item => {
            const wanted = rewriteByOriginal.get(squash(item.text));
            if (wanted === undefined) return item.text;
            const check = validateRewrite({ original: item.text, suggested: wanted, context });
            if (!check.ok) { rejectedRewrites.push({ original: item.text, suggested: wanted, reasons: check.reasons }); return item.text; }
            if (!check.unchanged) appliedRewrites.push({ original: item.text, suggested: wanted });
            return check.unchanged ? item.text : wanted;
        });
        return { header: entry.header, bullets, sourceBullets: entry.bullets };
    });
    if (appliedRewrites.length) changes.push(`Applied ${appliedRewrites.length} approved wording change(s); each was re-checked against your original line.`);

    // Skills: resume skills plus the user's saved profile skills, job-relevant first.
    const profileSkills = splitList([profile.skills || '']);
    const allSkills = [...new Map([...parsed.skills, ...profileSkills].map(skill => [skill.toLowerCase(), skill])).values()];
    const skills = [...allSkills].sort((a, b) => Number(Boolean(countTerm(keywordTerms.join(' '), b.toLowerCase()) || keywordTerms.some(term => countTerm(b, term)))) -
        Number(Boolean(countTerm(keywordTerms.join(' '), a.toLowerCase()) || keywordTerms.some(term => countTerm(a, term)))));
    if (skills.join('|') !== allSkills.join('|')) changes.push('Moved skills that match this job to the front of the Skills line.');
    if (surfaceSkills) {
        // List job keywords the resume or saved profile already evidences, so an ATS keyword scan finds them in Skills too.
        const evidenceText = `${resumeText}\n${profile.skills || ''}`;
        const surfaced = [];
        for (const { term } of keywords) {
            if (!countTerm(evidenceText, term) || countTerm(skills.join(' | '), term)) continue;
            const label = displayForm(term, evidenceText);
            skills.push(label);
            surfaced.push(label);
        }
        if (surfaced.length) changes.push(`Listed skills already evidenced in your resume under Skills: ${surfaced.join(', ')}.`);
    }

    // Summary: keep the user's own; otherwise compose a factual one from their profile.
    const evidencedTerms = keywords.filter(item => countTerm(`${resumeText}\n${profile.skills || ''}`, item.term)).slice(0, 5).map(item => item.term);
    let summary = parsed.summary;
    let summaryGenerated = false;
    if (!summary) {
        const years = Number(profile.experience_years);
        const parts = [];
        if (job.title) parts.push(`${job.title} candidate`);
        if (Number.isFinite(years) && years > 0 && profile.experience_years !== null && profile.experience_years !== '') parts.push(`${years} year${years === 1 ? '' : 's'} of experience`);
        if (evidencedTerms.length) parts.push(`strengths in ${evidencedTerms.join(', ')}`);
        if (parts.length) { summary = `${parts.join(' with ')}.`; summaryGenerated = true; changes.push('Wrote a short summary using only your profile facts (edit freely).'); }
    }

    if (parsed.droppedFiller.length) changes.push(`Left out sections a resume should not carry: ${parsed.droppedFiller.join(', ')}.`);

    const gapKeywords = keywords.filter(item => !countTerm(`${resumeText}\n${profile.skills || ''}`, item.term)).map(item => item.term).slice(0, 10);
    const tailored = {
        name: parsed.name || profile.full_name || '',
        contact: {
            email: parsed.contact.email,
            phone: parsed.contact.phone || profile.phone || '',
            location: [profile.city, profile.state].filter(Boolean).join(', '),
            links: [...new Set([...parsed.contact.links, profile.linkedin_url, profile.portfolio_url].filter(Boolean))],
        },
        summary, summaryGenerated, skills, experience,
        projects: parsed.projects, education: parsed.education, certifications: parsed.certifications, other: parsed.other,
    };
    const factCheck = verifyTailoredFacts(tailored, resumeText, profile, appliedRewrites);
    return {
        tailored, changes: [...new Set(changes)], factCheck, appliedRewrites, rejectedRewrites,
        keywords: { featured: evidencedTerms, notEvidenced: gapKeywords },
        parsedSections: parsed.sectionCount,
        warnings: [
            ...(parsed.experience.length ? [] : ['No Experience section was detected in your resume, so nothing could be reordered. Use headings like “Experience” or “Work Experience”.']),
            ...(gapKeywords.length ? [`These job keywords are not evidenced in your resume and were NOT added: ${gapKeywords.slice(0, 6).join(', ')}.`] : []),
        ],
    };
}

// Every non-generated line of the tailored output must exist in the source resume or profile.
function verifyTailoredFacts(tailored, resumeText, profile = {}, appliedRewrites = []) {
    const source = squash(`${resumeText}\n${profile.skills || ''}\n${profile.full_name || ''} ${profile.phone || ''} ${profile.city || ''} ${profile.state || ''} ${profile.linkedin_url || ''} ${profile.portfolio_url || ''}`);
    const check = line => !squash(line) || source.includes(squash(line));
    const unsupported = [];
    const test = (line, where) => { if (!check(line)) unsupported.push({ line: clean(line).slice(0, 160), where }); };
    const rewriteOf = new Map(appliedRewrites.map(item => [squash(item.suggested), item.original]));
    for (const entry of [...tailored.experience, ...tailored.projects]) {
        entry.header.forEach(line => test(line, 'role heading'));
        const context = `${entry.header.join(' ')} ${(entry.sourceBullets || entry.bullets).join(' ')}`;
        entry.bullets.forEach(line => {
            if (check(line)) return;
            // Not verbatim from the resume: acceptable only as a validated rewording of a specific source line.
            const original = rewriteOf.get(squash(line));
            if (original && validateRewrite({ original, suggested: line, context }).ok && source.includes(squash(original))) return;
            unsupported.push({ line: clean(line).slice(0, 160), where: 'bullet' });
        });
    }
    tailored.education.forEach(line => test(line, 'education'));
    tailored.certifications.forEach(line => test(line, 'certification'));
    tailored.skills.forEach(line => test(line, 'skill'));
    // a summary may be cut back to some of the person's own sentences, so each sentence is checked on its own
    if (!tailored.summaryGenerated && tailored.summary) tailored.summary.split(/(?<=[.!?])\s+/).forEach(sentence => test(sentence, 'summary'));
    return { ok: unsupported.length === 0, unsupported, checked: 'Every line was matched back to your source resume or saved profile.' };
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderMarkdown(t) {
    const out = [];
    if (t.name) out.push(`# ${t.name}`);
    const contact = [t.contact.email, t.contact.phone, t.contact.location, ...t.contact.links].filter(Boolean);
    if (contact.length) out.push(contact.join(' · '));
    if (t.summary) out.push('', '## Summary', t.summary);
    if (t.skills.length) out.push('', '## Skills', t.skills.join(', '));
    if (t.experience.length) {
        out.push('', '## Experience');
        for (const entry of t.experience) { out.push('', ...entry.header.map((line, i) => (i === 0 ? `### ${line}` : line)), ...entry.bullets.map(b => `- ${b}`)); }
    }
    if (t.projects.length) {
        out.push('', '## Projects');
        for (const entry of t.projects) { out.push('', ...entry.header.map((line, i) => (i === 0 ? `### ${line}` : line)), ...entry.bullets.map(b => `- ${b}`)); }
    }
    if (t.education.length) out.push('', '## Education', ...t.education);
    if (t.certifications.length) out.push('', '## Certifications', ...t.certifications.map(c => `- ${c}`));
    for (const section of t.other) out.push('', `## ${section.title}`, ...section.lines);
    return `${out.join('\n').trim()}\n`;
}

function renderHtml(t) {
    const entry = e => `<div class="entry">${e.header.map((line, i) => `<p class="${i === 0 ? 'role' : 'meta'}">${escapeHtml(line)}</p>`).join('')}${e.bullets.length ? `<ul>${e.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}</div>`;
    const contact = [t.contact.email, t.contact.phone, t.contact.location, ...t.contact.links].filter(Boolean).map(escapeHtml).join(' &middot; ');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(t.name || 'Resume')}</title><style>
body{font:11pt/1.4 Arial,Helvetica,sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 20px}
h1{font-size:20pt;margin:0}h2{font-size:12pt;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #999;margin:18px 0 6px;padding-bottom:2px}
.contact{color:#333;margin:4px 0 0}.role{font-weight:700;margin:10px 0 0}.meta{margin:0;color:#333}ul{margin:4px 0 0 18px;padding:0}li{margin:2px 0}
@media print{body{margin:0;max-width:none}}</style></head><body>
<h1>${escapeHtml(t.name)}</h1><p class="contact">${contact}</p>
${t.summary ? `<h2>Summary</h2><p>${escapeHtml(t.summary)}</p>` : ''}
${t.skills.length ? `<h2>Skills</h2><p>${escapeHtml(t.skills.join(', '))}</p>` : ''}
${t.experience.length ? `<h2>Experience</h2>${t.experience.map(entry).join('')}` : ''}
${t.projects.length ? `<h2>Projects</h2>${t.projects.map(entry).join('')}` : ''}
${t.education.length ? `<h2>Education</h2>${t.education.map(l => `<p class="meta">${escapeHtml(l)}</p>`).join('')}` : ''}
${t.certifications.length ? `<h2>Certifications</h2><ul>${t.certifications.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
${t.other.map(s => `<h2>${escapeHtml(s.title)}</h2>${s.lines.map(l => `<p class="meta">${escapeHtml(l)}</p>`).join('')}`).join('')}
</body></html>`;
}

function buildCoverLetter({ resumeText, job = {}, profile = {}, requirements = [] }) {
    const company = job.company || 'the hiring team';
    const name = profile.full_name || '[Your name]';
    const evidence = (requirements.length ? requirements : []).filter(item => item.status === 'match' && item.evidence).slice(0, 3);
    const fallback = evidence.length ? evidence : requirementEvidence(resumeText, job).slice(0, 3);
    // Only genuine requirement gaps are disclosed; nice-to-haves are not worth a sentence.
    const gaps = requirements.filter(item => item.status === 'gap' && item.priority !== 'preferred').slice(0, 1);
    const paragraphs = [`Dear ${job.company ? `${job.company} hiring team` : 'hiring team'},`,
        `I'm writing to apply for the ${job.title || 'open'} role at ${company}.${job.location ? ` I understand the position is based in ${job.location}.` : ''}`];
    if (fallback.length) {
        paragraphs.push('Here is where my experience lines up with what you are looking for:',
            fallback.map(item => `• ${item.evidence}  (relevant to: ${String(item.requirement).slice(0, 90)})`).join('\n'));
    }
    if (gaps.length) {
        const named = (gaps[0].missingTerms || []).slice(0, 3).join(', ') || String(gaps[0].requirement).slice(0, 100);
        paragraphs.push(`One area where I am still building depth is ${named}, and I would welcome the chance to discuss how I would ramp up.`);
    }
    paragraphs.push('I would welcome the chance to talk about how I can contribute to the team. Thank you for your time and consideration.', `Sincerely,\n${name}`);
    return {
        text: paragraphs.join('\n\n'),
        evidenceUsed: fallback.map(item => item.evidence),
        draftNotice: 'Draft built only from lines in your resume. Review and edit before sending — nothing is sent automatically.',
    };
}

module.exports = { DATE_RANGE, buildCoverLetter, parseResume, renderHtml, renderMarkdown, tailorResume, verifyTailoredFacts };
