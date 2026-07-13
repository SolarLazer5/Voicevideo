(function () {
    'use strict';

    const ADMIN_KEY_STORAGE = 'vv_admin_key';

    const keySection = document.getElementById('keySection');
    const mainSection = document.getElementById('mainSection');
    const adminKeyInput = document.getElementById('adminKeyInput');
    const keySubmit = document.getElementById('keySubmit');
    const keyError = document.getElementById('keyError');

    const codeTypeRadios = document.querySelectorAll('input[name="codeType"]');
    const trialDaysRow = document.getElementById('trialDaysRow');
    const trialDaysInput = document.getElementById('trialDaysInput');
    const countInput = document.getElementById('countInput');
    const remarkInput = document.getElementById('remarkInput');
    const generateBtn = document.getElementById('generateBtn');
    const formError = document.getElementById('formError');

    const resultArea = document.getElementById('resultArea');
    const resultList = document.getElementById('resultList');
    const copyAllBtn = document.getElementById('copyAllBtn');
    const exportCsvBtn = document.getElementById('exportCsvBtn');
    const recentList = document.getElementById('recentList');

    const searchInput = document.getElementById('adminSearchInput');
    const searchBtn = document.getElementById('adminSearchBtn');
    const resetSearchBtn = document.getElementById('adminResetSearchBtn');
    const usedFilter = document.getElementById('adminUsedFilter');
    const limitSelect = document.getElementById('adminLimitSelect');
    const paginationInfo = document.getElementById('adminPaginationInfo');
    const prevPageBtn = document.getElementById('adminPrevPage');
    const nextPageBtn = document.getElementById('adminNextPage');

    const adminHeader = document.getElementById('adminHeader');
    const adminCloseBtn = document.getElementById('adminCloseBtn');

    let backendUrl = '';
    let adminKey = '';
    let generatedCodes = [];

    let currentSearch = '';
    let currentUsed = 'all';
    let currentLimit = 10;
    let currentOffset = 0;
    let currentTotal = 0;

    function nativeCall(name, arg) {
        if (typeof window.native_call === 'function') {
            return window.native_call(name, arg);
        }
        return Promise.reject(new Error('native_call bridge not available'));
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
        if (window.__admin_message_setup) return;
        window.__admin_message_setup = true;
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
    }

    function api(path) {
        return backendUrl.replace(/\/$/, '') + path;
    }

    async function adminPost(path, body) {
        const res = await fetch(api(path), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Admin-Key': adminKey,
            },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
            throw new Error(data.detail || ('请求失败: ' + res.status));
        }
        return data;
    }

    async function adminGet(path) {
        const res = await fetch(api(path), {
            method: 'GET',
            headers: { 'X-Admin-Key': adminKey },
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
            throw new Error(data.detail || ('请求失败: ' + res.status));
        }
        return data;
    }

    function showToast(msg) {
        const toast = document.createElement('div');
        toast.className = 'admin-toast show';
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(function () {
            toast.classList.remove('show');
            setTimeout(function () { toast.remove(); }, 300);
        }, 2000);
    }

    async function verifyAdminKey(key) {
        const tempKey = adminKey;
        adminKey = key;
        try {
            await adminGet('/api/admin/codes?limit=0');
            sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
            return true;
        } catch (e) {
            adminKey = tempKey;
            throw e;
        }
    }

    function showMain() {
        keySection.classList.add('hidden');
        mainSection.classList.remove('hidden');
    }

    async function onKeySubmit() {
        const key = adminKeyInput.value.trim();
        if (!key) {
            keyError.textContent = '请输入管理密钥';
            return;
        }
        keySubmit.disabled = true;
        keyError.textContent = '';
        try {
            await verifyAdminKey(key);
            showMain();
            loadRecentCodes();
        } catch (e) {
            keyError.textContent = e.message || '密钥验证失败';
        } finally {
            keySubmit.disabled = false;
        }
    }

    function updateTrialDaysVisibility() {
        const selected = document.querySelector('input[name="codeType"]:checked').value;
        trialDaysRow.style.display = selected === 'trial' ? 'flex' : 'none';
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function formatDateTime(iso) {
        if (!iso) return '-';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0') + ' ' +
            String(d.getHours()).padStart(2, '0') + ':' +
            String(d.getMinutes()).padStart(2, '0');
    }

    function calcRemainingDays(item) {
        if (item.code_type !== 'trial' || !item.activated_at) return '-';
        const days = item.trial_days || 0;
        if (days <= 0) return '-';
        const activated = new Date(item.activated_at);
        const deadline = new Date(activated.getTime() + days * 24 * 60 * 60 * 1000);
        const now = new Date();
        const remaining = Math.ceil((deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        return remaining > 0 ? remaining + ' 天' : '已过期';
    }

    function renderResultCodes(codes, codeType, trialDays, remark) {
        resultList.innerHTML = '';
        generatedCodes = codes;
        const metaParts = [codeType === 'trial' ? '试用 ' + trialDays + ' 天' : '永久'];
        if (remark) metaParts.push(remark);
        const meta = metaParts.join(' · ');

        codes.forEach(function (code) {
            const item = document.createElement('div');
            item.className = 'admin-code-item';
            item.innerHTML = '<div>' +
                '<div class="admin-code-text">' + escapeHtml(code) + '</div>' +
                '<div class="admin-code-meta">' + escapeHtml(meta) + '</div>' +
                '</div>' +
                '<button class="admin-btn admin-btn-secondary copy-one-btn">复制</button>';
            item.querySelector('.copy-one-btn').addEventListener('click', function () {
                copyToClipboard(code);
            });
            resultList.appendChild(item);
        });

        resultArea.classList.remove('hidden');
    }

    async function onGenerate() {
        const codeType = document.querySelector('input[name="codeType"]:checked').value;
        const count = parseInt(countInput.value, 10) || 1;
        const trialDays = codeType === 'trial' ? (parseInt(trialDaysInput.value, 10) || 7) : null;
        const remark = remarkInput.value.trim() || null;

        if (count < 1 || count > 1000) {
            formError.textContent = '生成数量应在 1-1000 之间';
            return;
        }

        generateBtn.disabled = true;
        formError.textContent = '';
        try {
            const data = await adminPost('/api/admin/codes', {
                count: count,
                code_type: codeType,
                trial_days: trialDays,
                remark: remark,
            });
            renderResultCodes(data.codes, data.code_type, data.trial_days, data.remark);
            showToast('已生成 ' + data.count + ' 个激活码');
            currentOffset = 0;
            loadRecentCodes();
        } catch (e) {
            formError.textContent = e.message || '生成失败';
        } finally {
            generateBtn.disabled = false;
        }
    }

    async function copyToClipboard(text) {
        try {
            await nativeCall('copyToClipboard', { text: text });
            showToast('已复制到剪贴板');
        } catch (e) {
            showToast('复制失败');
        }
    }

    async function onCopyAll() {
        if (!generatedCodes.length) return;
        await copyToClipboard(generatedCodes.join('\n'));
    }

    function buildCsvContent(codes, codeType, trialDays, remark) {
        const headers = ['code', 'type', 'trial_days', 'remark'];
        const rows = codes.map(function (code) {
            return [code, codeType, trialDays || '', remark || ''].map(function (v) {
                return '"' + String(v).replace(/"/g, '""') + '"';
            }).join(',');
        });
        return '\ufeff' + headers.join(',') + '\n' + rows.join('\n');
    }

    async function onExportCsv() {
        if (!generatedCodes.length) return;
        const codeType = document.querySelector('input[name="codeType"]:checked').value;
        const trialDays = codeType === 'trial' ? (parseInt(trialDaysInput.value, 10) || 7) : null;
        const remark = remarkInput.value.trim() || '';
        const content = buildCsvContent(generatedCodes, codeType, trialDays, remark);
        try {
            const result = await nativeCall('saveCsvFile', {
                content: content,
                defaultName: 'activation_codes_' + formatDate() + '.csv',
            });
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            if (parsed.ok) {
                showToast('CSV 已保存');
            } else {
                showToast('保存取消或失败');
            }
        } catch (e) {
            showToast('保存失败');
        }
    }

    function formatDate() {
        const d = new Date();
        return d.getFullYear() +
            String(d.getMonth() + 1).padStart(2, '0') +
            String(d.getDate()).padStart(2, '0') + '_' +
            String(d.getHours()).padStart(2, '0') +
            String(d.getMinutes()).padStart(2, '0');
    }

    function buildListUrl() {
        const params = new URLSearchParams();
        params.set('limit', String(currentLimit));
        params.set('offset', String(currentOffset));
        if (currentSearch.trim()) params.set('search', currentSearch.trim());
        if (usedFilter && usedFilter.value && usedFilter.value !== 'all') {
            params.set('used', usedFilter.value);
        }
        return '/api/admin/codes?' + params.toString();
    }

    async function loadRecentCodes() {
        try {
            const data = await adminGet(buildListUrl());
            currentTotal = data.total || 0;
            renderRecentCodes(data.items || []);
            renderPagination();
        } catch (e) {
            recentList.innerHTML = '<div class="admin-empty">加载失败: ' + escapeHtml(e.message) + '</div>';
            if (paginationInfo) paginationInfo.textContent = '';
        }
    }

    function renderRecentCodes(items) {
        if (!items.length) {
            recentList.innerHTML = '<div class="admin-empty">暂无记录</div>';
            return;
        }
        const header = document.createElement('div');
        header.className = 'admin-recent-header';
        header.innerHTML = '<div class="admin-recent-cell">激活码</div>' +
            '<div class="admin-recent-cell">类型</div>' +
            '<div class="admin-recent-cell">备注 / 账号</div>' +
            '<div class="admin-recent-cell">生成时间</div>' +
            '<div class="admin-recent-cell">剩余天数</div>' +
            '<div class="admin-recent-cell">状态</div>' +
            '<div class="admin-recent-cell" style="text-align:right">操作</div>';

        const list = document.createElement('div');
        items.forEach(function (item) {
            const el = document.createElement('div');
            el.className = 'admin-recent-item';

            const used = item.used_count >= item.max_uses;
            const statusClass = used ? 'admin-status-used' : 'admin-status-unused';
            const statusText = used ? '已使用' : '未使用';
            const typeText = item.code_type === 'trial' ? '试用 ' + (item.trial_days || '') + ' 天' : '永久';
            const extraInfo = item.activated_user_name || item.remark || '—';

            el.innerHTML =
                '<div class="admin-recent-cell admin-recent-code" title="点击复制">' + escapeHtml(item.code) + '</div>' +
                '<div class="admin-recent-cell">' + escapeHtml(typeText) + '</div>' +
                '<div class="admin-recent-cell" title="' + escapeHtml(extraInfo) + '">' + escapeHtml(extraInfo) + '</div>' +
                '<div class="admin-recent-cell">' + escapeHtml(formatDateTime(item.created_at)) + '</div>' +
                '<div class="admin-recent-cell">' + escapeHtml(calcRemainingDays(item)) + '</div>' +
                '<div class="admin-recent-cell"><span class="admin-recent-status ' + statusClass + '">' + statusText + '</span></div>' +
                '<div class="admin-recent-cell admin-recent-actions"><button class="admin-btn admin-btn-small copy-recent-btn">复制</button></div>';

            const copyHandler = function () { copyToClipboard(item.code); };
            el.querySelector('.copy-recent-btn').addEventListener('click', copyHandler);
            el.querySelector('.admin-recent-code').addEventListener('click', copyHandler);
            list.appendChild(el);
        });

        recentList.innerHTML = '';
        recentList.appendChild(header);
        recentList.appendChild(list);
    }

    function renderPagination() {
        if (!paginationInfo) return;
        const start = currentTotal === 0 ? 0 : currentOffset + 1;
        const end = Math.min(currentOffset + currentLimit, currentTotal);
        paginationInfo.textContent = start + '-' + end + ' / 共 ' + currentTotal + ' 条';
        if (prevPageBtn) prevPageBtn.disabled = currentOffset <= 0;
        if (nextPageBtn) nextPageBtn.disabled = currentOffset + currentLimit >= currentTotal;
    }

    function onSearch() {
        currentSearch = searchInput.value.trim();
        currentOffset = 0;
        loadRecentCodes();
    }

    function onResetSearch() {
        searchInput.value = '';
        currentSearch = '';
        currentOffset = 0;
        loadRecentCodes();
    }

    function onUsedFilterChange() {
        currentUsed = usedFilter.value;
        currentOffset = 0;
        loadRecentCodes();
    }

    function onLimitChange() {
        currentLimit = parseInt(limitSelect.value, 10) || 10;
        currentOffset = 0;
        loadRecentCodes();
    }

    function onPrevPage() {
        if (currentOffset <= 0) return;
        currentOffset = Math.max(0, currentOffset - currentLimit);
        loadRecentCodes();
    }

    function onNextPage() {
        if (currentOffset + currentLimit >= currentTotal) return;
        currentOffset += currentLimit;
        loadRecentCodes();
    }

    function setupEvents() {
        keySubmit.addEventListener('click', function (e) {
            e.preventDefault();
            onKeySubmit();
        });

        adminKeyInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') onKeySubmit();
        });

        codeTypeRadios.forEach(function (radio) {
            radio.addEventListener('change', updateTrialDaysVisibility);
        });

        generateBtn.addEventListener('click', function (e) {
            e.preventDefault();
            onGenerate();
        });

        copyAllBtn.addEventListener('click', function (e) {
            e.preventDefault();
            onCopyAll();
        });

        exportCsvBtn.addEventListener('click', function (e) {
            e.preventDefault();
            onExportCsv();
        });

        if (searchBtn) searchBtn.addEventListener('click', onSearch);
        if (resetSearchBtn) resetSearchBtn.addEventListener('click', onResetSearch);
        if (searchInput) {
            searchInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') onSearch();
            });
        }
        if (usedFilter) usedFilter.addEventListener('change', onUsedFilterChange);
        if (limitSelect) limitSelect.addEventListener('change', onLimitChange);
        if (prevPageBtn) prevPageBtn.addEventListener('click', onPrevPage);
        if (nextPageBtn) nextPageBtn.addEventListener('click', onNextPage);

        adminCloseBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            nativeCall('close').catch(function () {});
        });

        adminHeader.addEventListener('mousedown', function (e) {
            if (e.target === adminCloseBtn || adminCloseBtn.contains(e.target)) return;
            nativeCall('startDrag').catch(function () {});
        });
    }

    async function start() {
        setupEvents();
        try {
            await waitForBridge(3000);
            await resolveBackendUrl();

            const savedKey = sessionStorage.getItem(ADMIN_KEY_STORAGE);
            if (savedKey) {
                try {
                    await verifyAdminKey(savedKey);
                    showMain();
                    loadRecentCodes();
                    return;
                } catch (e) {
                    sessionStorage.removeItem(ADMIN_KEY_STORAGE);
                }
            }
            keySection.classList.remove('hidden');
            mainSection.classList.add('hidden');
            setTimeout(function () { adminKeyInput.focus(); }, 50);
        } catch (e) {
            keyError.textContent = '初始化失败: ' + e.message;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
