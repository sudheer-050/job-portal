'use strict';

// The server and the browser scripts are not loaded by the other tests, so a typo in them (a stray quote in a
// template string, say) would only show up when it is deployed. Parsing every one of them here catches that.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const walk = (dir, filter) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full, filter);
    return filter(full) ? [full] : [];
});

test('every server file parses', () => {
    const files = walk(path.join(root, 'src'), file => file.endsWith('.js'));
    assert.ok(files.length > 10);
    for (const file of files) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }), file);
});

test('every browser script, and the script inside each page, parses', () => {
    const files = walk(path.join(root, 'public'), file => file.endsWith('.js'));
    assert.ok(files.length >= 5);
    for (const file of files) assert.doesNotThrow(() => new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }), file);
    for (const page of walk(path.join(root, 'public'), file => file.endsWith('.html'))) {
        const html = fs.readFileSync(page, 'utf8');
        for (const [index, match] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
            assert.doesNotThrow(() => new vm.Script(match[1], { filename: `${page}#${index}` }), `${page} script ${index}`);
        }
    }
});
