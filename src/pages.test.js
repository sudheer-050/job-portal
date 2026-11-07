'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPageSender, stampPage } = require('./pages');

const PAGE = '<!doctype html><html><head><title>x</title><link rel="stylesheet" href="/jobs/app.css"></head><body><script src="/jobs/careerops.js"></script><script src="/jobs/sources.js?v=old"></script><a href="/jobs/updates">u</a><img src="/jobs/logo.png"><script>var s = "/jobs/inline.js";</script></body></html>';

test('local scripts and stylesheets get the build id and nothing else changes', () => {
    const out = stampPage(PAGE, 'b1');
    assert.match(out, /href="\/jobs\/app\.css\?v=b1"/);
    assert.match(out, /src="\/jobs\/careerops\.js\?v=b1"/);
    assert.match(out, /src="\/jobs\/sources\.js\?v=old"/, 'a link that already has a version is left alone');
    assert.match(out, /href="\/jobs\/updates"/, 'page links are untouched');
    assert.match(out, /src="\/jobs\/logo\.png"/, 'images are untouched');
    assert.match(out, /var s = "\/jobs\/inline\.js";/, 'text inside scripts is untouched');
    assert.match(out, /<head>\n<meta name="build" content="b1">/);
});

test('the build id cannot break out of the markup', () => {
    const out = stampPage(PAGE, 'a"><script>alert(1)</script>');
    assert.ok(!out.includes('<script>alert(1)'), 'no injected script');
    assert.ok(out.includes('<meta name="build" content="ascriptalert1script">'));
});

test('a page is served stamped, uncached, and re-read when the file changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
    fs.writeFileSync(path.join(dir, 'index.html'), PAGE);
    const send = createPageSender({ publicDir: dir, build: 'b2' });
    const respond = () => new Promise(resolve => {
        const res = { headers: {}, set(h) { Object.assign(this.headers, h); return this; }, type() { return this; }, status(code) { this.code = code; return this; }, send(body) { resolve({ res: this, body }); } };
        send(res, 'index.html', { 'X-Test': '1' });
    });
    const first = await respond();
    assert.match(first.body, /app\.css\?v=b2/);
    assert.equal(first.res.headers['Cache-Control'], 'no-cache');
    assert.equal(first.res.headers['X-Test'], '1');
    await new Promise(r => setTimeout(r, 20));
    fs.writeFileSync(path.join(dir, 'index.html'), PAGE.replace('<title>x</title>', '<title>changed</title>'));
    assert.match((await respond()).body, /<title>changed<\/title>/);
    const missing = await new Promise(resolve => {
        const res = { set() { return this; }, type() { return this; }, status(code) { this.code = code; return this; }, send(body) { resolve({ code: this.code, body }); } };
        send(res, 'nope.html');
    });
    assert.equal(missing.code, 404);
    fs.rmSync(dir, { recursive: true, force: true });
});
