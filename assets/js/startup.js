(function () {
    'use strict';

    const splashPanel = document.getElementById('splashPanel');
    const authPanel = document.getElementById('authPanel');
    const activationPanel = document.getElementById('activationPanel');
    const statusEl = document.getElementById('statusText');
    const progressEl = document.getElementById('progressBar');
    const authTitle = document.getElementById('authTitle');
    const usernameInput = document.getElementById('usernameInput');
    const passwordInput = document.getElementById('passwordInput');
    const authError = document.getElementById('authError');
    const authSubmit = document.getElementById('authSubmit');
    const authToggleText = document.getElementById('authToggleText');
    const authToggleLink = document.getElementById('authToggleLink');
    const startupHeader = document.getElementById('startupHeader');
    const startupCloseBtn = document.getElementById('startupCloseBtn');

    const activationCodeInput = document.getElementById('activationCode');
    const activationError = document.getElementById('activationError');
    const activationSubmit = document.getElementById('activationSubmit');
    const activationPurchaseLink = document.getElementById('activationPurchaseLink');
    const activationRetryLink = document.getElementById('activationRetryLink');
    const activationInputWrap = document.querySelector('.activation-input-wrap');

    const TOKEN_KEY = 'vv_access_token';
    const ACTIVATED_KEY = 'vv_activated';
    const PURCHASE_URL = 'https://lazeragent.com/purchase';

    let authMode = 'login';
    let backendUrl = '';
    let currentToken = '';

    function setStatus(text) {
        if (statusEl) statusEl.textContent = text;
    }

    function showProgress(show) {
        if (progressEl) progressEl.classList.toggle('hidden', !show);
    }

    function showSplash(show) {
        splashPanel.classList.toggle('hidden', !show);
        authPanel.classList.toggle('hidden', show);
        activationPanel.classList.add('hidden');
    }

    function showAuthForm(mode) {
        authMode = mode;
        authTitle.textContent = mode === 'login' ? '登录' : '创建账号';
        authSubmit.textContent = mode === 'login' ? '登录' : '注册';
        authToggleText.textContent = mode === 'login' ? '还没有账号？' : '已有账号？';
        authToggleLink.textContent = mode === 'login' ? '立即注册' : '立即登录';
        authError.textContent = '';
        usernameInput.value = '';
        passwordInput.value = '';
        splashPanel.classList.add('hidden');
        authPanel.classList.remove('hidden');
        activationPanel.classList.add('hidden');
        setTimeout(function () { usernameInput.focus(); }, 50);
    }

    function showActivationForm() {
        authPanel.classList.add('hidden');
        splashPanel.classList.add('hidden');
        activationPanel.classList.remove('hidden');
        activationError.textContent = '';
        activationCodeInput.value = '';
        if (activationInputWrap) activationInputWrap.classList.remove('shake');
        setTimeout(function () { activationCodeInput.focus(); }, 50);
    }

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function nativeCall(name, arg) {
        if (typeof window.native_call === 'function') {
            return window.native_call(name, arg);
        }
        return Promise.reject(new Error('native_call bridge not available'));
    }

    function trace(msg) {
        console.log('[startup]', msg);
        try {
            nativeCall('startupTrace', { msg: msg });
        } catch (e) {}
    }

    function waitForBridge(timeoutMs) {
        return new Promise(function (resolve, reject) {
            const interval = 50;
            let elapsed = 0;
            const timer = setInterval(function () {
                if (typeof window.native_call === 'function' && window.chrome && window.chrome.webview) {
                    clearInterval(timer);
                    setupMessageListener();
                    resolve();
                    return;
                }
                elapsed += interval;
                if (elapsed >= timeoutMs) {
                    clearInterval(timer);
                    reject(new Error('native_call bridge timeout'));
                }
            }, interval);
        });
    }

    function setupMessageListener() {
        if (window.__startup_message_setup) return;
        window.__startup_message_setup = true;
        window.chrome.webview.addEventListener('message', function (e) {
            const data = e.data;
            if (typeof data !== 'string') return;
            const sep = data.indexOf('|');
            if (sep === -1) return;
            const id = parseInt(data.substring(0, sep), 10);
            const result = data.substring(sep + 1);
            if (typeof window.__largui_resolve === 'function') {
                window.__largui_resolve(id, true, result);
            }
        });
    }

    async function resolveBackendUrl() {
        try {
            const raw = await nativeCall('getBackendBaseUrl');
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            backendUrl = (parsed && parsed.url) ? parsed.url : 'http://127.0.0.1:18080';
        } catch (e) {
            backendUrl = 'http://127.0.0.1:18080';
        }
        trace('backend url: ' + backendUrl);
    }

    function api(path) {
        return backendUrl.replace(/\/$/, '') + path;
    }

    async function postJson(path, body, token) {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const res = await fetch(api(path), {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
            throw new Error(data.detail || ('Request failed: ' + res.status));
        }
        return data;
    }

    async function getJson(path, token) {
        const res = await fetch(api(path), {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + token },
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
            throw new Error(data.detail || ('Request failed: ' + res.status));
        }
        return data;
    }

    async function checkUpdate() {
        trace('checkUpdate start');
        try {
            setStatus('正在检查更新…');
            showProgress(true);

            const raw = await nativeCall('checkUpdate');
            trace('checkUpdate raw: ' + raw);
            let result = raw;
            if (typeof raw === 'string') {
                try { result = JSON.parse(raw); } catch (e) {}
            }

            if (!result || !result.update_available) {
                trace('no update, will check auth');
                setStatus('已是最新版本');
                await delay(300);
                await checkAuth();
                return;
            }

            trace('update available: ' + result.latest_version);
            setStatus('发现新版本 ' + result.latest_version + '，正在下载…');
            showProgress(true);
            const applyResult = await nativeCall('applyUpdate', {
                download_url: result.download_url,
                latest_version: result.latest_version
            });
            trace('applyUpdate returned: ' + applyResult);
        } catch (err) {
            console.error('[startup] update check failed:', err);
            trace('update error: ' + err.message);
            setStatus('更新检查失败');
            showProgress(false);
            await delay(500);
            await checkAuth();
        }
    }

    async function checkAuth() {
        trace('checkAuth start');
        const token = localStorage.getItem(TOKEN_KEY);
        if (token) {
            try {
                const me = await getJson('/api/auth/me', token);
                trace('token valid, proceeding');
                if (me && me.username) {
                    localStorage.setItem('vv_username', me.username);
                }
                await afterAuthSuccess(token, me);
                return;
            } catch (e) {
                trace('token invalid: ' + e.message);
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(ACTIVATED_KEY);
                localStorage.removeItem('vv_username');
            }
        } else {
            trace('no token, showing auth form');
        }
        showAuthForm('login');
    }

    async function afterAuthSuccess(token, user) {
        currentToken = token;
        if (user && user.is_activated) {
            localStorage.setItem(TOKEN_KEY, token);
            localStorage.setItem(ACTIVATED_KEY, 'true');
            setStatus('欢迎回来');
            showProgress(false);
            await delay(300);
            await nativeCall('startupReady');
            return;
        }
        localStorage.setItem(TOKEN_KEY, token);
        localStorage.removeItem(ACTIVATED_KEY);
        showActivationForm();
    }

    function setLoading(loading) {
        authSubmit.disabled = loading;
        usernameInput.disabled = loading;
        passwordInput.disabled = loading;
        authToggleLink.style.pointerEvents = loading ? 'none' : 'auto';
    }

    function setActivationLoading(loading) {
        activationSubmit.disabled = loading;
        activationCodeInput.disabled = loading;
    }

    async function submitAuth() {
        const username = usernameInput.value.trim();
        const password = passwordInput.value;
        if (!username || !password) {
            authError.textContent = '请输入用户名和密码';
            return;
        }

        setLoading(true);
        authError.textContent = '';

        try {
            const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
            const data = await postJson(endpoint, { username: username, password: password });
            if (!data.access_token) {
                throw new Error('未收到登录令牌');
            }
            trace('auth success, user=' + (data.user && data.user.username));
            setLoading(false);
            await afterAuthSuccess(data.access_token, data.user);
        } catch (err) {
            trace('auth error: ' + err.message);
            authError.textContent = err.message || '登录失败';
            setLoading(false);
        }
    }

    function formatActivationCode(value) {
        let cleaned = value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
        let alnum = cleaned.replace(/-/g, '').slice(0, 16);
        const parts = [];
        for (let i = 0; i < alnum.length; i += 4) {
            parts.push(alnum.slice(i, i + 4));
        }
        return parts.join('-');
    }

    function onActivationInput(e) {
        const start = e.target.selectionStart;
        const previous = e.target.value;
        const formatted = formatActivationCode(previous);
        e.target.value = formatted;
        // Keep cursor at the logical position relative to what the user typed.
        const beforeCursor = previous.slice(0, start);
        const formattedBefore = formatActivationCode(beforeCursor);
        const newPos = Math.min(formattedBefore.length, formatted.length);
        e.target.setSelectionRange(newPos, newPos);
    }

    function showActivationError(msg) {
        activationError.textContent = msg;
        if (activationInputWrap) {
            activationInputWrap.classList.remove('shake');
            void activationInputWrap.offsetWidth; // trigger reflow
            activationInputWrap.classList.add('shake');
        }
    }

    async function submitActivation() {
        const raw = activationCodeInput.value.trim();
        if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(raw)) {
            showActivationError('请输入完整的激活码');
            return;
        }

        setActivationLoading(true);
        activationError.textContent = '';
        if (activationInputWrap) activationInputWrap.classList.remove('shake');

        try {
            const data = await postJson('/api/auth/activate', { code: raw }, currentToken);
            if (!data.access_token) {
                throw new Error('激活成功但未收到令牌');
            }
            localStorage.setItem(TOKEN_KEY, data.access_token);
            localStorage.setItem(ACTIVATED_KEY, 'true');
            setActivationLoading(false);
            showSplash(true);
            setStatus('激活成功，正在启动…');
            showProgress(false);
            await delay(500);
            await nativeCall('startupReady');
        } catch (err) {
            trace('activation error: ' + err.message);
            showActivationError(err.message || '激活失败');
            setActivationLoading(false);
        }
    }

    function setupAuthEvents() {
        authSubmit.addEventListener('click', function (e) {
            e.preventDefault();
            submitAuth();
        });

        authToggleLink.addEventListener('click', function (e) {
            e.preventDefault();
            showAuthForm(authMode === 'login' ? 'register' : 'login');
        });

        passwordInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitAuth();
            }
        });

        if (startupCloseBtn) {
            startupCloseBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                nativeCall('close').catch(function () {});
            });
        }

        if (startupHeader) {
            startupHeader.addEventListener('mousedown', function (e) {
                if (e.target === startupCloseBtn || startupCloseBtn.contains(e.target)) return;
                nativeCall('startDrag').catch(function () {});
            });
        }
    }

    function setupActivationEvents() {
        if (!activationCodeInput) return;

        activationCodeInput.addEventListener('input', onActivationInput);
        activationCodeInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                submitActivation();
            }
        });

        activationSubmit.addEventListener('click', function (e) {
            e.preventDefault();
            submitActivation();
        });

        if (activationPurchaseLink) {
            activationPurchaseLink.addEventListener('click', function (e) {
                e.preventDefault();
                nativeCall('openUrl', { url: PURCHASE_URL }).catch(function () {});
            });
        }

        if (activationRetryLink) {
            activationRetryLink.addEventListener('click', function (e) {
                e.preventDefault();
                currentToken = '';
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(ACTIVATED_KEY);
                showAuthForm('login');
            });
        }
    }

    async function start() {
        trace('bridge waiting');
        setupAuthEvents();
        setupActivationEvents();
        try {
            await waitForBridge(3000);
            trace('bridge ready');
            await resolveBackendUrl();
            await checkUpdate();
        } catch (err) {
            console.error('[startup] bridge wait failed:', err);
            trace('bridge error: ' + err.message);
            try { await nativeCall('startupReady'); } catch (e) {}
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
