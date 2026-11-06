(function () {
    'use strict';

    // "Forgot password?" on the log-in card. The server always answers the same way, so this page
    // never reveals whether a username or email has an account.
    var loginForm = document.getElementById('loginForm');
    var signupForm = document.getElementById('signupForm');
    var forgotForm = document.getElementById('forgotForm');
    var tabs = document.querySelector('.auth-tabs');
    var loginTab = document.getElementById('loginTabBtn');
    var errorEl = document.getElementById('authError');
    var successEl = document.getElementById('authSuccess');
    var submitBtn = document.getElementById('forgotSubmitBtn');
    var input = document.getElementById('forgotIdentifier');
    if (!loginForm || !forgotForm || !tabs || !loginTab) return;

    function clearMessages() {
        errorEl.style.display = 'none';
        successEl.style.display = 'none';
    }

    function showForgot() {
        clearMessages();
        loginForm.style.display = 'none';
        signupForm.style.display = 'none';
        tabs.style.display = 'none';
        forgotForm.style.display = '';
        var typed = document.getElementById('loginUsername');
        if (typed && typed.value && !input.value) input.value = typed.value.trim();
        input.focus();
    }

    function showLogin() {
        clearMessages();
        forgotForm.style.display = 'none';
        tabs.style.display = '';
        loginTab.click();
    }

    document.getElementById('forgotLinkBtn').addEventListener('click', showForgot);
    document.getElementById('forgotBackBtn').addEventListener('click', showLogin);

    forgotForm.addEventListener('submit', function (event) {
        event.preventDefault();
        clearMessages();
        var identifier = input.value.trim();
        if (!identifier) {
            errorEl.textContent = 'Enter your username or email.';
            errorEl.style.display = 'block';
            return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending…';
        fetch('/api/jobs/auth/forgot', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier: identifier }),
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (res.status === 429) throw new Error('Too many requests. Please wait a few minutes and try again.');
                if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
                successEl.textContent = data.message || 'If an account matches, a reset link has been sent.';
                successEl.style.display = 'block';
            });
        }).catch(function (error) {
            errorEl.textContent = error.message;
            errorEl.style.display = 'block';
        }).then(function () {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Send reset link';
        });
    });
})();
