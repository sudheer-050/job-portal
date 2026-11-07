(function () {
    'use strict';

    // Career Ops inside the Discover step: scans the ranked matches against the user's resume, badges every job card,
    // lets the user sort/filter by the result, and checks a job before "Tailor & apply" starts.
    var API = '/api/jobs/careerops';
    var recs = document.getElementById('recsContainer');
    if (!recs || !recs.parentNode) return;

    var STORE_KEY = 'jp-careerops-flow';
    var prefs = { auto: true, sort: 'match', hide: false, hideApplied: true, newOnly: false };
    try { prefs = Object.assign(prefs, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch (_) { /* storage unavailable */ }
    function savePrefs() { try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ } }

    var cache = {};          // jobId -> summary from the server
    var analysis = {};       // jobId -> full evaluation (loaded when "Why this score" is opened)
    var open = {};           // jobId -> analysis panel is open
    var askOpen = {};        // jobId -> the missing-skills question is expanded
    var askMsg = {};         // jobId -> last result of adding skills
    var COVERAGE_TARGET = 95; // below this CV match the panel offers to add skills the person really has
    var scanTimer = null;
    var scanning = false;
    var lastStatus = '';

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }
    function call(path, options) {
        options = options || {};
        var init = { credentials: 'same-origin', method: options.method || 'GET', headers: {} };
        if (options.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(options.body); }
        return fetch(path, init).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) throw new Error(data.error || (res.status === 429 ? 'Too many requests, try again shortly.' : 'Something went wrong.'));
                return data;
            });
        });
    }
    function scoreClass(score) { return score >= 4 ? 'good' : score >= 3.5 ? 'mid' : 'low'; }
    function flagged(summary) { return !summary.gate.proceed; }

    /* ---------- Toolbar ---------- */
    var bar = document.createElement('div');
    bar.className = 'cof-toolbar';
    bar.id = 'coToolbar';
    bar.setAttribute('data-workspace-view', 'discover'); // shown and hidden with the Discover view
    bar.innerHTML =
        '<div class="cof-status" id="cofStatus" role="status" aria-live="polite">Career Ops will scan your matches against your resume.</div>' +
        '<div class="cof-controls">' +
        '<label class="cof-check"><input type="checkbox" id="cofAuto"> Auto-scan</label>' +
        '<label class="cof-check cof-select">Sort <select id="cofSort" aria-label="Sort matches"><option value="match">Best match %</option><option value="co">Career Ops score</option></select></label>' +
        '<label class="cof-check"><input type="checkbox" id="cofHide"> Hide below 4.0 &amp; suspicious</label>' +
        '<label class="cof-check"><input type="checkbox" id="cofHideApplied"> Hide applied</label>' +
        '<label class="cof-check"><input type="checkbox" id="cofNewOnly"> New only</label>' +
        '<button type="button" class="btn btn-ghost btn-small" id="cofScan">Scan matches</button>' +
        '</div>';
    recs.parentNode.insertBefore(bar, recs);

    var statusEl = document.getElementById('cofStatus');
    var autoEl = document.getElementById('cofAuto');
    var sortEl = document.getElementById('cofSort');
    var hideEl = document.getElementById('cofHide');
    var scanBtn = document.getElementById('cofScan');
    autoEl.checked = !!prefs.auto;
    sortEl.value = prefs.sort === 'co' ? 'co' : 'match';
    hideEl.checked = !!prefs.hide;
    var hideAppliedEl = document.getElementById('cofHideApplied');
    var newOnlyEl = document.getElementById('cofNewOnly');
    hideAppliedEl.checked = !!prefs.hideApplied;
    newOnlyEl.checked = !!prefs.newOnly;

    function setStatus(text) { lastStatus = text; statusEl.textContent = text; }

    /* ---------- Cards ---------- */
    function cardId(card) { var button = card.querySelector('[data-save-job]'); return button ? button.dataset.saveJob : ''; }
    function cards() { return Array.prototype.slice.call(recs.querySelectorAll('.job-card')); }

    function decorate() {
        cards().forEach(function (card) {
            card.querySelectorAll('.cof-row, .cof-panel, .cof-checkbar').forEach(function (node) { node.remove(); });
            var s = cache[cardId(card)];
            if (!s) return;
            var tierKind = s.tier === 'High Confidence' ? 'ok' : s.tier === 'Suspicious' ? 'bad' : 'warn';
            var html = '<span class="cof-score ' + scoreClass(s.score) + '" title="Career Ops score out of 5">' + s.score.toFixed(1) + '/5</span>' +
                '<span class="cof-verdict">' + esc(s.verdict) + '</span>' +
                '<span class="cof-pill ' + tierKind + '">' + esc(s.tier) + '</span>' +
                '<span class="cof-pill">CV ' + esc(s.coverage) + '%</span>';
            if (s.blockers.length) html += '<span class="cof-pill bad">' + esc(s.blockers[0]) + '</span>';
            else if (s.missing.length) html += '<span class="cof-note">Not in your resume: ' + esc(s.missing.slice(0, 3).join(', ')) + '</span>';
            var id = cardId(card);
            // The check sits directly below the Tailor & apply buttons: a summary on the left and a
            // same-size button on the right that opens the full pre-apply check.
            var button = '<button type="button" class="btn btn-ghost btn-small cof-why" data-cof-why="' + esc(id) + '" aria-expanded="' + (open[id] ? 'true' : 'false') + '">' + (open[id] ? 'Hide check' : 'Check before you apply') + '</button>';
            var row = document.createElement('div');
            row.className = 'cof-checkbar';
            row.innerHTML = '<div class="cof-row">' + html + '</div>' + button;
            var footer = card.querySelector('.job-card-footer') || card.querySelector('.job-meta') || card.querySelector('.job-card-top');
            if (footer) footer.insertAdjacentElement('afterend', row);
            if (open[id]) {
                var panelEl = document.createElement('div');
                panelEl.className = 'cof-panel';
                panelEl.innerHTML = analysis[id] ? analysisHtml(analysis[id], s) : '<p class="cof-note">Loading the check…</p>';
                row.insertAdjacentElement('afterend', panelEl);
            }
        });
    }

    /* ---------- Skills analysis (the "Why this score" panel) ---------- */
    function statusPill(status) { return status === 'match' ? '<span class="cof-pill ok">Match</span>' : status === 'partial' ? '<span class="cof-pill warn">Partial</span>' : status === 'gap' ? '<span class="cof-pill bad">Gap</span>' : '<span class="cof-pill">Check</span>'; }
    function chips(items, kind) { return items.length ? '<div class="cof-chips">' + items.map(function (i) { return '<span class="cof-pill ' + kind + '">' + esc(i.term) + '</span>'; }).join('') + '</div>' : '<p class="cof-note">None</p>'; }

    // CV match below the target: let the person see what is missing and say which of it they really have.
    function skillsAsk(data, b) {
        var id = data.jobId;
        var coverage = data.evaluation && data.evaluation.meta ? data.evaluation.meta.coverage : null;
        var missing = b.B.missing || [];
        var msg = askMsg[id] ? '<p class="cof-note" role="status">' + esc(askMsg[id]) + '</p>' : '';
        if (coverage === null || coverage >= COVERAGE_TARGET || !missing.length) return msg;
        var html = '<div class="cof-ask"><h4>CV match is ' + esc(coverage) + '% — aim for ' + COVERAGE_TARGET + '%</h4>' + msg +
            '<button type="button" class="btn btn-ghost btn-small" data-cof-viewmissing="' + esc(id) + '" aria-expanded="' + (askOpen[id] ? 'true' : 'false') + '">' + (askOpen[id] ? 'Hide missing skills' : 'View missing skills (' + missing.length + ')') + '</button>';
        if (askOpen[id]) {
            html += '<div class="cof-ask-body"><p class="cof-note">Do you actually have any of these? Tick only the ones you genuinely do. They are added to your Skills section (never to your job history), your ATS score and CV match go up, and nothing is ticked for you.</p><div class="cof-chips">' +
                missing.map(function (m) { return '<label class="co-check co-skillpick"><input type="checkbox" data-cof-skill="' + esc(m.term) + '"> ' + esc(m.term) + '</label>'; }).join('') + '</div>' +
                '<label class="co-check"><input type="checkbox" data-cof-save checked> Also save them to my profile skills so every resume and application uses them</label>' +
                '<div class="cof-actions"><button type="button" class="btn btn-primary btn-small" data-cof-addskills="' + esc(id) + '">Add ticked skills to my resume</button></div></div>';
        }
        return html + '</div>';
    }

    function analysisHtml(data, s) {
        var b = data.evaluation.blocks;
        var A = b.A || {}, C = b.C || {}, E = b.E || {}, F = b.F || {};
        var gate = s && s.gate ? s.gate : null;
        var decision = gate ? '<div class="cof-decision ' + (gate.proceed ? 'ok' : 'warn') + '"><strong>' + (gate.proceed ? 'Good to apply' : 'Think before you apply') + '</strong><span>' + esc(gate.reason || '') + '</span></div>' : '';
        var about = '<h4>About this role</h4><ul class="cof-list">' +
            (A.tldr ? '<li>' + esc(A.tldr) + '</li>' : '') +
            '<li>Level <strong>' + esc(A.seniority || 'unknown') + '</strong> · ' + esc(A.workplace || 'unknown') + ' · ' + esc(A.location || 'location not listed') + (A.requiredYears ? ' · asks for ' + esc(A.requiredYears) + '+ years' : '') + '</li></ul>';
        var feature = (E.keywordsToFeature || []).length ? '<h4>Feature these in your application</h4><div class="cof-chips">' + E.keywordsToFeature.map(function (k) { return '<span class="cof-pill ok">' + esc(k) + '</span>'; }).join('') + '</div>' : '';
        var honest = (E.honestGaps || []).length ? '<h4>Gaps to address honestly</h4><ul class="cof-list">' + E.honestGaps.map(function (g) { return '<li>' + esc(String(g).slice(0, 160)) + '</li>'; }).join('') + '</ul><p class="cof-note">Never add these to your resume unless they are true.</p>' : '';
        var ask = (F.askThem || []).length ? '<h4>Ask the employer</h4><ul class="cof-list">' + F.askThem.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>' : '';
        var reqs = b.B.requirements.slice(0, 8).map(function (r) {
            return '<li>' + statusPill(r.status) + ' ' + esc(r.requirement.slice(0, 140)) + (r.priority === 'preferred' ? ' <span class="cof-note">(nice to have)</span>' : '') +
                (r.evidence ? '<div class="cof-evidence">Your resume: “' + esc(r.evidence) + '”</div>' : '') + '</li>';
        }).join('');
        var signals = (b.G.signals || []).filter(function (s) { return s.kind !== 'positive'; }).slice(0, 3).map(function (s) { return '<li>' + esc(s.label) + (s.detail ? ' <span class="cof-note">— ' + esc(s.detail) + '</span>' : '') + '</li>'; }).join('');
        return '<div class="cof-analysis">' + decision + about +
            '<h4>Skills you evidence</h4>' + chips(b.B.present, 'ok') +
            '<h4>Mentioned only once</h4>' + chips(b.B.thin, 'warn') +
            '<h4>Not in your resume</h4>' + chips(b.B.missing, 'bad') +
            skillsAsk(data, b) +
            (reqs ? '<h4>Requirements</h4><ul class="cof-list">' + reqs + '</ul>' : '') +
            '<h4>Fit</h4><ul class="cof-list"><li>Level: job is <strong>' + esc(b.C.jdLevel) + '</strong>, you are <strong>' + esc(b.C.yourLevel) + '</strong> (' + esc(String(b.C.fit).replace('-', ' ')) + ').</li><li>Pay: ' + esc(b.D.summary) + '</li>' + (C.plan ? '<li>Approach: ' + esc(C.plan) + '</li>' : '') + '</ul>' + feature + honest + ask +
            (signals ? '<h4>Posting signals</h4><ul class="cof-list">' + signals + '</ul>' : '') +
            '<div class="cof-actions"><button type="button" class="btn btn-ghost btn-small" data-cof-full="' + esc(data.jobId) + '">Open full evaluation</button></div></div>';
    }

    function toggleAnalysis(id) {
        open[id] = !open[id];
        decorate();
        if (!open[id] || analysis[id]) return;
        call(API + '/evaluations/' + encodeURIComponent(id)).then(function (data) { analysis[id] = data; })
            .catch(function () { analysis[id] = null; open[id] = false; })
            .then(decorate);
    }

    function addSkills(button) {
        var id = button.dataset.cofAddskills;
        var panelEl = button.closest('.cof-panel');
        var ticked = [].slice.call(panelEl.querySelectorAll('input[data-cof-skill]:checked')).map(function (box) { return box.dataset.cofSkill; });
        var save = panelEl.querySelector('input[data-cof-save]');
        if (!ticked.length) { askMsg[id] = 'Tick at least one skill you genuinely have.'; decorate(); return; }
        button.disabled = true;
        button.textContent = 'Adding…';
        call(API + '/resume', { method: 'POST', body: { jobId: id, targetScore: 90, confirmedSkills: ticked, saveToProfile: !save || save.checked } }).then(function (built) {
            askMsg[id] = 'Added ' + ticked.join(', ') + '. CV match is now ' + built.coverage + '% and the ATS score is ' + built.ats.score + '/100.' + (save && !save.checked ? '' : ' Saved to your profile.');
            delete cache[id];
            delete analysis[id];
            return ensureSummary(id).then(function () { return call(API + '/evaluations/' + encodeURIComponent(id)); }).then(function (data) { analysis[id] = data; });
        }).catch(function (error) {
            askMsg[id] = 'Could not add those skills: ' + error.message;
        }).then(function () { askOpen[id] = !!askOpen[id]; refreshView(); });
    }

    recs.addEventListener('click', function (event) {
        var viewMissing = event.target.closest('[data-cof-viewmissing]');
        if (viewMissing) { var vid = viewMissing.dataset.cofViewmissing; askOpen[vid] = !askOpen[vid]; decorate(); return; }
        var addBtn = event.target.closest('[data-cof-addskills]');
        if (addBtn) { addSkills(addBtn); return; }
        var why = event.target.closest('[data-cof-why]');
        if (why) { toggleAnalysis(why.dataset.cofWhy); return; }
        var full = event.target.closest('[data-cof-full]');
        if (full) {
            var save = recs.querySelector('[data-save-job="' + (window.CSS && CSS.escape ? CSS.escape(full.dataset.cofFull) : full.dataset.cofFull) + '"]');
            var evaluate = save && save.closest('.job-card') && save.closest('.job-card').querySelector('[data-co-evaluate]');
            if (evaluate) evaluate.click();
        }
    });

    function apply() {
        var hidden = 0;
        recs.querySelectorAll('.job-list').forEach(function (list) {
            var items = Array.prototype.slice.call(list.querySelectorAll('.job-card'));
            items.forEach(function (card, index) { if (card.dataset.cofOrder === undefined) card.dataset.cofOrder = String(index); });
            var ordered = items.slice().sort(function (a, b) {
                if (prefs.sort === 'co') {
                    var sa = cache[cardId(a)], sb = cache[cardId(b)];
                    var diff = (sb ? sb.score : -1) - (sa ? sa.score : -1);
                    if (diff) return diff;
                }
                return Number(a.dataset.cofOrder) - Number(b.dataset.cofOrder);
            });
            ordered.forEach(function (card) { list.appendChild(card); });
            ordered.forEach(function (card) {
                var s = cache[cardId(card)];
                var hide = !!(prefs.hide && s && flagged(s)) ||
                    !!(prefs.hideApplied && card.dataset.appStatus === 'applied') ||
                    !!(prefs.newOnly && card.dataset.isNew !== '1');
                card.hidden = hide;
                if (hide) hidden += 1;
            });
        });
        return hidden;
    }

    function summaryText() {
        var list = cards().map(function (c) { return cache[cardId(c)]; }).filter(Boolean);
        if (!list.length) return lastStatus;
        var good = list.filter(function (s) { return s.gate.proceed; }).length;
        var hidden = cards().filter(function (c) { return c.hidden; }).length;
        return 'Career Ops scanned ' + list.length + ' match' + (list.length === 1 ? '' : 'es') + ': ' + good + ' worth applying to (4.0+), ' + (list.length - good) + ' flagged' + (hidden ? ', ' + hidden + ' hidden' : '') + '.';
    }

    function refreshView() { decorate(); apply(); setStatus(summaryText()); }

    /* ---------- Scanning ---------- */
    function scan(force) {
        if (scanning) return;
        var ids = cards().map(cardId).filter(Boolean).filter(function (id, i, all) { return all.indexOf(id) === i; });
        if (!ids.length) return;
        if (!force && ids.every(function (id) { return cache[id]; })) { refreshView(); return; }
        scanning = true;
        scanBtn.disabled = true;
        setStatus('Career Ops is scanning ' + ids.length + ' match' + (ids.length === 1 ? '' : 'es') + ' against your resume…');
        call(API + '/scan', { method: 'POST', body: { jobIds: ids.slice(0, 100) } }).then(function (data) {
            if (data.resumeMissing) { setStatus('Upload your resume (Profile & resume) so Career Ops can scan your matches.'); return; }
            data.results.forEach(function (s) { cache[s.jobId] = s; });
            refreshView();
        }).catch(function (error) {
            setStatus('Career Ops could not scan right now: ' + error.message);
        }).then(function () { scanning = false; scanBtn.disabled = false; });
    }

    function scheduleScan() {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(function () { if (prefs.auto) scan(false); }, 350);
    }

    var firstSeen = false;
    new MutationObserver(function () {
        if (!cards().length) return;
        decorate();
        apply();
        if (!firstSeen) { firstSeen = true; }
        setStatus(summaryText() || (prefs.auto ? 'Career Ops is getting ready to scan your matches…' : 'Auto-scan is off. Press “Scan matches” to check them against your resume.'));
        scheduleScan();
    }).observe(recs, { childList: true });

    autoEl.addEventListener('change', function () { prefs.auto = autoEl.checked; savePrefs(); if (prefs.auto) scan(false); });
    sortEl.addEventListener('change', function () { prefs.sort = sortEl.value; savePrefs(); apply(); });
    hideAppliedEl.addEventListener('change', function () { prefs.hideApplied = hideAppliedEl.checked; savePrefs(); apply(); setStatus(summaryText()); });
    newOnlyEl.addEventListener('change', function () { prefs.newOnly = newOnlyEl.checked; savePrefs(); apply(); setStatus(summaryText()); });
    hideEl.addEventListener('change', function () { prefs.hide = hideEl.checked; savePrefs(); apply(); setStatus(summaryText()); });
    scanBtn.addEventListener('click', function () { scan(true); });

    /* ---------- Check before applying ---------- */
    var modal = null;
    var opener = null;

    function closeModal() {
        if (!modal) return;
        document.removeEventListener('keydown', onKey, true);
        modal.remove();
        modal = null;
        if (opener && opener.focus) opener.focus();
        opener = null;
    }
    function onKey(event) {
        if (event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
        if (event.key !== 'Tab' || !modal) return;
        var focusable = modal.querySelectorAll('button');
        var first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    function showGate(s, button) {
        closeModal();
        opener = button;
        modal = document.createElement('div');
        modal.className = 'cof-modal';
        var tierKind = s.tier === 'High Confidence' ? 'ok' : s.tier === 'Suspicious' ? 'bad' : 'warn';
        modal.innerHTML =
            '<div class="cof-dialog" role="dialog" aria-modal="true" aria-labelledby="cofGateTitle">' +
            '<h2 id="cofGateTitle">Check before you apply</h2>' +
            '<div class="cof-row cof-row-lg"><span class="cof-score ' + scoreClass(s.score) + '">' + s.score.toFixed(1) + '/5</span><span class="cof-verdict">' + esc(s.verdict) + '</span><span class="cof-pill ' + tierKind + '">' + esc(s.tier) + '</span></div>' +
            '<p class="cof-reason">' + esc(s.gate.reason) + '</p>' +
            (s.blockers.length > 1 ? '<ul>' + s.blockers.slice(1).map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>' : '') +
            '<p class="cof-note">Your resume covers about ' + esc(s.coverage) + '% of this job\'s keywords.' + (s.missing.length ? ' Not in your resume: ' + esc(s.missing.join(', ')) + '.' : '') + '</p>' +
            '<p class="cof-note">Fewer, better-fit applications work better than many weak ones. Career Ops recommends applying only at 4.0/5 or above.</p>' +
            '<div class="cof-actions"><button type="button" class="btn btn-ghost" data-cof="cancel">Cancel</button><button type="button" class="btn btn-ghost" data-cof="open">See full evaluation</button><button type="button" class="btn btn-primary" data-cof="go">Apply anyway</button></div>' +
            '</div>';
        document.body.appendChild(modal);
        document.addEventListener('keydown', onKey, true);
        modal.addEventListener('click', function (event) {
            if (event.target === modal) { closeModal(); return; }
            var action = event.target.closest('[data-cof]');
            if (!action) return;
            var kind = action.dataset.cof;
            var target = opener;
            closeModal();
            if (kind === 'go' && target) { target.dataset.cofOk = '1'; target.click(); }
            if (kind === 'open' && target) {
                var card = target.closest('.job-card');
                var evaluate = card && card.querySelector('[data-co-evaluate]');
                if (evaluate) evaluate.click();
            }
        });
        modal.querySelector('[data-cof="cancel"]').focus();
    }

    function ensureSummary(id) {
        var cached = cache[id];
        if (cached && Date.now() - new Date(cached.scannedAt).getTime() < 10 * 60 * 1000) return Promise.resolve(cached);
        return call(API + '/scan', { method: 'POST', body: { jobIds: [id] } }).then(function (data) {
            if (data.results && data.results[0]) { cache[id] = data.results[0]; return cache[id]; }
            return null; // no resume or unknown job: never block the user
        }).catch(function () { return null; });
    }

    document.addEventListener('click', function (event) {
        var button = event.target.closest && event.target.closest('[data-tailor-job]');
        if (!button) return;
        if (button.dataset.cofOk === '1') { delete button.dataset.cofOk; return; } // already confirmed: let the portal handle it
        event.preventDefault();
        event.stopImmediatePropagation();
        var original = button.textContent;
        button.disabled = true;
        button.textContent = 'Checking…';
        ensureSummary(button.dataset.tailorJob).then(function (summary) {
            button.disabled = false;
            button.textContent = original;
            if (!summary || summary.gate.proceed) { button.dataset.cofOk = '1'; button.click(); return; }
            decorate();
            showGate(summary, button);
        });
    }, true);
})();
