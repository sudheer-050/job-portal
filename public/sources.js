(function () {
    'use strict';

    // "Keep your profile up to date": check GitHub / portfolio, import a LinkedIn data export, and review what was found.
    // Nothing is added to the resume or skills until the user approves it here.
    var API = '/api/jobs/profile-sources';
    var card = document.getElementById('sources');
    var panel = document.getElementById('srcPanel');
    if (!card || !panel) return;

    var state = { settings: null, counts: null, findings: [], message: '', error: '', busy: false, started: false };
    var KIND_LABEL = { project: 'Projects', experience: 'Experience', education: 'Education', certification: 'Certifications', skill: 'Skills' };
    var SOURCE_LABEL = { github: 'GitHub', portfolio: 'Portfolio', linkedin: 'LinkedIn' };

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }
    function call(path, options) {
        options = options || {};
        var init = { credentials: 'same-origin', method: options.method || 'GET', headers: {} };
        if (options.form) init.body = options.form;
        else if (options.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(options.body); }
        return fetch(path, init).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) throw new Error(data.error || (res.status === 429 ? 'Too many requests. Try again in a few minutes.' : 'Something went wrong.'));
                return data;
            });
        });
    }
    function safeUrl(url) { return /^https?:\/\//i.test(String(url || '')) ? String(url) : ''; }
    function when(value) { var d = value ? new Date(value) : null; return d && !isNaN(d) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'never'; }

    function resultLine(result) {
        if (!result) return 'Not checked yet.';
        var parts = [];
        if (result.github) parts.push('GitHub: ' + (result.github.ok ? result.github.found + ' found (' + result.github.added + ' new)' : result.github.error));
        if (result.portfolio) parts.push('Portfolio: ' + (result.portfolio.ok
            ? (result.portfolio.found ? result.portfolio.found + ' found (' + result.portfolio.added + ' new)' : 'could not find projects or roles' + (result.portfolio.readable ? '' : ' (the site may need JavaScript to show them)'))
            : result.portfolio.error));
        return parts.join(' · ') || 'Nothing to check yet.';
    }

    function render() {
        var s = state.settings;
        if (!s) { panel.innerHTML = '<span class="source-status">Loading…</span>'; return; }
        var groups = {};
        state.findings.forEach(function (f) { (groups[f.kind] = groups[f.kind] || []).push(f); });
        var order = ['project', 'experience', 'education', 'certification', 'skill'];
        var list = order.filter(function (k) { return groups[k]; }).map(function (kind) {
            return '<div class="src-group"><h4>' + KIND_LABEL[kind] + ' <span class="src-count">(' + groups[kind].length + ')</span></h4>' + groups[kind].map(function (f) {
                var link = safeUrl(f.url);
                return '<label class="src-item"><input type="checkbox" data-src-id="' + Number(f.id) + '"><span class="src-body"><span class="src-title">' + esc(f.title) +
                    ' <span class="src-pill">' + esc(SOURCE_LABEL[f.source] || f.source) + '</span></span>' +
                    (f.summary ? '<span class="src-summary">' + esc(f.summary) + '</span>' : '') +
                    (link ? '<span class="src-link">' + esc(link.replace(/^https?:\/\//, '').slice(0, 80)) + '</span>' : '') + '</span></label>';
            }).join('') + '</div>';
        }).join('');
        panel.innerHTML =
            '<div class="src-rows">' +
            '<div class="src-row"><div class="src-name">GitHub</div><div class="src-field"><label for="srcGithub" class="src-label">Username or profile link</label><div class="src-inline"><input type="text" id="srcGithub" value="' + esc(s.githubUser || '') + '" placeholder="e.g. octocat or github.com/octocat" autocapitalize="none" spellcheck="false"><button type="button" class="btn btn-ghost btn-small" id="srcSaveGithub">Save</button></div><p class="src-note">Reads your public repositories that you own (forks are ignored).</p></div></div>' +
            '<div class="src-row"><div class="src-name">Portfolio</div><div class="src-field">' + (s.portfolioUrl ? '<p class="src-value">' + esc(s.portfolioUrl) + '</p>' : '<p class="src-value src-muted">Not set</p>') + '<p class="src-note">' + (s.portfolioUrl ? 'Reads the public page for projects and roles.' : 'Add your portfolio link under <a href="#profile">Application identity</a> and save.') + '</p></div></div>' +
            '<div class="src-row"><div class="src-name">LinkedIn</div><div class="src-field"><p class="src-note">LinkedIn blocks automatic reading, so use your own data export: LinkedIn → Settings &amp; privacy → Data privacy → <strong>Get a copy of your data</strong>. Pick Positions, Education, Skills, Certifications and Projects, then choose the CSV files here.</p><div class="src-inline"><input type="file" id="srcFiles" accept=".csv,text/csv" multiple aria-label="LinkedIn export CSV files"><button type="button" class="btn btn-ghost btn-small" id="srcImport">Import</button></div></div></div>' +
            '</div>' +
            '<div class="src-actions"><button type="button" class="btn btn-primary" id="srcCheck">Check my sources now</button>' +
            '<label class="src-check"><input type="checkbox" id="srcAuto"' + (s.autoCheck ? ' checked' : '') + '> Check weekly and tell me about new items</label></div>' +
            '<p class="src-status">Last checked: ' + esc(when(s.lastCheckedAt)) + ' — ' + esc(resultLine(s.lastResult)) + '</p>' +
            (state.error ? '<div class="co-error" role="alert">' + esc(state.error) + '</div>' : '') +
            (state.message ? '<div class="src-ok" role="status">' + esc(state.message) + '</div>' : '') +
            '<div class="src-review"><h3>' + (state.findings.length ? state.findings.length + ' new item' + (state.findings.length === 1 ? '' : 's') + ' to review' : 'Nothing new to review') + '</h3>' +
            (state.findings.length ? '<p class="src-note">Tick what is really yours and relevant. Approved items are added to your resume and skills; the rest can be dismissed. Items you dismiss will not come back.</p>' + list +
                '<div class="src-actions"><button type="button" class="btn btn-primary" id="srcAccept">Add selected to my resume &amp; profile</button><button type="button" class="btn btn-ghost" id="srcDismiss">Dismiss selected</button><button type="button" class="btn btn-ghost btn-small" id="srcAll">Select all</button></div>' : '') +
            '</div>';
    }

    function load() {
        return Promise.all([call(API), call(API + '/findings')]).then(function (r) {
            state.settings = r[0].settings; state.counts = r[0].counts; state.findings = r[1].findings; render();
        }).catch(function (error) { state.error = error.message; render(); });
    }

    function run(button, label, task) {
        if (state.busy) return;
        state.busy = true; state.error = ''; state.message = '';
        var original = button.textContent; button.disabled = true; button.textContent = label;
        task().then(function (note) { state.message = note || ''; return load(); })
            .catch(function (error) { state.error = error.message; render(); })
            .then(function () { state.busy = false; });
    }

    function selected() {
        return Array.prototype.map.call(panel.querySelectorAll('input[data-src-id]:checked'), function (box) { return Number(box.dataset.srcId); });
    }

    function decide(button, accept) {
        var ids = selected();
        if (!ids.length) { state.error = 'Tick at least one item first.'; state.message = ''; render(); return; }
        run(button, accept ? 'Adding…' : 'Dismissing…', function () {
            return call(API + '/decide', { method: 'POST', body: accept ? { accept: ids } : { dismiss: ids } }).then(function (r) {
                if (!accept) return r.dismissed + ' item' + (r.dismissed === 1 ? '' : 's') + ' dismissed.';
                var bits = [r.accepted + ' item' + (r.accepted === 1 ? '' : 's') + ' added'];
                if (r.resumeVersion) bits.push('your resume is now version ' + r.resumeVersion);
                if (r.skillsAdded.length) bits.push(r.skillsAdded.length + ' skill' + (r.skillsAdded.length === 1 ? '' : 's') + ' added to your profile');
                if (r.skillsSkipped.length) bits.push('skipped (profile skills are limited to 1,000 characters): ' + r.skillsSkipped.join(', '));
                return bits.join(', ') + '. Career Ops will use them on its next scan.';
            });
        });
    }

    panel.addEventListener('click', function (event) {
        var button = event.target.closest('button');
        if (!button) return;
        if (button.id === 'srcSaveGithub') run(button, 'Saving…', function () {
            return call(API, { method: 'PUT', body: { github: document.getElementById('srcGithub').value, autoCheck: document.getElementById('srcAuto').checked } }).then(function () { return 'GitHub saved.'; });
        });
        else if (button.id === 'srcCheck') run(button, 'Checking…', function () {
            return call(API + '/check', { method: 'POST' }).then(function (r) {
                var added = ((r.result.github || {}).added || 0) + ((r.result.portfolio || {}).added || 0);
                return added ? added + ' new item' + (added === 1 ? '' : 's') + ' found. Review them below.' : 'Checked. Nothing new.';
            });
        });
        else if (button.id === 'srcImport') {
            var files = document.getElementById('srcFiles').files;
            if (!files.length) { state.error = 'Choose one or more CSV files from your LinkedIn export first.'; render(); return; }
            var form = new FormData();
            Array.prototype.forEach.call(files, function (file) { form.append('files', file); });
            run(button, 'Importing…', function () {
                return call(API + '/linkedin', { method: 'POST', form: form }).then(function (r) {
                    var bad = r.files.filter(function (f) { return f.error; });
                    if (bad.length && !r.added) throw new Error(bad.map(function (f) { return f.name + ': ' + f.error; }).join(' '));
                    return r.added + ' new item' + (r.added === 1 ? '' : 's') + ' imported' + (bad.length ? '. Skipped: ' + bad.map(function (f) { return f.name; }).join(', ') : '') + '. Review them below.';
                });
            });
        }
        else if (button.id === 'srcAccept') decide(button, true);
        else if (button.id === 'srcDismiss') decide(button, false);
        else if (button.id === 'srcAll') panel.querySelectorAll('input[data-src-id]').forEach(function (box) { box.checked = true; });
    });

    panel.addEventListener('change', function (event) {
        if (event.target.id !== 'srcAuto') return;
        var github = document.getElementById('srcGithub').value;
        call(API, { method: 'PUT', body: { github: github, autoCheck: event.target.checked } }).then(function (r) { state.settings = r.settings; }).catch(function (error) { state.error = error.message; render(); });
    });

    function start() { if (!state.started) { state.started = true; load(); } }
    new MutationObserver(function () { if (!card.hidden) start(); }).observe(card, { attributes: true, attributeFilter: ['hidden'] });
    if (!card.hidden) start();
})();
