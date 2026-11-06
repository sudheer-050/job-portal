(function () {
    'use strict';

    // The reset token lives in the URL fragment, so it is never sent to a server or written to an access log.
    // Read it once, then remove it from the address bar and history.
    var token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    try { history.replaceState(null, '', location.pathname); } catch (_) { /* non-critical */ }

    var form = document.getElementById('resetForm');
    var errorEl = document.getElementById('resetError');
    var doneEl = document.getElementById('resetDone');
    var button = document.getElementById('resetBtn');

    function showError(message) { errorEl.textContent = message; errorEl.style.display = message ? 'block' : 'none'; }

    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        form.style.display = 'none';
        showError('This reset link is missing or incomplete. Request a new one from the log-in page.');
        return;
    }

    form.addEventListener('submit', function (event) {
        event.preventDefault();
        showError('');
        var password = document.getElementById('newPassword').value;
        var confirm = document.getElementById('confirmPassword').value;
        if (password.length < 8) return showError('Password must be at least 8 characters.');
        if (password !== confirm) return showError('The two passwords do not match.');
        button.disabled = true;
        button.textContent = 'Updating…';
        fetch('/api/jobs/auth/reset', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token, password: password }),
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
                token = '';
                form.style.display = 'none';
                doneEl.style.display = 'block';
            });
        }).catch(function (error) {
            showError(error.message);
            button.disabled = false;
            button.textContent = 'Update password';
        });
    });
})();
