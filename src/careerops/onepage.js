'use strict';

// Hard rule: a tailored resume is one page. Many employers ask for exactly that, and a long resume is a weaker one.
//
// The resume is measured with the same layout the PDF uses. While it is longer than a page, the least valuable
// content is removed, one piece at a time. Then everything that still fits is put back, most valuable first, so the
// page is used fully instead of being left a fifth empty. Content is only ever removed: nothing is added, shortened or
// reworded, so a trimmed resume is still entirely true and still passes the fact check.
// Bullets are already ordered most relevant first, so the end of each list is what goes first.

const { pageCount } = require('../documents/export');
const { renderMarkdown } = require('./resume');
const { earlierLine } = require('./recruiter');

// Free space kept at the bottom of the page so the Word version, which flows slightly differently, also stays on one page.
const SAFETY = 40;
const KEEP_SKILLS = 14;      // skills beyond the first 14 (the job-relevant ones come first) go before anything of substance
const KEEP_CERTIFICATIONS = 3;
const MIN_BULLETS = [3, 2];  // at first the newest role keeps 3 bullets, the next role 2, older roles 1

const clone = value => JSON.parse(JSON.stringify(value));
const measure = tailored => pageCount(renderMarkdown(tailored), { reserve: SAFETY });

/** The resume without the pieces whose ids are in `removed`. */
function without(original, removed) {
    const draft = clone(original);
    draft.other = draft.other.map((section, s) => ({ ...section, lines: section.lines.filter((_line, l) => !removed.has(`o:${s}:${l}`)) })).filter(section => section.lines.length);
    draft.projects = draft.projects.filter((_entry, p) => !removed.has(`p:${p}`));
    draft.skills = draft.skills.filter((_skill, i) => !removed.has(`k:${i}`));
    draft.certifications = draft.certifications.filter((_cert, i) => !removed.has(`c:${i}`));
    draft.experience = draft.experience
        .map((role, r) => ({ ...role, bullets: role.bullets.filter((_bullet, i) => !removed.has(`b:${r}:${i}`)), id: r }))
        .filter(role => !removed.has(`r:${role.id}`))
        .map(({ id, ...role }) => role);
    if (removed.has('summary')) draft.summary = '';
    // an old role that is cut as a role is not lost: it stays as one line under Earlier Experience, unless that line is cut too
    const shortened = original.experience.map((role, r) => ({ role, r })).filter(({ r }) => removed.has(`r:${r}`) && !removed.has(`e:${r}`)).map(({ role }) => earlierLine(role)).filter(Boolean);
    draft.earlier = [...(original.earlier || []), ...shortened];
    return draft;
}

/**
 * Every piece that can be taken out, with how much it is worth keeping (lower goes first).
 * `late` pieces are only offered once the comfortable ones are gone. Education, contact details and the newest
 * role's first bullets are never offered.
 */
function units(t) {
    const out = [];
    const add = (id, value, label, late = false) => out.push({ id, value, label, late });
    t.other.forEach((section, s) => section.lines.forEach((_line, l) => add(`o:${s}:${l}`, 5 + l * 0.01, `${section.title}: one line`)));
    t.projects.forEach((entry, p) => add(`p:${p}`, 14 - p * 2, `project "${entry.header[0] || 'Project'}"`));
    t.skills.forEach((skill, i) => {
        if (i >= KEEP_SKILLS) add(`k:${i}`, 8 + (KEEP_SKILLS * 2 - i) * 0.001, `skill "${skill}"`);
        else if (i >= 8) add(`k:${i}`, 35 - i * 0.01, `skill "${skill}"`, true);
    });
    t.certifications.forEach((cert, i) => add(`c:${i}`, i >= KEEP_CERTIFICATIONS ? 12 - i * 0.01 : 40 - i, `certification "${cert}"`, i < KEEP_CERTIFICATIONS));
    t.experience.forEach((role, r) => {
        const min = r < MIN_BULLETS.length ? MIN_BULLETS[r] : 1;
        role.bullets.forEach((_bullet, i) => {
            if (i >= min) add(`b:${r}:${i}`, 90 - i * 10 - r * 6, `a bullet under "${role.header[0] || 'a role'}"`);
            else if (i >= 1) add(`b:${r}:${i}`, 100 - i * 10 - r * 6, `a bullet under "${role.header[0] || 'a role'}"`, true);
        });
        // an old role goes whole, never one of the three newest
        if (r >= 3) {
            add(`r:${r}`, 20 - r * 0.5, `the role "${role.header[0] || 'an old role'}"`);
            add(`e:${r}`, 6, `the one-line entry for "${role.header[0] || 'an old role'}"`);
        }
    });
    if (t.summary) add('summary', 95, 'the summary', true);
    return out;
}

