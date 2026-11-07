'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { crc32, parseMarkdown, renderDocument, safeFilename, textWidth, toDocx, toPdf, toWinAnsi } = require('./export');

const RESUME = `# Jordan Rivera
jordan@example.com · (312) 555-0187 · Chicago, IL

## Summary
Data analyst who turns messy operational data into **clear decisions** for business teams.

## Skills
Python, SQL, Tableau, dbt

## Experience

### Data Analyst — Acme Corp & Sons, Chicago IL
2022 - Present
- Built Tableau dashboards used weekly by 40 operations managers
- Wrote SQL pipelines that cut month-end reporting from 5 days to 2
`;

// ---- reading a zip back, so the test does not trust the writer ----
function readZip(buffer) {
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(eocd > 0, 'end of central directory');
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    const files = {};
    for (let i = 0; i < count; i += 1) {
        assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
        const crc = buffer.readUInt32LE(offset + 16);
        const size = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
        const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
        const data = buffer.subarray(dataStart, dataStart + size);
        assert.equal(crc32(data), crc, `crc of ${name}`);
        files[name] = data.toString('utf8');
        offset += 46 + nameLength;
    }
    return files;
}

// every opening tag is closed in order: enough to catch a malformed part without an XML library
function assertBalanced(xml, name) {
    const stack = [];
    for (const match of xml.replace(/<\?[\s\S]*?\?>/g, '').matchAll(/<(\/?)([A-Za-z0-9:]+)([^>]*?)(\/?)>/g)) {
        if (match[4]) continue;
        if (match[1]) assert.equal(stack.pop(), match[2], `${name}: unexpected </${match[2]}>`);
        else stack.push(match[2]);
    }
    assert.deepEqual(stack, [], `${name}: unclosed tags`);
}

test('markdown becomes headings, bullets and styled text', () => {
    const blocks = parseMarkdown(RESUME);
    assert.deepEqual(blocks.slice(0, 2).map(b => [b.type, b.runs[0].text]), [['h1', 'Jordan Rivera'], ['p', 'jordan@example.com · (312) 555-0187 · Chicago, IL']]);
    assert.ok(blocks.some(b => b.type === 'h3' && b.runs[0].text.startsWith('Data Analyst')));
    assert.equal(blocks.filter(b => b.type === 'bullet').length, 2);
    const summary = blocks.find(b => b.runs.some(run => run.bold));
    assert.equal(summary.runs.find(run => run.bold).text, 'clear decisions');
    assert.equal(parseMarkdown('See [my site](https://example.com/me)')[0].runs.map(r => r.text).join(''), 'See my site (https://example.com/me)');
    assert.deepEqual(parseMarkdown('\n\n---\n\n'), []);
});

test('the CRC matches the platform implementation', () => {
    const sample = Buffer.from('The quick brown fox jumps over the lazy dog');
    assert.equal(crc32(sample), 0x414fa339);
    if (typeof zlib.crc32 === 'function') assert.equal(crc32(sample), zlib.crc32(sample));
});

test('a Word file is a valid package with the resume text', () => {
    const files = readZip(toDocx(RESUME, { title: 'Resume' }));
    assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml']);
    for (const [name, xml] of Object.entries(files)) assertBalanced(xml, name);
    const document = files['word/document.xml'];
    assert.match(document, /Jordan Rivera/);
    assert.match(document, /Acme Corp &amp; Sons/, 'special characters are escaped');
    assert.match(document, /<w:b\/>/);
    assert.equal((document.match(/•/g) || []).length, 2, 'one bullet mark per bullet');
    assert.ok(!/\*\*/.test(document), 'no raw markdown left');
    assert.match(files['[Content_Types].xml'], /wordprocessingml\.document\.main\+xml/);
});

test('control characters can never break the Word XML', () => {
    const files = readZip(toDocx('Line with a bell \u0007 and <tags> & "quotes"'));
    assertBalanced(files['word/document.xml'], 'document');
    assert.match(files['word/document.xml'], /&lt;tags&gt; &amp; &quot;quotes&quot;/);
    assert.ok(!files['word/document.xml'].includes('\u0007'));
});

