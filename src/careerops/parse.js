'use strict';

// Reading a resume's text into sections, roles and bullets.
//
// The text usually comes out of a PDF, which wraps every line at a fixed width: one bullet becomes two or three lines,
// a continuation line can start with a capital letter ("SQL, processing 1M+ records", "KPIs driving 10% gains", "CLIs"),
// a blank line can fall in the middle of a bullet at a page break, and headings are written in capitals with "&"
// ("PROJECTS & PORTFOLIO"). The reader below handles all of that, and never changes a word: it only decides which line
// belongs to which role, bullet or section, and joins wrapped lines back together.

// A dash-style bullet needs a space after it ("-5% cost" is not a bullet); a real bullet glyph does not (PDF text often has "•Built").
const BULLET = /^\s*(?:[-*–—]\s+|[•·▪▫◦‣]\s*)/;
const DATE_RANGE = /((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(19|20)\d{2}\s*(?:[-–—]|to)\s*(?:((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+)?(19|20)\d{2}|present|current|now)|\b(19|20)\d{2}\b/i;

// A date glued to the text before it by a PDF's right-aligned column ("IndiaAug 2023 – Feb 2024") gets a separator back.
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
const GLUED_DATE = new RegExp(`([a-z)])(${MONTH}\\s+(?:19|20)\\d{2}\\s*[-–—]\\s*(?:${MONTH}\\s+)?(?:(?:19|20)\\d{2}|Present|Current))`, 'g');
const GLUED_SINGLE = new RegExp(`([a-z)])(${MONTH}\\s+(?:19|20)\\d{2})$`, 'gm');
const clean = value => String(value || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(GLUED_DATE, '$1 | $2').replace(GLUED_SINGLE, '$1 | $2').trim();

// ---------------------------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------------------------

const SECTION_TYPES = [
    ['summary', /^(professional\s+)?(summary|profile|objective|about( me)?|career summary)$/i],
    ['experience', /^((work|professional|relevant|employment)\s+)?(experience|history)$|^employment( history)?$|^internships?( experience)?$/i],
    ['education', /^(education|academic background|academics|education (?:&|and) training)$/i],
    // Sections a resume should not carry. Recognised so they are left out instead of being absorbed into the section above.
    ['filler', /^(references?|hobbies( (?:&|and) interests)?|personal (?:details|information)|declaration)$/i],
    ['skills', /^((technical|core|key|professional|additional|other)\s+)?(skills|competencies|technologies|tools|expertise)(\s+(?:&|and)\s+[a-z ]{3,30})?$/i],
    ['projects', /^(selected |personal |key |academic |technical |notable |featured |side |open[- ]source )?projects?(\s+(?:&|and)\s+[a-z ]{3,30})?$/i],
    ['certifications', /^(certifications?|licenses?|training|courses)(\s+(?:&|and)\s+[a-z ]{3,40})?$|^licenses?\s+(?:&|and)\s+certifications?$/i],
    ['other', /^(awards?|honou?rs|publications?|volunteer(?:ing)?( experience)?|languages|interests|activities|leadership( (?:&|and) activities)?|extracurricular( activities)?|achievements|additional information)$/i],
];

// For capitals-only lines such as "ACADEMIC PROJECTS & CAPSTONE": decide the type from the words in it.
const KEYWORD_TYPES = [
    ['filler', /\b(references?|declaration|personal (details|information)|hobbies)\b/],
    ['summary', /\b(summary|profile|objective|about me)\b/],
    ['projects', /\b(projects?|portfolio|capstone)\b/],
    ['experience', /\b(experience|employment|work history|internships?)\b/],
    ['education', /\b(education|academic background|academics)\b/],
    ['certifications', /\b(certifications?|licen[cs]es?|professional development|training|courses?|coursework)\b/],
    ['other', /\b(interests)\b/],
    ['skills', /\b(skills|competencies|technologies|tools|expertise|proficiencies)\b/],
    ['other', /\b(leadership|activities|volunteer|awards?|honou?rs|achievements|publications?|languages|extracurricular|affiliations|memberships|research|patents|speaking|additional|miscellaneous)\b/],
];

/** @returns {string|null} the section type if the line is a heading */
function headingType(line, { known = false, afterWrapped = false } = {}) {
    const text = clean(line).replace(/[:：]\s*$/, '');
    if (!text || text.length > 60 || /@/.test(text) || /\./.test(text.replace(/&/g, ''))) return null;
    // A lone word such as "License" or "Training" right after a full-width line is the tail of a wrapped sentence
    // ("...Jinja2, pytest, GitHub Actions, MIT" / "License"), not a heading. Headings written in capitals are always headings.
    if (afterWrapped && text !== text.toUpperCase()) return null;
    for (const [type, pattern] of SECTION_TYPES) if (pattern.test(text)) return type;
    // capitals-only lines count as headings once a real section has been seen (before that, the first lines are the name)
    if (known && text === text.toUpperCase() && /[A-Z]{3}/.test(text) && text.split(/\s+/).length <= 8 && !/\d{3}/.test(text)) {
        const lower = text.toLowerCase();
        for (const [type, pattern] of KEYWORD_TYPES) if (pattern.test(lower)) return type;
    }
    return null;
}

// ---------------------------------------------------------------------------------------------
// Joining wrapped lines
// ---------------------------------------------------------------------------------------------

/** Join two pieces of one sentence. A word split by a hyphen at the end of a line ("full-" "stack") is rejoined. */
function joinWrapped(first, second) {
    return /[A-Za-z]-$/.test(first) && /^[a-z]/.test(second) ? `${first}${second}` : `${first} ${second}`;
}

/**
 * The width a PDF wrapped its text at. Wrapped lines all end close to the page width, so the 90th percentile of the
 * line lengths finds it, and one unusually long line (a contact line) cannot set it. Zero when the text is too short to
 * tell, or was never wrapped (lines of a whole paragraph each).
 */
const MIN_WRAP_WIDTH = 90;
function wrapWidthOf(texts) {
    const lengths = texts.map(text => text.length).filter(length => length >= 40).sort((a, b) => a - b);
    if (lengths.length < 6) return 0;
    const width = lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.9))];
    return width >= MIN_WRAP_WIDTH && width <= 160 ? width : 0;
}

/**
 * Lines of a list-like section (education, skills, other), with wrapped lines joined to the line before.
 * A line continues the one before it when that one ends mid-sentence or this one starts in lower case; with
 * `wrapWidth` (skills lists) a line that fills the page width is also continued on the next line.
 */
function unwrapLines(rawLines, { wrapWidth = 0 } = {}) {
    const out = [];
    for (const raw of rawLines) {
        const text = clean(raw);
        if (!text) continue;
        const previous = out[out.length - 1];
        const bullet = BULLET.test(raw);
        const filled = wrapWidth >= MIN_WRAP_WIDTH && previous && previous.length >= wrapWidth * 0.8;
        if (previous && !bullet && !DATE_RANGE.test(text) && (/^[a-z(]/.test(text) || /[,(&/-]$/.test(previous) || filled)) out[out.length - 1] = joinWrapped(previous, text);
        else out.push(bullet ? text.replace(BULLET, '').trim() : text);
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Roles, projects and other entries made of a heading and bullets
// ---------------------------------------------------------------------------------------------

/**
 * @returns {{header: string[], bullets: string[]}[]} each entry: its heading lines (role and company, dates, place) and its bullets
 */
function parseEntries(rawLines, { wrapWidth: known } = {}) {
    const items = rawLines.map(raw => ({ raw, text: clean(raw) })).filter(item => item.text);
    const wrapWidth = known === undefined ? wrapWidthOf(items.map(item => item.text)) : known; // the whole document's width when it is known
    const isLong = text => wrapWidth >= MIN_WRAP_WIDTH && text.length >= wrapWidth * 0.8;
    // is one of the next two lines (before any bullet) a date range? A role heading is followed by its dates.
    const dateAhead = index => {
        for (let k = index + 1, seen = 0; k < items.length && seen < 2; k += 1, seen += 1) {
            if (BULLET.test(items[k].raw)) return false;
            if (DATE_RANGE.test(items[k].text)) return true;
        }
        return false;
    };
    const nextLineHasDate = index => index + 1 < items.length && !BULLET.test(items[index + 1].raw) && DATE_RANGE.test(items[index + 1].text);

    const entries = [];
    let current = null;
    let previous = '';
    items.forEach((item, index) => {
        const text = item.text;
        if (BULLET.test(item.raw)) {
            if (!current) { current = { header: [], bullets: [] }; entries.push(current); }
            current.bullets.push(text.replace(BULLET, '').trim());
            previous = text;
            return;
        }
        const ownDate = DATE_RANGE.test(text);
        const startsEntry = ownDate || nextLineHasDate(index);   // a role heading carries its dates, or is followed by them
        if (current && current.bullets.length) {
            // after a bullet: this is the rest of that bullet (wrapped text) unless a new role or project starts here
            // a lowercase start right after a full-width line is the rest of that bullet, even when dates follow on the next line
            const wrapped = (!startsEntry && (isLong(previous) || (/^[a-z(,;]/.test(text) && !dateAhead(index)))) || (/^[a-z]/.test(text) && isLong(previous));
            if (wrapped) {
                const last = current.bullets.length - 1;
                current.bullets[last] = joinWrapped(current.bullets[last], text);
                previous = text;
                return;
            }
            current = { header: [text], bullets: [] };
            entries.push(current);
            previous = text;
            return;
        }
        // before the first bullet: heading lines of the current entry (the rest of a wrapped heading line is joined)
        if (current && current.header.length && !startsEntry && isLong(previous) && (/^[a-z(]/.test(text) || text.length <= 45)) {
            current.header[current.header.length - 1] = joinWrapped(current.header[current.header.length - 1], text);
            previous = text;
            return;
        }
        // an entry that has its dates and is followed by a line that carries dates again: that line starts the next entry
        if (current && nextLineHasDate(index) && current.header.some(line => DATE_RANGE.test(line))) current = null;
        if (!current) { current = { header: [], bullets: [] }; entries.push(current); }
        current.header.push(text);
        previous = text;
    });

    // a sentence of introduction above the first entry ("Personal projects below were built with…") belongs to no entry
    const first = entries[0];
    if (first && first.header.length > 1 && /[.!?]$/.test(first.header[0]) && first.header[0].split(/\s+/).length >= 8) first.header.shift();
    return entries;
}

/** One line per certification: its title, and the line with its date when there is one. Descriptions are left out. */
function certificationLines(rawLines, { wrapWidth: known } = {}) {
    const items = rawLines.map(raw => ({ raw, text: clean(raw) })).filter(item => item.text);
    const wrapWidth = known === undefined ? wrapWidthOf(items.map(item => item.text)) : known;
    const isLong = text => wrapWidth >= MIN_WRAP_WIDTH && text.length >= wrapWidth * 0.8;
    // a line that describes a certification rather than naming it
    const describes = text => /^(completed|instructor|issued|expires|credential|coursera|udemy|edx|certificate|grade|score|includes?|comprehensive|training in|covers?)\b/i.test(text) || /[:.]$/.test(text) || text.length > 110;

    const titles = [];
    const plain = [];
    let previous = '';
    let inBullet = false;
    for (const item of items) {
        const bullet = BULLET.test(item.raw);
        if (bullet) { inBullet = true; plain.push(item.text.replace(BULLET, '').trim()); previous = item.text; continue; }
        // a title with an issuer ("Name | Issuer") always starts a new certification, even right after a full-width description line
        const looksLikeTitle = item.text.includes(' | ') && !describes(item.text);
        const continues = previous && !looksLikeTitle && (isLong(previous) || /^[a-z(]/.test(item.text));
        if (continues) {
            if (inBullet && plain.length) plain[plain.length - 1] = joinWrapped(plain[plain.length - 1], item.text);
            previous = item.text;
            continue;
        }
        inBullet = false;
        previous = item.text;
        const last = titles[titles.length - 1];
        if (!describes(item.text) && !/,$/.test(item.text) && (item.text.includes(' | ') || item.text.split(/\s+/).length <= 9)) titles.push({ title: item.text, date: '' });
        else if (last && !last.date && DATE_RANGE.test(item.text) && item.text.length <= 90) last.date = item.text;
    }
    // a section of titles with details under them: one line per certification. A plain list of bullets: every bullet is one.
    if (titles.length) return titles.map(entry => [entry.title, entry.date].filter(Boolean).join(' · '));
    return plain;
}

module.exports = { BULLET, DATE_RANGE, MIN_WRAP_WIDTH, clean, certificationLines, headingType, joinWrapped, parseEntries, unwrapLines, wrapWidthOf };
