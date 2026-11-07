(function () {
    'use strict';

    var API = '/api/jobs/careerops';
    var card = document.getElementById('careerops');
    var panel = document.getElementById('coPanel');
    var tabs = document.getElementById('coTabs');
    if (!card || !panel || !tabs) return;

    var state = { tab: 'evaluate', jobId: '', draft: {}, evaluation: null, resume: null, savedJobs: [], pipeline: [], started: false, extra: null,
        ai: null, suggestions: null, target: 90, aiConsent: false, application: null, confirmed: [] };

    function esc(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function call(path, options) {
        options = options || {};
        var init = { credentials: 'same-origin', method: options.method || 'GET', headers: {} };
        if (options.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(options.body); }
        return fetch(path, init).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) { var failure = new Error(data.error || 'Something went wrong.'); failure.data = data; throw failure; }
                return data;
            });
        });
    }

    function busy(button, on, label) {
        if (!button) return;
        if (on) { button.dataset.label = button.textContent; button.textContent = label || 'Working…'; button.disabled = true; }
        else { button.textContent = button.dataset.label || button.textContent; button.disabled = false; }
    }

    function copy(text, button) {
        var done = function () { if (button) { var old = button.textContent; button.textContent = 'Copied'; setTimeout(function () { button.textContent = old; }, 1400); } };
        try { navigator.clipboard.writeText(text).then(done, function () {}); } catch (_) { /* clipboard unavailable */ }
    }

    function scoreClass(score) { return score >= 4 ? 'good' : score >= 3.5 ? 'mid' : 'low'; }
    function chip(text, kind) { return '<span class="co-chip ' + (kind || '') + '">' + esc(text) + '</span>'; }
    function list(items) { return items && items.length ? '<ul>' + items.map(function (item) { return '<li>' + esc(item) + '</li>'; }).join('') + '</ul>' : ''; }
    function money(n) { return n ? '$' + Number(n).toLocaleString() : ''; }

    /* ---------- Job picker ---------- */
    function jobOptions() {
        var seen = {};
        var out = '<option value="">Paste a new job description…</option>';
        if (state.extra) { seen[state.extra.id] = 1; out += '<optgroup label="Selected"><option value="' + esc(state.extra.id) + '">' + esc(state.extra.label) + '</option></optgroup>'; }
        var saved = state.savedJobs.filter(function (j) { return !seen[j.id]; });
        saved.forEach(function (j) { seen[j.id] = 1; });
        if (saved.length) out += '<optgroup label="Saved jobs">' + saved.map(function (j) { return '<option value="' + esc(j.id) + '">' + esc(j.title + (j.company ? ' — ' + j.company : '')) + '</option>'; }).join('') + '</optgroup>';
        var pipe = state.pipeline.filter(function (j) { return !seen[j.jobId]; });
        if (pipe.length) out += '<optgroup label="In my pipeline">' + pipe.map(function (j) { return '<option value="' + esc(j.jobId) + '">' + esc(j.title + (j.company ? ' — ' + j.company : '')) + '</option>'; }).join('') + '</optgroup>';
        return out;
    }

    function pasteFields() {
        var d = state.draft;
        return '<div class="co-grid" id="coPaste">' +
            '<div><label for="coTitle">Job title</label><input type="text" id="coTitle" value="' + esc(d.title) + '" placeholder="Senior Data Analyst"></div>' +
            '<div><label for="coCompany">Company</label><input type="text" id="coCompany" value="' + esc(d.company) + '" placeholder="Employer name"></div>' +
            '<div><label for="coLocation">Location</label><input type="text" id="coLocation" value="' + esc(d.location) + '" placeholder="Chicago, IL"></div>' +
            '<div><label for="coUrl">Posting URL (https)</label><input type="url" id="coUrl" value="' + esc(d.url) + '" placeholder="https://…"></div>' +
            '<div><label for="coSalMin">Pay from</label><input type="number" id="coSalMin" min="0" step="1000" value="' + esc(d.salaryMin) + '"></div>' +
            '<div><label for="coSalMax">Pay to</label><input type="number" id="coSalMax" min="0" step="1000" value="' + esc(d.salaryMax) + '"></div>' +
            '<div class="wide"><label for="coDesc">Job description</label><textarea id="coDesc" rows="9" maxlength="30000" placeholder="Paste the full posting text. It is treated as data only.">' + esc(d.description) + '</textarea></div>' +
            '<label class="co-check wide"><input type="checkbox" id="coSave"' + (d.save ? ' checked' : '') + '> Add this job to my pipeline so I can track it</label></div>';
    }

    function readDraft() {
        var get = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
        if (!document.getElementById('coPaste')) return;
        var save = document.getElementById('coSave');
        state.draft = { title: get('coTitle').trim(), company: get('coCompany').trim(), location: get('coLocation').trim(), url: get('coUrl').trim(),
            salaryMin: get('coSalMin'), salaryMax: get('coSalMax'), description: get('coDesc'), save: !!(save && save.checked) };
    }

    function jobPayload() {
        if (state.jobId) return { jobId: state.jobId };
        readDraft();
        var d = state.draft;
        return { title: d.title, company: d.company, location: d.location, url: d.url, salaryMin: d.salaryMin, salaryMax: d.salaryMax, description: d.description, save: d.save };
    }

    /* ---------- Evaluate tab ---------- */
    function renderEvaluate() {
        panel.innerHTML =
            '<label for="coJob">Job to evaluate</label><select id="coJob">' + jobOptions() + '</select>' +
            '<div id="coPasteWrap">' + (state.jobId ? '' : pasteFields()) + '</div>' +
            '<div class="co-row"><button type="button" class="btn btn-primary" id="coEvalBtn">Evaluate</button>' +
            '<button type="button" class="btn btn-ghost" id="coLiveBtn"' + (state.jobId ? '' : ' disabled') + '>Is this posting still open?</button>' +
            '<button type="button" class="btn btn-ghost" id="coResumeBtn">Build tailored resume</button></div>' +
            '<p class="co-note">Scores combine keyword coverage, requirement match, your saved preferences, level fit and pay, then cap for scams and hard blockers. Below 4.0/5 the portal recommends against applying.</p>' +
            '<div class="co-error" id="coError" role="alert" hidden></div><div id="coResult"></div>';
        document.getElementById('coJob').value = state.jobId;
        if (state.evaluation) renderEvaluation(state.evaluation);
    }

    function showError(message) { var el = document.getElementById('coError'); if (el) { el.textContent = message || ''; el.hidden = !message; } }

    function reqIcon(status) { return status === 'match' ? chip('Match', 'ok') : status === 'partial' ? chip('Partial', 'warn') : status === 'gap' ? chip('Gap', 'bad') : chip('Check', ''); }

    function renderEvaluation(data) {
        var ev = data.evaluation, b = ev.blocks, v = ev.verdict, g = b.G;
        var tierKind = g.tier === 'High Confidence' ? 'ok' : g.tier === 'Suspicious' ? 'bad' : 'warn';
        var html = '<div class="co-hero"><div class="co-score ' + scoreClass(ev.score) + '"><strong>' + ev.score.toFixed(1) + '</strong><span>out of 5</span></div>' +
            '<div class="co-verdict"><h3>' + esc(v.label) + (data.job && data.job.title ? ' · ' + esc(data.job.title) : '') + '</h3><p>' + esc(v.text) + '</p>' +
            '<div class="co-chips">' + chip(b.A.archetype, 'brand') + chip('Legitimacy: ' + g.tier, tierKind) + chip('CV coverage ' + b.B.coverage + '%', b.B.coverage >= 60 ? 'ok' : 'warn') +
            (data.jobId ? '' : chip('Not saved to pipeline', '')) + '</div></div></div>';
        if (ev.blockers.length) html += '<div class="co-card"><h4>Hard blockers</h4>' + list(ev.blockers) + '</div>';
        if (ev.warnings) html += '<p class="co-note">' + esc(ev.warnings.join(' ')) + '</p>';

        html += block('A · Role summary', b.A.archetype, '<p>' + esc(b.A.tldr) + '</p>' + list(['Seniority: ' + b.A.seniority, 'Work style: ' + b.A.workplace, 'Location: ' + b.A.location,
            b.A.requiredYears != null ? 'Stated experience: ' + b.A.requiredYears + '+ years' : 'No minimum years stated']), true);

        var reqs = b.B.requirements.map(function (r) {
            return '<div class="co-req">' + reqIcon(r.status) + '<div>' + esc(r.requirement) + (r.priority === 'preferred' ? ' ' + chip('nice to have', '') : '') + '</div>' + (r.evidence ? '<div class="co-evidence">Your resume: “' + esc(r.evidence) + '”</div>' : '') + '</div>';
        }).join('');
        var chips = function (items, kind) { return items.length ? '<div class="co-chips">' + items.map(function (i) { return chip(i.term, kind); }).join('') + '</div>' : '<p>None</p>'; };
        html += block('B · CV match', b.B.coverage + '% keyword coverage', '<div class="co-bar"><i style="width:' + b.B.coverage + '%"></i></div>' + (reqs || '<p>No explicit requirements were detected.</p>') +
            '<p><strong>Evidenced</strong></p>' + chips(b.B.present, 'ok') + '<p><strong>Mentioned once</strong></p>' + chips(b.B.thin, 'warn') + '<p><strong>Not in your resume</strong> (never added automatically)</p>' + chips(b.B.missing, 'bad'), true);

        html += block('C · Level & strategy', b.C.fit.replace('-', ' '), '<p>Posting level: <strong>' + esc(b.C.jdLevel) + '</strong> · Your level: <strong>' + esc(b.C.yourLevel) + '</strong></p><p>' + esc(b.C.plan) + '</p>');
        var adv = b.D.advertised ? money(b.D.advertised.min) + ' – ' + money(b.D.advertised.max) : 'Not listed';
        html += block('D · Compensation', adv, '<p>' + esc(b.D.summary) + '</p>');
        html += block('E · Personalisation', 'what to emphasise',
            (b.E.emphasise.length ? '<p><strong>Lead with</strong></p>' + list(b.E.emphasise.map(function (e) { return e.evidence || e.requirement; })) : '') +
            (b.E.keywordsToFeature.length ? '<p><strong>Keywords you can honestly feature</strong></p><div class="co-chips">' + b.E.keywordsToFeature.map(function (k) { return chip(k, 'ok'); }).join('') + '</div>' : '') +
            (b.E.honestGaps.length ? '<p><strong>Gaps to address honestly</strong></p>' + list(b.E.honestGaps) : '') +
            (b.E.niceToHaveGaps.length ? '<p><strong>Nice-to-have gaps</strong></p>' + list(b.E.niceToHaveGaps) : '') + '<p class="co-note">' + esc(b.E.note) + '</p>');
        html += block('F · Interview preparation', 'stories & questions', '<p><strong>Stories to prepare</strong></p>' + list(b.F.topics) + (b.F.questions.length ? '<p><strong>Likely questions</strong></p>' + list(b.F.questions) : '') + '<p><strong>Ask them</strong></p>' + list(b.F.askThem));
        html += block('G · Posting legitimacy', g.tier + ' (' + g.score + '/100)', g.signals.length ? '<ul>' + g.signals.map(function (s) {
            return '<li>' + chip(s.kind, s.kind === 'positive' ? 'ok' : s.kind === 'negative' ? 'warn' : 'bad') + ' ' + esc(s.label) + (s.detail ? ' — <em>' + esc(s.detail) + '</em>' : '') + '</li>';
        }).join('') + '</ul>' : '<p>No notable signals.</p>', g.tier !== 'High Confidence');
        if (data.liveness) html += liveHtml(data.liveness);
        document.getElementById('coResult').innerHTML = html;
    }

    function block(title, summary, body, open) {
        return '<details class="co-block"' + (open ? ' open' : '') + '><summary><span>' + esc(title) + '</span><small>' + esc(summary) + '</small></summary><div class="co-body">' + body + '</div></details>';
    }

    function liveHtml(l) {
        var kind = l.verdict === 'active' ? 'ok' : l.verdict === 'expired' ? 'bad' : 'warn';
        return '<div class="co-card"><h4>Posting status ' + chip(l.verdict, kind) + '</h4><p class="co-note">' + esc(l.reason) + ' Checked ' + esc(new Date(l.checkedAt).toLocaleString()) + '.</p></div>';
    }

    function runEvaluate(button) {
        showError('');
        var payload = jobPayload();
        busy(button, true, 'Evaluating…');
        return call(API + '/evaluate', { method: 'POST', body: payload }).then(function (data) {
            state.evaluation = data;
            if (data.jobId && !state.jobId && payload.save) { state.jobId = data.jobId; state.extra = { id: data.jobId, label: data.job.title + (data.job.company ? ' — ' + data.job.company : '') }; }
            renderEvaluate();
        }).catch(function (e) { showError(e.message); }).then(function () { busy(button, false); });
    }

    /* ---------- Resume tab ---------- */
    function renderResume() {
        panel.innerHTML = '<p class="hint">Your tailored resume is built only from your own uploaded resume and saved profile. Relevant lines move up, lower-relevance lines are trimmed, and a fact check proves every line traces back to your source. Missing keywords are reported, never added.</p>' +
            '<label for="coJob">Job</label><select id="coJob">' + jobOptions() + '</select>' +
            '<div id="coPasteWrap">' + (state.jobId ? '' : pasteFields()) + '</div>' +
            '<div class="co-grid" style="margin-top:14px"><div><label for="coTarget">Target ATS score</label><input type="number" id="coTarget" min="50" max="100" value="' + esc(state.target) + '"></div></div>' +
            aiBox() +
            '<div class="co-row"><button type="button" class="btn btn-primary" id="coBuildBtn">Build &amp; optimise to target</button>' +
            (state.ai && state.ai.configured ? '<button type="button" class="btn btn-ghost" id="coPreviewAi">Preview AI wording</button>' : '') + '</div>' +
            '<p class="co-note">The builder keeps improving the resume — structure, skills you already have, the most relevant bullets, and optional AI wording — until it reaches the target or the honest maximum for this job. It never adds a skill you do not have.</p>' +
            '<div class="co-error" id="coError" role="alert" hidden></div><div id="coSuggest"></div><div id="coResumeOut"></div>';
        document.getElementById('coJob').value = state.jobId;
        if (state.suggestions) renderSuggestions();
        if (state.resume) renderResumeOut(state.resume);
    }

    function aiBox() {
        if (!state.ai) return '';
        if (!state.ai.configured) return '<p class="co-note">AI wording is off. The server administrator can enable it by setting <code>CAREEROPS_AI_KEY</code>. Everything else works without it.</p>';
        return '<label class="co-check"><input type="checkbox" id="coAiConsent"' + (state.aiConsent ? ' checked' : '') + '> Let AI reword my bullets to fit this job. This sends my resume bullets and the job description to the AI provider. Every change is checked against hard rules: no new numbers, tools, titles, credentials, leadership or authorship.</label>';
    }

    function renderSuggestions() {
        var holder = document.getElementById('coSuggest');
        if (!holder || !state.suggestions) return;
        var items = state.suggestions;
        var improved = items.filter(function (s) { return s.status === 'improved'; });
        var html = '<div class="co-card"><h4>AI wording suggestions</h4><p class="co-note">' + improved.length + ' of ' + items.length + ' bullets can be improved within the rules. Untick any you do not want. Rejected suggestions keep your original line.</p>';
        items.forEach(function (s, i) {
            if (s.status === 'improved') {
                html += '<div class="co-req" style="grid-template-columns:auto 1fr"><input type="checkbox" data-sug="' + i + '" checked aria-label="Use this wording"><div><div class="co-evidence">Before: ' + esc(s.original) + '</div><div>After: <strong>' + esc(s.suggested) + '</strong></div></div></div>';
            } else if (s.status === 'rejected') {
                html += '<div class="co-req"><span class="co-chip bad">Rejected</span><div>' + esc(s.original) + '<div class="co-evidence">' + esc(s.reasons.join(' ')) + '</div></div></div>';
            }
        });
        html += '<div class="co-row"><button type="button" class="btn btn-primary btn-small" id="coRebuildWording">Rebuild with selected wording</button></div></div>';
        holder.innerHTML = html;
    }

    function atsHtml(a) {
        var kind = a.reached ? 'good' : a.score >= 75 ? 'mid' : 'low';
        var rows = a.breakdown.map(function (b) { return '<tr><td>' + esc(b.group) + '</td><td class="wrap">' + esc(b.label) + '</td><td>' + b.points + ' / ' + b.max + '</td><td class="wrap">' + esc(b.detail) + '</td></tr>'; }).join('');
        var out = '<div class="co-hero"><div class="co-score ' + kind + '"><strong>' + a.score + '</strong><span>ATS est. · target ' + a.target + '</span></div><div class="co-verdict"><h3>' +
            (a.reached ? 'Target reached' : 'Below target — honest maximum ≈ ' + a.ceiling) + '</h3><p>' + esc(a.explanation) + '</p><div class="co-chips">' +
            a.rounds.map(function (r) { return chip(r.score + ' · ' + r.label, r.score >= a.target ? 'ok' : ''); }).join('') + (a.aiUsed ? chip('AI wording used', 'brand') : '') + '</div>' +
            (a.aiError ? '<p class="co-note">AI step skipped: ' + esc(a.aiError) + '</p>' : '') + '</div></div>';
        if (a.issues.length) {
            out += block('What is holding the score back', a.issues.length + ' item(s)', '<ul>' + a.issues.map(function (i) {
                return '<li>' + chip(i.severity, i.severity === 'high' ? 'bad' : i.severity === 'medium' ? 'warn' : '') + ' ' + esc(i.text) + '<br><em>' + esc(i.fix) + '</em></li>';
            }).join('') + '</ul>', !a.reached);
        }
        out += block('Score breakdown', a.score + ' / 100', '<div class="co-tablewrap"><table class="co-table"><thead><tr><th>Area</th><th>Check</th><th>Points</th><th>Detail</th></tr></thead><tbody>' + rows + '</tbody></table></div><p class="co-note">' + esc(a.note) + '</p>');
        return out;
    }

    // Ask, never assume: skills the job wants but the resume does not show are listed unticked, and only
    // the ones the person ticks are added (to Skills only) before rebuilding.
    function skillsAskHtml(r) {
        var missing = (r.ats && r.ats.keywords && r.ats.keywords.missing) || [];
        var done = r.confirmedSkills || [];
        var out = '';
        if (r.rememberedUsed && r.rememberedUsed.length) out += '<div class="co-card"><h4>Used from skills you confirmed earlier</h4><div class="co-chips">' + r.rememberedUsed.map(function (s) { return chip(s, 'ok'); }).join('') + '</div><p class="co-note">Career Ops remembered these from other jobs and added them to Skills because this job asks for them. You can review or remove them under Profile &amp; resume.</p></div>';
        if (done.length) out += '<div class="co-card"><h4>Skills you confirmed</h4><div class="co-chips">' + done.map(function (s) { return chip(s, 'ok'); }).join('') + '</div><p class="co-note">Added to the Skills section at your request. They are not added to your job history.</p></div>';
        if (!missing.length) return out;
        out += '<div class="co-card" id="coSkillsAsk"><h4>Do you have any of these skills?</h4>' +
            '<p>This job asks for skills your resume does not show. If you genuinely have some of them, tick them and Career Ops will add them to your Skills section and rebuild, which can raise your ATS score.</p>' +
            '<div class="co-chips" style="margin:8px 0">' + missing.map(function (term) {
                return '<label class="co-check co-skillpick"><input type="checkbox" data-skill="' + esc(term) + '"> ' + esc(term) + '</label>';
            }).join('') + '</div>' +
            '<p class="co-note">Only tick a skill you could talk about in an interview. Career Ops remembers what you tick and reuses it for every later job that asks for it. Your answer is treated as your own statement; Career Ops never ticks anything for you and never writes these into your job history.</p>' +
            '<div class="co-row"><button type="button" class="btn btn-primary" id="coConfirmSkills">Add ticked skills &amp; rebuild</button></div></div>';
        return out;
    }

    function renderResumeOut(r) {
        var ok = r.factCheck.ok;
        var html = atsHtml(r.ats) + skillsAskHtml(r) + '<div class="co-hero"><div class="co-score ' + scoreClass(r.score) + '"><strong>' + r.score.toFixed(1) + '</strong><span>job fit</span></div><div class="co-verdict"><h3>' + esc(r.verdict.label) + '</h3><p>' + esc(r.verdict.text) + '</p>' +
            '<div class="co-chips">' + chip(ok ? 'Fact check passed' : 'Fact check failed', ok ? 'ok' : 'bad') + (r.coverage != null ? chip('CV match ' + r.coverage + '%', r.coverage >= 95 ? 'ok' : 'warn') : '') + (r.keywords.featured.length ? chip('Featured: ' + r.keywords.featured.join(', '), 'brand') : '') + '</div></div></div>';
        if (!ok) html += '<div class="co-card"><h4>Lines not found in your source resume</h4>' + list(r.factCheck.unsupported.map(function (u) { return u.where + ': ' + u.line; })) + '</div>';
        if (r.warnings.length) html += '<div class="co-card"><h4>Notes</h4>' + list(r.warnings) + '</div>';
        if (r.changes.length) html += '<div class="co-card"><h4>What changed from your source resume</h4>' + list(r.changes) + '</div>';
        if (r.appliedRewrites && r.appliedRewrites.length) {
            html += '<div class="co-card"><h4>Reworded bullets (' + r.appliedRewrites.length + ')</h4>' + r.appliedRewrites.map(function (w) {
                return '<div class="co-req" style="grid-template-columns:1fr"><div class="co-evidence">Before: ' + esc(w.original) + '</div><div>After: <strong>' + esc(w.suggested) + '</strong></div></div>';
            }).join('') + '<p class="co-note">Each change was re-checked on the server: no new numbers, tools, titles, credentials, leadership or authorship.</p></div>';
        }
        html += '<div class="co-card"><h4>Tailored resume</h4><div class="co-row" style="margin-top:6px">' +
            '<button type="button" class="btn btn-ghost btn-small" id="coCopyResume">Copy</button>' +
            '<button type="button" class="btn btn-ghost btn-small" id="coDownloadHtml">Download HTML</button>' +
            (r.jobId ? '<a class="btn btn-primary btn-small" target="_blank" rel="noopener" href="' + API + '/resume/' + encodeURIComponent(r.jobId) + '/html">Open print-ready (Save as PDF)</a>' : '') +
            '</div><textarea id="coResumeText" readonly rows="16"></textarea><p class="co-note">Single column, standard headings, no tables or graphics — parsed cleanly by applicant tracking systems.</p></div>';
        html += '<div class="co-card"><h4>Cover letter draft</h4><p class="co-note">' + esc(r.coverLetter.draftNotice) + '</p><div class="co-row" style="margin-top:6px"><button type="button" class="btn btn-ghost btn-small" id="coCopyCover">Copy</button></div><textarea id="coCoverText" rows="14"></textarea></div>' +
            '<div class="co-row"><button type="button" class="btn btn-primary" id="coGoApply">Next: apply to this job &rarr;</button></div>';
        document.getElementById('coResumeOut').innerHTML = html;
        document.getElementById('coResumeText').value = r.resume.markdown;
        document.getElementById('coCoverText').value = r.coverLetter.text;
    }

    function readBuildOptions() {
        var target = document.getElementById('coTarget');
        var consent = document.getElementById('coAiConsent');
        if (target) state.target = Math.min(100, Math.max(50, Number(target.value) || 90));
        if (consent) state.aiConsent = consent.checked;
    }

    function acceptedRewrites() {
        if (!state.suggestions) return [];
        var boxes = panel.querySelectorAll('input[data-sug]');
        var out = [];
        boxes.forEach(function (box) {
            var s = state.suggestions[Number(box.dataset.sug)];
            if (box.checked && s && s.status === 'improved') out.push({ original: s.original, suggested: s.suggested });
        });
        return out;
    }

    function runBuild(button, withWording) {
        showError('');
        readBuildOptions();
        var payload = jobPayload();
        payload.targetScore = state.target;
        payload.aiConsent = state.aiConsent;
        if (state.confirmed.length) { payload.confirmedSkills = state.confirmed; }
        if (withWording) payload.rewrites = acceptedRewrites();
        busy(button, true, 'Optimising…');
        return call(API + '/resume', { method: 'POST', body: payload }).then(function (data) {
            state.resume = data;
            if (data.jobId && !state.jobId) { state.jobId = data.jobId; }
            renderResume();
        }).catch(function (e) { showError(e.message); }).then(function () { busy(button, false); });
    }

    /* ---------- Apply & track: one job, start to finish ---------- */
    function safeUrl(url) { return /^https?:\/\//i.test(String(url || '')) ? String(url) : ''; }
    function flaggedEvaluation(ev) { return !!(ev.blockers.length || ev.legitimacy.tier === 'Suspicious' || ev.verdict.action !== 'apply' || ev.score < 4); }

    function renderApply() {
        panel.innerHTML =
            '<p class="hint">Apply to one job from start to finish: check the fit, prepare a fact-checked resume and cover letter, start the application, apply on the employer\'s site, and track it. Nothing is ever sent for you.</p>' +
            '<label for="coJob">Job</label><select id="coJob">' + jobOptions() + '</select>' +
            '<div id="coPasteWrap">' + (state.jobId ? '' : pasteFields()) + '</div>' +
            '<div class="co-row"><button type="button" class="btn btn-primary" id="coStartBtn">Start application</button></div>' +
            '<p class="co-note">Starting runs the Career Ops check first. A pasted job needs the https link to its posting so you can open the employer page.</p>' +
            '<div class="co-error" id="coError" role="alert" hidden></div><div id="coApplyOut"></div>';
        document.getElementById('coJob').value = state.jobId;
        if (state.application) renderApplyOut(state.application);
    }

    function renderApplyWarning(ev) {
        var tierKind = ev.legitimacy.tier === 'High Confidence' ? 'ok' : ev.legitimacy.tier === 'Suspicious' ? 'bad' : 'warn';
        document.getElementById('coApplyOut').innerHTML = '<div class="co-card"><h4>Check before you apply</h4>' +
            '<div class="co-chips">' + chip(ev.score.toFixed(1) + '/5 · ' + ev.verdict.label, scoreClass(ev.score) === 'good' ? 'ok' : scoreClass(ev.score) === 'mid' ? 'warn' : 'bad') + chip(ev.legitimacy.tier, tierKind) + '</div>' +
            '<p>' + esc(ev.blockers[0] || ev.verdict.text) + '</p><p class="co-note">Fewer, better-fit applications work better. Career Ops recommends applying only at 4.0/5 or above.</p>' +
            '<div class="co-row"><button type="button" class="btn btn-ghost" id="coApplyBack">Back</button><button type="button" class="btn btn-primary" id="coStartAnyway">Start anyway</button></div></div>';
    }

    function renderApplyOut(r) {
        var app = r.application, id = Number(app.id), url = safeUrl(r.applyUrl);
        document.getElementById('coApplyOut').innerHTML = '<div class="co-card"><h4>Application started — ready for your review</h4>' +
            '<div class="co-chips">' + chip('Job fit ' + r.summary.score.toFixed(1) + '/5 · ' + r.summary.verdict, r.summary.score >= 4 ? 'ok' : 'warn') + chip('ATS ' + r.ats.score + '/100', r.ats.reached ? 'ok' : 'warn') + chip('Fact check passed', 'ok') + '</div>' +
            (r.ats.reached ? '' : '<p class="co-note">' + esc(r.ats.explanation) + '</p>') +
            '<ol class="co-steps-list">' +
            '<li><strong>Review</strong> your documents: <a href="' + API + '/resume/' + encodeURIComponent(app.job_id) + '/html" target="_blank" rel="noopener">print-ready resume</a> · <a href="/api/jobs/applications/' + id + '/resume">resume (.md)</a> · <a href="/api/jobs/applications/' + id + '/cover-letter">cover letter (.md)</a>. Adjust them in step 2 if you want changes.</li>' +
            '<li><strong>Apply</strong> on the employer\'s site: ' + (url ? '<a class="btn btn-primary btn-small" target="_blank" rel="noopener noreferrer" href="' + esc(url) + '">Open employer application</a>' : '<span class="co-note">No link available for this posting.</span>') + '</li>' +
            '<li id="coTrackStep"><strong>Track</strong> it: once you have submitted, press <button type="button" class="btn btn-ghost btn-small" id="coMarkApplied" data-app="' + id + '">I applied</button>. A follow-up reminder appears in a week.</li>' +
            '</ol></div>';
    }

    function startApplication(button, force) {
        showError('');
        var payload = jobPayload();
        var out = document.getElementById('coApplyOut');
        if (out) out.innerHTML = '';
        busy(button, true, 'Checking…');
        var check = force ? Promise.resolve(null) : call(API + '/evaluate', { method: 'POST', body: Object.assign({}, payload, { save: false }) });
        return check.then(function (data) {
            if (data && flaggedEvaluation(data.evaluation)) { renderApplyWarning(data.evaluation); return null; }
            button.textContent = 'Preparing…';
            return call(API + '/apply', { method: 'POST', body: payload });
        }).then(function (result) {
            if (!result) return;
            state.application = result;
            if (!state.jobId && result.application.job_id) {
                state.jobId = result.application.job_id;
                state.extra = { id: state.jobId, label: (state.draft.title || 'Job') + (state.draft.company ? ' — ' + state.draft.company : '') };
            }
            renderApply();
        }).catch(function (error) {
            var existing = error.data && error.data.application;
            showError(existing ? error.message + ' Open the Applications section to continue it.' : error.message);
        }).then(function () { busy(button, false); });
    }

    function markApplied(button) {
        busy(button, true, 'Saving…');
        call('/api/jobs/applications/' + encodeURIComponent(button.dataset.app) + '/applied', { method: 'POST' }).then(function () {
            document.getElementById('coTrackStep').innerHTML = '<strong>Tracked.</strong> ' + chip('Applied', 'ok') + ' It moved to Applied jobs, and Career Ops will remind you to follow up in a week. <a href="#applications" data-co-goto="applications">View in Applications</a>';
        }).catch(function (error) { busy(button, false); showError(error.message); });
    }

    /* ---------- Pipeline tab ---------- */
    var STATE_KIND = { Evaluated: '', Applied: 'brand', Responded: 'ok', Assessment: 'warn', Interview: 'ok', Offer: 'ok', Hired: 'ok', Rejected: 'bad', Discarded: 'bad', SKIP: '' };

    function renderPipeline() {
        panel.innerHTML = '<div class="co-empty">Loading your pipeline…</div>';
        call(API + '/pipeline').then(function (data) {
            state.pipeline = data.pipeline;
            var html = '<h3 style="margin:6px 0 0;font-size:15px">Follow-up actions</h3><p class="co-note">One polite follow-up after a week, one more a week later, then stop. Drafts are yours to edit and send — nothing is sent for you.</p>';
            html += data.actions.length ? data.actions.map(function (row, i) {
                var n = row.next;
                return '<div class="co-card"><div class="co-urgency ' + esc(n.urgency) + '">' + esc(n.urgency) + (n.dueAt ? ' · ' + esc(new Date(n.dueAt).toLocaleDateString()) : '') + '</div>' +
                    '<h4>' + esc(row.title) + (row.company ? ' — ' + esc(row.company) : '') + '</h4><p class="co-note">' + esc(n.reason) + '</p>' +
                    (n.draft ? '<textarea rows="8" data-draft="' + i + '"></textarea><div class="co-row"><button type="button" class="btn btn-ghost btn-small" data-co-copy="' + i + '">Copy draft</button>' +
                        '<button type="button" class="btn btn-primary btn-small" data-co-sent="' + esc(row.jobId) + '">I sent a follow-up</button></div>' : '') + '</div>';
            }).join('') : '<div class="co-empty">Nothing is due. Applied jobs will appear here when a follow-up is needed.</div>';
            html += '<h3 style="margin:22px 0 0;font-size:15px">Pipeline</h3><div class="co-tablewrap"><table class="co-table"><thead><tr><th>Job</th><th>State</th><th>Score</th><th>Legitimacy</th></tr></thead><tbody>' +
                (data.pipeline.length ? data.pipeline.map(function (r) {
                    return '<tr><td class="wrap">' + esc(r.title) + (r.company ? '<br><small style="color:var(--text-faint)">' + esc(r.company) + '</small>' : '') + '</td><td>' + chip(r.state, STATE_KIND[r.state]) + '</td><td>' +
                        (r.score != null ? r.score.toFixed(1) : '—') + '</td><td>' + esc(r.legitimacyTier || '—') + '</td></tr>';
                }).join('') : '<tr><td colspan="4" class="co-empty">Evaluate or save a job to start your pipeline.</td></tr>') + '</tbody></table></div>';
            panel.innerHTML = html;
            panel.querySelectorAll('textarea[data-draft]').forEach(function (area) { area.value = data.actions[Number(area.dataset.draft)].next.draft; });
        }).catch(function (e) { panel.innerHTML = '<div class="co-error">' + esc(e.message) + '</div>'; });
    }

    /* ---------- Insights tab ---------- */
    function renderInsights() {
        panel.innerHTML = '<div class="co-empty">Analysing your pipeline…</div>';
        call(API + '/patterns').then(function (data) {
            var p = data.patterns, f = p.funnel, c = p.conversion;
            var pct = function (n) { return n == null ? '—' : n + '%'; };
            var html = '<div class="co-stats">' + [['Evaluated', f.evaluated], ['Applied', f.applied], ['Responded', f.responded], ['Interviewing', f.interviewing], ['Offers', f.offers]].map(function (s) {
                return '<div class="co-stat"><strong>' + s[1] + '</strong><span>' + s[0] + '</span></div>';
            }).join('') + '</div><div class="co-chips">' + chip('Response rate ' + pct(c.responseRate), 'brand') + chip('Interview rate ' + pct(c.interviewRate), 'brand') + chip('Offer rate ' + pct(c.offerRate), 'brand') + '</div>';
            html += '<div class="co-card"><h4>What the data says</h4>' + list(p.insights) + '</div>';
            var table = function (title, rows) {
                if (!rows.length) return '';
                return '<h3 style="margin:20px 0 0;font-size:15px">' + esc(title) + '</h3><div class="co-tablewrap"><table class="co-table"><thead><tr><th>Group</th><th>Applied</th><th>Advanced</th><th>Rate</th></tr></thead><tbody>' +
                    rows.map(function (r) { return '<tr><td>' + esc(r.key) + '</td><td>' + r.applied + '</td><td>' + r.advanced + '</td><td>' + pct(r.advanceRate) + (r.reliable ? '' : ' <small style="color:var(--text-faint)">(small sample)</small>') + '</td></tr>'; }).join('') + '</tbody></table></div>';
            };
            html += table('By fit score', p.byScoreBand) + table('By role type', p.byArchetype) + table('By source', p.bySource);
            if (p.topGaps.length) html += '<div class="co-card"><h4>Skills that keep showing up as missing</h4><div class="co-chips">' + p.topGaps.map(function (g) { return chip(g.term + ' ×' + g.count, 'warn'); }).join('') + '</div></div>';
            html += '<p class="co-note">' + esc(p.sampleNote) + '</p>';
            panel.innerHTML = html;
        }).catch(function (e) { panel.innerHTML = '<div class="co-error">' + esc(e.message) + '</div>'; });
    }

    /* ---------- Wiring ---------- */
    function setTab(tab) {
        readDraft();
        state.tab = tab;
        tabs.querySelectorAll('[data-co-tab]').forEach(function (b) { b.classList.toggle('active', b.dataset.coTab === tab); });
        if (tab === 'evaluate') renderEvaluate();
        else if (tab === 'resume') renderResume();
        else if (tab === 'apply') renderApply();
        else if (tab === 'pipeline') renderPipeline();
        else renderInsights();
    }

    function loadJobs() {
        return Promise.all([
            call('/api/jobs/saved').then(function (d) { state.savedJobs = d.jobs || []; }).catch(function () {}),
            call(API + '/pipeline').then(function (d) { state.pipeline = d.pipeline || []; }).catch(function () {}),
        ]);
    }

    function start() {
        if (state.started) return;
        state.started = true;
        call(API + '/ai').then(function (d) { state.ai = d; }).catch(function () { state.ai = { configured: false }; })
            .then(loadJobs).then(function () { setTab(state.tab); });
    }

    tabs.addEventListener('click', function (event) {
        var b = event.target.closest('[data-co-tab]');
        if (b) setTab(b.dataset.coTab);
    });

    panel.addEventListener('change', function (event) {
        if (event.target.id !== 'coJob') return;
        readDraft();
        state.jobId = event.target.value;
        state.evaluation = null; state.resume = null; state.application = null; state.confirmed = [];
        if (state.tab === 'resume') renderResume(); else if (state.tab === 'apply') renderApply(); else renderEvaluate();
    });

    panel.addEventListener('click', function (event) {
        var t = event.target.closest('button');
        if (!t) return;
        if (t.id === 'coEvalBtn') runEvaluate(t);
        else if (t.id === 'coResumeBtn') { readDraft(); setTab('resume'); }
        else if (t.id === 'coStartBtn') startApplication(t, false);
        else if (t.id === 'coStartAnyway') startApplication(document.getElementById('coStartBtn'), true);
        else if (t.id === 'coApplyBack') { var holder = document.getElementById('coApplyOut'); if (holder) holder.innerHTML = ''; }
        else if (t.id === 'coMarkApplied') markApplied(t);
        else if (t.id === 'coGoApply') { readDraft(); setTab('apply'); }
        else if (t.id === 'coBuildBtn') runBuild(t, false);
        else if (t.id === 'coConfirmSkills') {
            var ticked = [].slice.call(panel.querySelectorAll('input[data-skill]:checked')).map(function (box) { return box.dataset.skill; });
            if (!ticked.length) { showError('Tick at least one skill you genuinely have, or leave the list as it is.'); return; }
            ticked.forEach(function (skill) { if (state.confirmed.indexOf(skill) < 0) state.confirmed.push(skill); });
            runBuild(t, false);
        }
        else if (t.id === 'coRebuildWording') runBuild(t, true);
        else if (t.id === 'coPreviewAi') {
            readBuildOptions(); showError('');
            if (!state.aiConsent) { showError('Tick the box to confirm you agree to send your resume bullets and this job description to the AI provider.'); return; }
            var body = jobPayload(); body.consent = true;
            busy(t, true, 'Asking AI…');
            call(API + '/rewrite', { method: 'POST', body: body }).then(function (d) { state.suggestions = d.suggestions; renderSuggestions(); })
                .catch(function (e) { showError(e.message); }).then(function () { busy(t, false); });
        }
        else if (t.id === 'coLiveBtn') {
            busy(t, true, 'Checking…'); showError('');
            call(API + '/liveness', { method: 'POST', body: { jobId: state.jobId } }).then(function (d) {
                var holder = document.getElementById('coResult');
                if (holder) holder.insertAdjacentHTML('afterbegin', liveHtml(d.liveness));
            }).catch(function (e) { showError(e.message); }).then(function () { busy(t, false); });
        }
        else if (t.id === 'coCopyResume') copy(document.getElementById('coResumeText').value, t);
        else if (t.id === 'coCopyCover') copy(document.getElementById('coCoverText').value, t);
        else if (t.id === 'coDownloadHtml' && state.resume) {
            var url = URL.createObjectURL(new Blob([state.resume.resume.html], { type: 'text/html' }));
            var a = document.createElement('a'); a.href = url; a.download = 'tailored-resume.html'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }
        else if (t.dataset.coCopy !== undefined) copy(panel.querySelector('textarea[data-draft="' + t.dataset.coCopy + '"]').value, t);
        else if (t.dataset.coSent) {
            busy(t, true, 'Saving…');
            call(API + '/followups', { method: 'POST', body: { jobId: t.dataset.coSent } }).then(renderPipeline).catch(function () { busy(t, false); });
        }
    });

    // Jump straight from a match card to a full evaluation.
    document.addEventListener('click', function (event) {
        var b = event.target.closest('[data-co-evaluate]');
        if (!b) return;
        var cardEl = b.closest('.job-card') || b.closest('article') || b.parentElement;
        var heading = cardEl && cardEl.querySelector('h3, h2, .job-title');
        state.jobId = b.dataset.coEvaluate;
        state.extra = { id: state.jobId, label: b.dataset.coLabel || (heading ? heading.textContent.trim() : 'Selected job') };
        var openResume = b.dataset.coOpen === 'resume';
        state.evaluation = null; state.resume = null; state.confirmed = []; state.tab = openResume ? 'resume' : 'evaluate';
        var nav = document.querySelector('[data-workspace-target="careerops"]');
        if (nav) nav.click();
        state.started = true;
        call(API + '/ai').then(function (d) { state.ai = d; }).catch(function () { state.ai = { configured: false }; })
            .then(loadJobs).then(function () {
                if (openResume) { setTab('resume'); var buildNow = document.getElementById('coBuildBtn'); if (buildNow) runBuild(buildNow, false); return; }
                setTab('evaluate'); var btn = document.getElementById('coEvalBtn'); if (btn) runEvaluate(btn);
            });
    });

    // Load lazily the first time the view is opened.
    new MutationObserver(function () { if (!card.hidden) start(); }).observe(card, { attributes: true, attributeFilter: ['hidden'] });
    if (!card.hidden) start();
})();