function pdfPages(pdf) {
    const text = pdf.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4'));
    assert.ok(text.trimEnd().endsWith('%%EOF'));
    const start = Number(text.match(/startxref\n(\d+)\n/)[1]);
    assert.equal(text.slice(start, start + 4), 'xref', 'startxref points at the table');
    const count = Number(text.match(/xref\n0 (\d+)\n/)[1]);
    const entries = [...text.slice(start).matchAll(/(\d{10}) 00000 n /g)].map(m => Number(m[1]));
    assert.equal(entries.length, count - 1);
    entries.forEach((offset, index) => assert.equal(text.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`, `object ${index + 1} offset`));
    return { text, pages: Number(text.match(/\/Count (\d+)/)[1]) };
}

function lineBoxes(pdf) {
    // each text object: x position and the width of what it shows
    const boxes = [];
    for (const match of pdf.toString('latin1').matchAll(/BT \/(F\d) ([\d.]+) Tf ([\d.]+) ([\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj ET/g)) {
        const bytes = [...match[5].replace(/\\([()\\])/g, '$1').replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))].map(c => c.charCodeAt(0));
        boxes.push({ right: Number(match[3]) + textWidth(bytes, Number(match[2]), match[1] === 'F2'), text: String.fromCharCode(...bytes) });
    }
    return boxes;
}

test('a PDF is well formed and shows the resume text with its spaces', () => {
    const pdf = toPdf(RESUME, { title: 'Resume' });
    const { text, pages } = pdfPages(pdf);
    assert.equal(pages, 1);
    assert.match(text, /\/BaseFont \/Helvetica-Bold/);
    const shown = lineBoxes(pdf).map(box => box.text).join('\n');
    assert.match(shown, /Jordan Rivera/);
    assert.match(shown, /Built Tableau dashboards used weekly by 40 operations managers/, 'words stay separated by real spaces');
    assert.match(shown, /Acme Corp & Sons/);
});

test('long text wraps inside the margins and flows onto more pages', () => {
    const bullets = Array.from({ length: 90 }, (_, i) => `- Delivered result number ${i} for the finance, sales and operations teams across several regions, including a very long hyphenated-compound-description-without-any-breaks-at-all-that-keeps-going-and-going-and-going-forever`).join('\n');
    const pdf = toPdf(`# Long\n\n## Experience\n${bullets}`);
    const { pages } = pdfPages(pdf);
    assert.ok(pages >= 3, `pages: ${pages}`);
    for (const box of lineBoxes(pdf)) assert.ok(box.right <= 612 - 54 + 1, `line runs off the page: ${box.right}`);
});

test('curly quotes and dashes survive, and letters outside the font degrade safely', () => {
    assert.deepEqual(toWinAnsi('“Hi” – — •'), [0x93, 72, 105, 0x94, 32, 0x96, 32, 0x97, 32, 0x95]);
    assert.deepEqual(toWinAnsi('café'), [99, 97, 102, 0xe9]);
    assert.deepEqual(toWinAnsi('漢'), [0x3f]);
    assert.doesNotThrow(() => toPdf('# 漢字 (parentheses) and \\ backslash'));
    const { text } = pdfPages(toPdf('Text with (parentheses) and a \\ backslash'));
    assert.match(text, /\\\(parentheses\\\)/);
});

test('an empty document is still a valid file', () => {
    assert.equal(pdfPages(toPdf('')).pages, 1);
    assert.ok(Object.keys(readZip(toDocx(''))).includes('word/document.xml'));
});

test('renderDocument picks the format and a safe file name', () => {
    const pdf = renderDocument({ markdown: RESUME, format: 'pdf', baseName: 'Resume - Senior/Data: Analyst?' });
    assert.equal(pdf.contentType, 'application/pdf');
    assert.equal(pdf.filename, 'Resume - Senior Data Analyst.pdf');
    assert.equal(renderDocument({ markdown: RESUME, format: 'DOCX', baseName: 'x' }).filename, 'x.docx');
    const md = renderDocument({ markdown: RESUME, format: 'md', baseName: 'x' });
    assert.equal(md.buffer.toString('utf8'), RESUME);
    assert.equal(renderDocument({ markdown: RESUME, format: 'exe', baseName: 'x' }), null);
    assert.equal(safeFilename('', null), 'document');
    assert.ok(!safeFilename('../../etc/passwd').includes('/'));
});

test('the font metric tables cover every printable ASCII character', () => {
    const { HELVETICA, HELVETICA_BOLD } = require('./export');
    assert.equal(HELVETICA.length, 95);
    assert.equal(HELVETICA_BOLD.length, 95);
    // spot checks against the published Helvetica metrics
    assert.deepEqual([HELVETICA[0], HELVETICA['A'.charCodeAt(0) - 32], HELVETICA['i'.charCodeAt(0) - 32], HELVETICA['W'.charCodeAt(0) - 32]], [278, 667, 222, 944]);
    assert.deepEqual([HELVETICA_BOLD['a'.charCodeAt(0) - 32], HELVETICA_BOLD['m'.charCodeAt(0) - 32], HELVETICA_BOLD['0'.charCodeAt(0) - 32]], [556, 889, 556]);
    assert.ok(textWidth([72, 105], 10, true) > textWidth([72, 105], 10, false), 'bold text is wider');
});
