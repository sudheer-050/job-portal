'use strict';

// Turns a resume or cover letter written in simple Markdown into a PDF, a Word (.docx) file or plain Markdown.
// No dependencies: a .docx is a zip of a few XML files and a PDF with a standard font is plain text objects.
// Layout is deliberately single column with no tables or graphics, which is what applicant tracking systems read best.

// ---------------------------------------------------------------------------------------------
// Markdown -> blocks
// ---------------------------------------------------------------------------------------------

/** Split a line into runs of text with bold/italic flags. Links keep their address in brackets. */
function parseInline(source) {
    const text = String(source || '').replace(/`/g, '');
    const runs = [];
    const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index > last) runs.push({ text: text.slice(last, match.index) });
        const token = match[0];
        if (token.startsWith('**') || token.startsWith('__')) runs.push({ text: token.slice(2, -2), bold: true });
        else if (token.startsWith('*')) runs.push({ text: token.slice(1, -1), italic: true });
        else {
            const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
            runs.push({ text: link[1] === link[2] ? link[1] : `${link[1]} (${link[2]})` });
        }
        last = match.index + token.length;
    }
    if (last < text.length) runs.push({ text: text.slice(last) });
    return runs.filter(run => run.text);
}

/** @returns {{type: 'h1'|'h2'|'h3'|'p'|'bullet', runs: {text: string, bold?: boolean, italic?: boolean}[]}[]} */
function parseMarkdown(markdown) {
    const blocks = [];
    for (const raw of String(markdown || '').replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) continue;
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            const [leftText, ...rightText] = heading[2].split('\t');
            blocks.push({ type: `h${Math.min(3, heading[1].length)}`, runs: parseInline(leftText), right: rightText.length ? parseInline(rightText.join(' ')) : null });
            continue;
        }
        if (/^\s*[-*•]\s+/.test(line)) { blocks.push({ type: 'bullet', runs: parseInline(line.replace(/^\s*[-*•]\s+/, '')) }); continue; }
        if (/^\s*---+\s*$/.test(line)) continue;
        const [leftText, ...rightText] = line.trim().split('\t');
        blocks.push({ type: 'p', runs: parseInline(leftText), right: rightText.length ? parseInline(rightText.join(' ')) : null });
    }
    return blocks.filter(block => block.runs.length);
}

// ---------------------------------------------------------------------------------------------
// Word (.docx): a zip with a handful of XML parts, stored without compression
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** @param {{name: string, data: Buffer}[]} files */
function zipStore(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    const stamp = { time: 0x6000, date: 0x5a21 }; // a fixed timestamp keeps the output deterministic
    for (const file of files) {
        const name = Buffer.from(file.name, 'utf8');
        const crc = crc32(file.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(0, 8); // stored
        local.writeUInt16LE(stamp.time, 10);
        local.writeUInt16LE(stamp.date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(file.data.length, 18);
        local.writeUInt32LE(file.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, file.data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(stamp.time, 12);
        central.writeUInt16LE(stamp.date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(file.data.length, 20);
        central.writeUInt32LE(file.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += 30 + name.length + file.data.length;
    }
    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

const xmlEscape = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const DOCX_STYLE = {
    h1: { size: 36, bold: true, before: 0, after: 60 },
    h2: { size: 24, bold: true, before: 220, after: 60, rule: true, color: '1F3F73' },
    h3: { size: 22, bold: true, before: 140, after: 20 },
    p: { size: 21, before: 0, after: 90 },
    bullet: { size: 21, before: 0, after: 30 },
};

function docxRun(run, style) {
    const props = `${run.bold || style.bold ? '<w:b/>' : ''}${run.italic ? '<w:i/>' : ''}${style.color ? `<w:color w:val="${style.color}"/>` : ''}<w:sz w:val="${style.size}"/>`;
    return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
}

function docxParagraph(block) {
    const style = DOCX_STYLE[block.type];
    const indent = block.type === 'bullet' ? '<w:ind w:left="360" w:hanging="260"/>' : '';
    const rule = style.rule ? `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${style.color || '888888'}"/></w:pBdr>` : '';
    const keep = block.type === 'h2' || block.type === 'h3' ? '<w:keepNext/>' : '';
    const lead = block.type === 'bullet' ? `<w:r><w:rPr><w:sz w:val="${style.size}"/></w:rPr><w:t xml:space="preserve">•\t</w:t></w:r>` : '';
    const tabs = block.type === 'bullet' ? '<w:tabs><w:tab w:val="left" w:pos="360"/></w:tabs>' : block.right ? '<w:tabs><w:tab w:val="right" w:pos="10080"/></w:tabs>' : '';
    const right = block.right ? `<w:r><w:tab/></w:r>${block.right.map(run => docxRun(run, { ...style, bold: false, color: '' })).join('')}` : '';
    return `<w:p><w:pPr>${keep}${rule}${tabs}<w:spacing w:before="${style.before}" w:after="${style.after}"/>${indent}</w:pPr>${lead}${block.runs.map(run => docxRun(run, style)).join('')}${right}</w:p>`;
}

function toDocx(markdown, { title = 'Document' } = {}) {
    const body = parseMarkdown(markdown).map(docxParagraph).join('');
    const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1000" w:right="1080" w:bottom="1000" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${ns}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(title)}</dc:title></cp:coreProperties>`;
    const files = [
        { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
        { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
        { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
        { name: 'word/document.xml', data: document },
        { name: 'word/styles.xml', data: styles },
        { name: 'docProps/core.xml', data: core },
    ].map(file => ({ name: file.name, data: Buffer.from(file.data, 'utf8') }));
    return zipStore(files);
}

// ---------------------------------------------------------------------------------------------
// PDF: standard Helvetica, wrapped by hand, one text object per line
// ---------------------------------------------------------------------------------------------

// Helvetica advance widths (1/1000 em) for the printable ASCII range, starting at the space character.
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

// The same for Helvetica-Bold, so bold words are measured and spaced correctly.
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Characters outside plain ASCII that the WinAnsi encoding of a standard PDF font can show.
const WIN_ANSI = new Map([['‘', 0x91], ['’', 0x92], ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97],
    ['…', 0x85], ['€', 0x80], ['™', 0x99], ['→', 0x2d], ['−', 0x2d], [' ', 0x20], [' ', 0x20], [' ', 0x20]]);
const WIDE = { 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x85: 1000, 0x80: 556, 0x99: 1000 };

/** Convert text to bytes the PDF font understands. Anything it cannot show becomes the nearest plain letter, or '?'. */
function toWinAnsi(text) {
    const bytes = [];
    for (const char of String(text).normalize('NFC')) {
        const code = char.codePointAt(0);
        if (code >= 32 && code <= 126) bytes.push(code);
        else if (WIN_ANSI.has(char)) bytes.push(WIN_ANSI.get(char));
        else if (code >= 0xa0 && code <= 0xff) bytes.push(code);
        else {
            const base = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
            bytes.push(/^[\x20-\x7e]$/.test(base) ? base.charCodeAt(0) : 0x3f);
        }
    }
    return bytes;
}

const glyphWidth = (byte, bold) => (byte >= 32 && byte <= 126 ? (bold ? HELVETICA_BOLD : HELVETICA)[byte - 32] : WIDE[byte] || 556);
const textWidth = (bytes, size, bold) => bytes.reduce((sum, byte) => sum + glyphWidth(byte, bold), 0) * size / 1000;

const PDF_STYLE = {
    h1: { size: 19, font: 'F2', bold: true, before: 0, after: 4, lead: 1.2 },
    h2: { size: 12, font: 'F2', bold: true, before: 12, after: 3, lead: 1.25, rule: true, color: [0.12, 0.25, 0.45] },
    h3: { size: 10.5, font: 'F2', bold: true, before: 7, after: 1, lead: 1.25 },
    p: { size: 10, font: 'F1', before: 0, after: 5, lead: 1.35 },
    bullet: { size: 10, font: 'F1', before: 0, after: 2, lead: 1.35, indent: 14 },
};

function pdfLiteral(bytes) {
    let out = '(';
    for (const byte of bytes) out += byte === 0x28 || byte === 0x29 || byte === 0x5c ? `\\${String.fromCharCode(byte)}` : String.fromCharCode(byte);
    return `${out})`;
}

/** Break a paragraph's styled words into lines that fit `maxWidth` points. */
function wrapRuns(runs, style, maxWidth) {
    const words = [];
    for (const run of runs) {
        const bold = run.bold || style.bold;
        for (const part of run.text.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) { words.push({ space: true, bold }); continue; }
            words.push({ bytes: toWinAnsi(part), bold, italic: run.italic });
        }
    }
    const lines = [];
    let line = [];
    let width = 0;
    const flush = () => { while (line.length && line[line.length - 1].space) line.pop(); if (line.length) lines.push(line); line = []; width = 0; };
    for (const word of words) {
        if (word.space) { if (line.length) { line.push(word); width += textWidth([32], style.size, word.bold); } continue; }
        let w = textWidth(word.bytes, style.size, word.bold);
        if (width + w > maxWidth && line.length) flush();
        // a single word longer than the line (a long address) is split rather than running off the page
        while (w > maxWidth) {
            let take = word.bytes.length - 1;
            while (take > 1 && textWidth(word.bytes.slice(0, take), style.size, word.bold) > maxWidth) take -= 1;
            line.push({ bytes: word.bytes.slice(0, take), bold: word.bold, italic: word.italic });
            flush();
            word.bytes = word.bytes.slice(take);
            w = textWidth(word.bytes, style.size, word.bold);
        }
        line.push(word);
        width += w;
    }
    flush();
    return lines;
}

const PAGE = { width: 612, height: 792, margin: 54 };

/** Lay the document out. `reserve` points are kept free at the bottom of every page (a safety margin for other programs). */
function layoutPages(markdown, reserve = 0) {
    const page = PAGE;
    const bottom = page.margin + reserve;
    const pages = [[]];
    let y = page.height - page.margin;
    const newPage = () => { pages.push([]); y = page.height - page.margin; };

    for (const block of parseMarkdown(markdown)) {
        const style = PDF_STYLE[block.type];
        const left = page.margin + (style.indent || 0);
        // dates against the right margin: the left text wraps in what is left of the line
        const rightBytes = block.right ? toWinAnsi(block.right.map(run => run.text).join('')) : null;
        const rightWidth = rightBytes ? textWidth(rightBytes, style.size, false) : 0;
        const lines = wrapRuns(block.runs, style, page.width - page.margin - left - (rightWidth ? rightWidth + 12 : 0));
        const leading = style.size * style.lead;
        // keep a heading together with the first line of what follows
        const needed = style.before + leading * (block.type.startsWith('h') ? 2 : Math.min(lines.length, 2));
        if (y - needed < bottom) newPage();
        y -= style.before;
        lines.forEach((line, index) => {
            if (y - leading < bottom) newPage();
            y -= leading;
            const ops = pages[pages.length - 1];
            if (block.type === 'bullet' && index === 0) ops.push(`BT /F1 ${style.size} Tf ${page.margin + 2} ${y.toFixed(2)} Td (\\225) Tj ET`);
            if (rightBytes && index === 0) ops.push(`BT /F1 ${style.size} Tf ${(page.width - page.margin - rightWidth).toFixed(2)} ${y.toFixed(2)} Td ${pdfLiteral(rightBytes)} Tj ET`);
            if (style.color) ops.push(`${style.color.join(' ')} rg`);
            // one text object per run of same-styled words, spaces included, so text extraction keeps the spaces
            let x = left;
            let segment = null;
            const emit = () => {
                if (!segment) return;
                ops.push(`BT /${segment.font} ${style.size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${pdfLiteral(segment.bytes)} Tj ET`);
                x += textWidth(segment.bytes, style.size, segment.font === 'F2');
                segment = null;
            };
            for (const word of line) {
                if (word.space) { if (segment) segment.bytes.push(32); continue; }
                const font = word.bold ? 'F2' : word.italic ? 'F3' : 'F1';
                if (!segment || segment.font !== font) { emit(); segment = { font, bytes: [] }; }
                segment.bytes.push(...word.bytes);
            }
            emit();
            if (style.color) ops.push('0 g');
            if (style.rule && index === lines.length - 1) {
                ops.push(`${style.color ? `${style.color.join(' ')} RG` : '0.6 G'} 0.5 w ${page.margin} ${(y - 3).toFixed(2)} m ${page.width - page.margin} ${(y - 3).toFixed(2)} l S`);
                y -= 3;
            }
        });
        y -= style.after;
    }

    return pages;
}

/** How many lines a paragraph takes in the PDF layout: body text across the full text width. */
function paragraphLines(text) {
    return wrapRuns(parseInline(text), PDF_STYLE.p, PAGE.width - PAGE.margin * 2).length;
}

/** How many pages the document takes. Used to hold a resume to one page. */
function pageCount(markdown, { reserve = 0 } = {}) {
    return layoutPages(markdown, reserve).length;
}

function toPdf(markdown, { title = 'Document' } = {}) {
    const page = PAGE;
    const pages = layoutPages(markdown);
    // objects: 1 catalog, 2 page tree, 3-5 fonts, then a page + content stream per page, then the info dictionary
    const objects = [];
    const add = body => { objects.push(body); return objects.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(null); // page tree, filled in once the pages exist
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');
    const pageIds = [];
    for (const ops of pages) {
        const stream = Buffer.from(ops.join('\n'), 'latin1');
        const contentId = objects.length + 2;
        pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentId} 0 R >>`));
        add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]));
    }
    objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    const infoId = add(`<< /Title ${pdfLiteral(toWinAnsi(title))} /Producer (Job Portal) >>`);

    const parts = [Buffer.from('%PDF-1.4\n%âãÏÓ\n', 'latin1')];
    const offsets = [];
    let position = parts[0].length;
    objects.forEach((body, index) => {
        offsets.push(position);
        const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
        parts.push(chunk);
        position += chunk.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${position}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// One entry point for the routes
// ---------------------------------------------------------------------------------------------

const FORMATS = {
    pdf: { extension: 'pdf', contentType: 'application/pdf' },
    docx: { extension: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    md: { extension: 'md', contentType: 'text/markdown; charset=utf-8' },
};

function safeFilename(...parts) {
    const base = parts.filter(Boolean).join(' - ').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
    return base || 'document';
}

/** @returns {{buffer: Buffer, contentType: string, filename: string} | null} null when the format is unknown */
function renderDocument({ markdown, format = 'md', baseName = 'document', title }) {
    const spec = FORMATS[String(format).toLowerCase()];
    if (!spec) return null;
    const name = safeFilename(baseName);
    const buffer = spec.extension === 'pdf' ? toPdf(markdown, { title: title || name })
        : spec.extension === 'docx' ? toDocx(markdown, { title: title || name })
            : Buffer.from(String(markdown || ''), 'utf8');
    return { buffer, contentType: spec.contentType, filename: `${name}.${spec.extension}` };
}

module.exports = { layoutPages, pageCount, paragraphLines, FORMATS, HELVETICA, HELVETICA_BOLD, crc32, parseMarkdown, renderDocument, safeFilename, textWidth, toDocx, toPdf, toWinAnsi, zipStore };