/**
 * @param {object} tailored structured resume from tailorResume
 * @param {{pages?: number}} [options]
 * @returns {{tailored: object, pages: number, removed: string[], fits: boolean}}
 */
function fitToPages(tailored, { pages = 1 } = {}) {
    const all = units(tailored);
    const byId = new Map(all.map(unit => [unit.id, unit]));
    const removed = new Set();
    const fits = () => measure(without(tailored, removed)) <= pages;

    // 1. take out the least valuable pieces until it fits
    while (!fits()) {
        const left = all.filter(unit => !removed.has(unit.id));
        // a role's one-line entry can only be cut once the role itself has been cut down to it
        const available = left.filter(unit => !/^e:/.test(unit.id) || removed.has(`r:${unit.id.slice(2)}`));
        const comfortable = available.filter(unit => !unit.late);
        const pool = comfortable.length ? comfortable : available;
        if (!pool.length) break;
        pool.sort((a, b) => a.value - b.value);
        removed.add(pool[0].id);
        // taking out a whole role makes its own bullets irrelevant
        const roleMatch = pool[0].id.match(/^r:(\d+)$/);
        if (roleMatch) for (const unit of all) if (unit.id.startsWith(`b:${roleMatch[1]}:`)) removed.add(unit.id);
    }

    // 2. put back whatever still fits, most valuable first, so the page is not left a fifth empty
    if (removed.size && fits()) {
        const order = [...removed].map(id => byId.get(id)).filter(Boolean).sort((a, b) => b.value - a.value);
        for (const unit of order) {
            if (/^b:/.test(unit.id) && removed.has(`r:${unit.id.split(':')[1]}`)) continue; // its whole role is out
            if (/^e:/.test(unit.id) && !removed.has(`r:${unit.id.slice(2)}`)) continue;
            removed.delete(unit.id);
            if (!fits()) removed.add(unit.id);
        }
    }

    const result = without(tailored, removed);
    const labels = [...removed].map(id => byId.get(id)).filter(unit => unit && !(/^b:/.test(unit.id) && removed.has(`r:${unit.id.split(':')[1]}`))).map(unit => unit.label);
    return { tailored: result, pages: measure(result), removed: labels, fits: measure(result) <= pages };
}

/** One readable line about what was left out, for the "what changed" list. */
function describeRemoval(removed) {
    if (!removed.length) return '';
    const kinds = [
        [/^a bullet/, 'lower-relevance bullet', 'lower-relevance bullets'],
        [/^the role/, 'older role shortened to one line', 'older roles shortened to one line'],
        [/^the one-line entry/, 'older role dropped', 'older roles dropped'],
        [/^project/, 'project', 'projects'],
        [/^certification/, 'certification', 'certifications'],
        [/^skill/, 'extra skill', 'extra skills'],
        [/^the summary/, 'summary', 'summary'],
    ];
    const parts = [];
    let counted = 0;
    for (const [pattern, one, many] of kinds) {
        const n = removed.filter(item => pattern.test(item)).length;
        if (n) { parts.push(pattern.source === '^the summary' ? 'the summary' : `${n} ${n === 1 ? one : many}`); counted += n; }
    }
    if (removed.length > counted) { const n = removed.length - counted; parts.push(`${n} other line${n === 1 ? '' : 's'}`); }
    return `Kept to one page: left out ${parts.join(', ')}. Everything that remains is still from your own resume.`;
}

module.exports = { SAFETY, describeRemoval, fitToPages, measure };
