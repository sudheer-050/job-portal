'use strict';

// Serving the pages so a deploy reaches everyone straight away.
//
// Browsers and the CDN in front of this service keep scripts and stylesheets for hours. After a deploy a person could
// run the new page with old scripts, or keep an old copy of the page open and never see a new feature. So:
//  - every local script and stylesheet link gets ?v=<build>, which changes on each start and bypasses any cached copy;
//  - the page itself is never cached, and carries its build id so an open tab can notice a newer version.

const fs = require('node:fs');
const path = require('node:path');

const ASSET = /((?:src|href)=")(\/jobs\/[^"?#]+\.(?:js|css))(")/g;

/** Add ?v=<build> to local scripts and stylesheets, and put the build id in the head. Pure, so it is easy to test. */
function stampPage(html, build) {
    return String(html)
        .replace(ASSET, (_all, open, url, close) => `${open}${url}?v=${encodeURIComponent(build)}${close}`)
        .replace(/<head>/i, `<head>\n<meta name="build" content="${String(build).replace(/[^A-Za-z0-9._-]/g, '')}">`);
}

function createPageSender({ publicDir, build }) {
    const cache = new Map(); // file -> { mtimeMs, html }
    return function sendPage(res, file, headers = {}) {
        const full = path.join(publicDir, file);
        fs.stat(full, (error, stat) => {
            if (error) return res.status(404).type('text').send('Not found');
            let entry = cache.get(file);
            if (!entry || entry.mtimeMs !== stat.mtimeMs) {
                entry = { mtimeMs: stat.mtimeMs, html: stampPage(fs.readFileSync(full, 'utf8'), build) };
                cache.set(file, entry);
            }
            res.set({ 'Cache-Control': 'no-cache', ...headers });
            res.type('html').send(entry.html);
        });
    };
}

module.exports = { createPageSender, stampPage };
