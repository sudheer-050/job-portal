'use strict';

// In production a tunnel sends only /jobs* and /api/jobs/* to this service; every other path on the
// host goes to a different app. A page that links an asset from the site root renders unstyled there,
// even though it works locally. This test keeps every asset URL inside the routed prefix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const ROUTED = /^\/(?:jobs(?:\/|$)|api\/jobs\/)/;
const ASSET = /\.(?:css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map|json)$/i;

for (const page of fs.readdirSync(PUBLIC).filter(name => name.endsWith('.html'))) {
    test(`${page}: every local asset is under a routed prefix and exists`, () => {
        const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
        const urls = [...html.matchAll(/\b(?:href|src)="(\/[^"#?]*)"/g)].map(match => match[1]).filter(url => ASSET.test(url));
        assert.ok(urls.length > 0, 'expected at least one local asset');
        for (const url of urls) {
            assert.match(url, ROUTED, `${url} is not routed to this service in production`);
            const file = path.join(PUBLIC, url.replace(/^\/jobs\//, ''));
            assert.ok(fs.existsSync(file), `${url} does not exist in public/`);
        }
    });
}

test('server.js serves public/ under /jobs', () => {
    const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert.match(source, /app\.use\('\/jobs',\s*express\.static\(/);
});
