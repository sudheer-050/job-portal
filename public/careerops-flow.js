(function () {
    'use strict';

    // Career Ops inside the Discover step: scans the ranked matches against the user's resume, badges every job card,
    // lets the user sort/filter by the result, and checks a job before "Tailor & apply" starts.
    var API = '/api/jobs/careerops';
    var recs = document.getElementById('recsContainer');
    if (!recs || !recs.parentNode) return;

    var STORE_KEY = 'jp-careerops-flow';
    var prefs = { auto: true, sort: 'match', hide: false };
    try { prefs = Object.assign(prefs, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch (_) { /* storage unavailable */ }
    function savePrefs() { try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch (_) { /* ignore */ } }

    var cache = {};          // jobId -> summary from the server
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

    function setStatus(text) { lastStatus = text; statusEl.textContent = text; }

    /* ---------- Cards ---------- */
    function cardId(card) { var button = card.querySelector('[data-save-job]'); return button ? button.dataset.saveJob : ''; }
    function cards() { return Array.prototype.slice.call(recs.querySelectorAll('.job-card')); }

    function decorate() {
        cards().forEach(function (card) {
            var old = card.querySelector('.cof-row');
            if (old) old.remove();
            var s = cache[cardId(card)];
            if (!s) return;
            var tierKind = s.tier === 'High Confidence' ? 'ok' : s.tier === 'Suspicious' ? 'bad' : 'warn';
            var html = '<span class="cof-score ' + scoreClass(s.score) + '" title="Career Ops score out of 5">' + s.score.toFixed(1) + '/5</span>' +
                '<span class="cof-verdict">' + esc(s.verdict) + '</span>' +
                '<span class="cof-pill ' + tierKind + '">' + esc(s.tier) + '</span>' +
                '<span class="cof-pill">CV ' + esc(s.coverage) + '%</span>';
            if (s.blockers.length) html += '<span class="cof-pill bad">' + esc(s.blockers[0]) + '</span>';
            else if (s.missing.length) html += '<span class="cof-note">Not in your resume: ' + esc(s.missing.slice(0, 3).join(', ')) + '</span>';
            var row = document.createElement('div');
            row.className = 'cof-row';
            row.innerHTML = html;
            var anchor = card.querySelector('.job-meta') || card.querySelector('.job-card-top');
            if (anchor) anchor.insertAdjacentElement('afterend', row);
        });
    }

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
                var hide = !!(prefs.hide && s && flagged(s));
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
