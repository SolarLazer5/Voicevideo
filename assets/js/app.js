(function () {
    'use strict';

    // ===================== 工具函数 =====================
    function $(selector) {
        return document.querySelector(selector);
    }

    function $$(selector) {
        return Array.from(document.querySelectorAll(selector));
    }

    function addClass(el, className) {
        if (el && !el.classList.contains(className)) {
            el.classList.add(className);
        }
    }

    function removeClass(el, className) {
        if (el) {
            el.classList.remove(className);
        }
    }

    // ===================== 原生窗口控制 =====================
    function _tryParseJson(value) {
        if (typeof value !== 'string') return value;
        try {
            return JSON.parse(value);
        } catch (e) {
            return value;
        }
    }

    function nativeCall(name, arg) {
        return new Promise(function (resolve, reject) {
            // 优先使用 C++ 注入的 window.native_call
            if (typeof window.native_call === 'function') {
                try {
                    var promise = window.native_call(name, arg);
                    if (promise && typeof promise.then === 'function') {
                        promise.then(function (res) { resolve(_tryParseJson(res)); }).catch(reject);
                    } else {
                        resolve(_tryParseJson(promise));
                    }
                } catch (e) {
                    reject(e);
                }
                return;
            }

            // WebView2 直接回退
            if (window.chrome && window.chrome.webview) {
                if (!window.__voicevideo_callbacks) {
                    window.__voicevideo_callbacks = {};
                    window.__voicevideo_call_id = 0;
                    window.__largui_resolve = function (id, ok, result) {
                        var cb = window.__voicevideo_callbacks[id];
                        if (!cb) return;
                        delete window.__voicevideo_callbacks[id];
                        if (ok) cb.resolve(_tryParseJson(result));
                        else cb.reject(new Error(result || 'native call failed'));
                    };
                    window.chrome.webview.addEventListener('message', function (e) {
                        var data = e.data;
                        if (typeof data !== 'string') return;
                        var sep = data.indexOf('|');
                        if (sep === -1) return;
                        var id = parseInt(data.substring(0, sep), 10);
                        var result = data.substring(sep + 1);
                        window.__largui_resolve(id, true, result);
                    });
                }
                var id = ++window.__voicevideo_call_id;
                window.__voicevideo_callbacks[id] = { resolve: resolve, reject: reject };
                window.chrome.webview.postMessage(id + ':' + name + '|' + JSON.stringify(arg === undefined ? null : arg));
                return;
            }

            reject(new Error('native_call not available'));
        });
    }

    function initDragRegion() {
        $$('[data-drag-region]').forEach(function (el) {
            el.addEventListener('mousedown', function (e) {
                // 如果点击的是内部按钮/控件，不触发拖拽
                let target = e.target;
                while (target && target !== el) {
                    if (target.hasAttribute('data-win-action') ||
                        target.classList.contains('win-btn') ||
                        target.tagName === 'BUTTON' ||
                        target.tagName === 'INPUT' ||
                        target.tagName === 'TEXTAREA') {
                        return;
                    }
                    target = target.parentElement;
                }
                nativeCall('startDrag').catch(function () {});
            });
        });
    }

    function initWindowControls() {
        nativeCall('getPlatform').then(function (result) {
            const platform = (result && result.platform) || 'windows';
            $$('[data-win-action]').forEach(function (el) {
                const action = el.getAttribute('data-win-action');
                el.style.cursor = 'pointer';
                el.classList.add('win-btn', 'win-btn-' + action);

                if (platform === 'macos') {
                    el.classList.add('mac-style');
                }

                el.addEventListener('click', function () {
                    if (action) nativeCall(action).catch(function () {});
                });
            });
        }).catch(function (e) {
            console.error('getPlatform error:', e);
        });
    }

    // ===================== 全局设置（云端算力开关）=====================
    function getCloudSettings() {
        try {
            const enabled =
                localStorage.getItem('vv_cloud_enabled') === 'true' ||
                localStorage.getItem('vv_cloud_video_enabled') === 'true';
            return {
                enabled: enabled,
                dashscopeKey: localStorage.getItem('vv_cloud_dashscope_key') || '',
                workspaceId: localStorage.getItem('vv_cloud_workspace_id') || ''
            };
        } catch (e) {
            return { enabled: false, dashscopeKey: '', workspaceId: '' };
        }
    }

    function saveCloudSettings(settings) {
        try {
            localStorage.setItem('vv_cloud_enabled', settings.enabled ? 'true' : 'false');
            localStorage.setItem('vv_cloud_dashscope_key', settings.dashscopeKey || '');
            localStorage.setItem('vv_cloud_workspace_id', settings.workspaceId || '');
            // 清理旧键，避免歧义
            localStorage.removeItem('vv_cloud_video_enabled');
            localStorage.removeItem('vv_cloud_wan_style');
            localStorage.removeItem('vv_cloud_wan_resolution');
        } catch (e) {}
    }

    function isCloudEnabled() {
        return getCloudSettings().enabled;
    }

    function maybeAppendCloudParams(payload, requireWorkspaceId) {
        const settings = getCloudSettings();
        if (settings.enabled) {
            if (!settings.dashscopeKey || (requireWorkspaceId && !settings.workspaceId)) {
                return { ok: false, missing: '请先在设置中填写阿里云百炼 API Key' + (requireWorkspaceId ? ' 与业务空间 ID' : '') };
            }
            payload.use_cloud = true;
            payload.dashscope_key = settings.dashscopeKey;
            if (requireWorkspaceId) {
                payload.workspace_id = settings.workspaceId;
            }
        }
        return { ok: true };
    }

    function getCloudVoiceSystemOptions() {
        // cosyvoice-v3-plus 官方仅支持 longanhuan / longanyang 两个系统音色
        return [
            { value: 'longanhuan', label: '龙安欢（欢脱元气女）' },
            { value: 'longanyang', label: '龙安洋（阳光大男孩）' }
        ];
    }

    function getCustomVoiceState() {
        try {
            return {
                sample: localStorage.getItem('vv_cloud_custom_voice_sample') || '',
                name: localStorage.getItem('vv_cloud_custom_voice_name') || ''
            };
        } catch (e) { return { sample: '', name: '' }; }
    }

    function setCustomVoiceState(sample, name) {
        try {
            if (sample) {
                localStorage.setItem('vv_cloud_custom_voice_sample', sample);
                localStorage.setItem('vv_cloud_custom_voice_name', name || '我的音色');
            } else {
                localStorage.removeItem('vv_cloud_custom_voice_sample');
                localStorage.removeItem('vv_cloud_custom_voice_name');
            }
        } catch (e) {}
    }

    function closeSettingsModal() {
        const modal = $('.vv-settings-modal-overlay');
        if (modal) modal.remove();
    }

    function escapeHtml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function openSettingsModal() {
        closeSettingsModal();
        const settings = getCloudSettings();
        const overlay = document.createElement('div');
        overlay.className = 'vv-settings-modal-overlay';
        overlay.innerHTML =
            '<div class="vv-settings-modal">' +
                '<div class="vv-settings-header">' +
                    '<span>设置</span>' +
                    '<button class="vv-settings-close" title="关闭">&times;</button>' +
                '</div>' +
                '<div class="vv-settings-body">' +
                    '<label class="vv-settings-row">' +
                        '<span>默认使用云端算力加成</span>' +
                        '<input type="checkbox" id="vv-cloud-enabled" ' + (settings.enabled ? 'checked' : '') + '>' +
                    '</label>' +
                    '<div class="vv-settings-field">' +
                        '<div class="vv-settings-label-row">' +
                            '<label for="vv-cloud-dashscope-key">阿里云百炼 API Key</label>' +
                            '<a class="vv-settings-link" href="#" id="vv-cloud-dashscope-key-link">去创建 &rarr;</a>' +
                        '</div>' +
                        '<input type="password" id="vv-cloud-dashscope-key" value="' + escapeHtml(settings.dashscopeKey) + '" placeholder="输入阿里云百炼 API Key">' +
                    '</div>' +
                    '<div class="vv-settings-field">' +
                        '<label for="vv-cloud-workspace-id">业务空间 ID</label>' +
                        '<input type="text" id="vv-cloud-workspace-id" value="' + escapeHtml(settings.workspaceId) + '" placeholder="输入 WorkspaceId，例如 ws-xxxxx">' +
                    '</div>' +
                '</div>' +
                '<div class="vv-settings-footer">' +
                    '<button class="vv-settings-save">保存</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeSettingsModal();
        });
        $('.vv-settings-close').addEventListener('click', closeSettingsModal);
        const dashscopeKeyLink = $('#vv-cloud-dashscope-key-link');
        if (dashscopeKeyLink) {
            dashscopeKeyLink.addEventListener('click', function (e) {
                e.preventDefault();
                nativeCall('openUrl', { url: 'https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key' }).catch(function () {});
            });
        }
        $('.vv-settings-save').addEventListener('click', function () {
            const enabled = $('#vv-cloud-enabled').checked;
            const dashscopeKey = $('#vv-cloud-dashscope-key').value.trim();
            const workspaceId = $('#vv-cloud-workspace-id').value.trim();
            if (enabled && !dashscopeKey) {
                alert('开启云端算力需要填写阿里云百炼 API Key');
                return;
            }
            if (enabled && !workspaceId) {
                alert('开启云端算力需要填写业务空间 ID');
                return;
            }
            saveCloudSettings({ enabled: enabled, dashscopeKey: dashscopeKey, workspaceId: workspaceId });
            closeSettingsModal();
            // 如果当前在声音生成页，立即刷新控件状态
            if (window.__voicevideo_page__ && window.__voicevideo_page__.indexOf('VoiceGernerate.html') !== -1) {
                updateVoiceCloudUI();
            }
        });
    }

    function injectSettingsButton() {
        if ($('.vv-settings-btn')) return;
        const btn = document.createElement('div');
        btn.className = 'vv-settings-btn';
        btn.title = '全局设置';
        btn.innerHTML = '<span class="vv-settings-icon">&#x2699;</span><span class="vv-settings-label">全局设置</span>';
        btn.addEventListener('click', openSettingsModal);
        document.body.appendChild(btn);
    }

    // ===================== 页面缩放适配 =====================
    function fitPage(shouldResizeWindow) {
        const root = $('.v6_68, .v2_121, .v10_54, .v17_167, .v19_332, .v21_615, .v23_761');
        if (!root) return;

        // 设计稿参考尺寸（100% DPI 下窗口为 1400x972）
        const designW = 1400;
        const designH = 972;

        root.style.width = designW + 'px';
        root.style.height = designH + 'px';
        root.classList.add('page-root');

        // 强制按设计稿 1:1 显示，窗口恒定为 1400x972
        root.style.transform = 'scale(1)';
        root.style.left = '0px';
        root.style.top = '0px';

        // 初始加载时通知 C++ 将窗口调整为设计尺寸
        if (shouldResizeWindow) {
            nativeCall('resizeWindow', { width: designW, height: designH }).catch(function () {});
        }
    }

    function bindResize() {
        if (window.__voicevideoResizeBound) return;
        window.__voicevideoResizeBound = true;
        let timer = null;
        window.addEventListener('resize', function () {
            clearTimeout(timer);
            timer = setTimeout(function () { fitPage(false); }, 50);
        });
    }

    // ===================== 页面样式切换 =====================
    function markCurrentPageStyle() {
        // 给当前页面专属样式表打标记，方便导航时替换
        $$('link[rel="stylesheet"]').forEach(function (link) {
            const href = link.getAttribute('href') || '';
            if (href.indexOf('app.css') === -1 && href.indexOf('fonts.googleapis') === -1 && !link.hasAttribute('data-page-css')) {
                link.setAttribute('data-page-css', 'true');
            }
        });
    }

    function loadPageStyles(pageName, callback) {
        // 移除旧页面专属样式及子页面样式
        $$('link[data-page-css], link[data-sub-page-css]').forEach(function (link) {
            link.remove();
        });

        // 加载新页面样式，保持“页面 CSS 在前，app.css 在后”的原始顺序
        const cssName = pageName.replace(/\.html$/i, '.css');
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = './css/' + cssName;
        link.setAttribute('data-page-css', 'true');

        let loaded = false;
        function done() {
            if (loaded) return;
            loaded = true;
            if (typeof callback === 'function') callback();
        }
        link.onload = done;
        link.onerror = done;

        const appCssLink = document.querySelector('link[href*="app.css"]');
        if (appCssLink) {
            document.head.insertBefore(link, appCssLink);
        } else {
            document.head.appendChild(link);
        }
        setTimeout(done, 200); // 兜底，避免网络异常导致卡住
    }

    // ===================== 页面导航 =====================
    function navigateTo(pageName) {
        window.__voicevideo_page__ = pageName;
        const body = document.body;

        // 淡出当前页面
        body.style.transition = 'opacity 0.25s ease';
        body.style.opacity = '0';

        setTimeout(function () {
            fetch(pageName)
                .then(function (response) {
                    if (!response.ok) {
                        throw new Error('Failed to load ' + pageName);
                    }
                    return response.text();
                })
                .then(function (html) {
                    // 清理子页面样式，避免带入新页面
                    $$('link[data-sub-page-css]').forEach(function (link) {
                        link.remove();
                    });

                    // 先加载新页面样式，再替换 body，避免无样式闪烁
                    loadPageStyles(pageName, function () {
                        // 提取 <body>...</body> 中的内容
                        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
                        const newBodyHtml = bodyMatch ? bodyMatch[1] : html;

                        body.innerHTML = newBodyHtml;
                        document.documentElement.scrollTop = 0;
                        document.body.scrollTop = 0;

                        // 重新注入脚本（fetch 不会执行 <script>）
                        const script = document.createElement('script');
                        script.src = 'js/app.js?v=8';
                        body.appendChild(script);

                        // 淡入
                        requestAnimationFrame(function () {
                            body.style.opacity = '1';
                        });
                    });
                })
                .catch(function (err) {
                    console.error('Navigation error:', err);
                    body.style.opacity = '1';
                });
        }, 250);
    }

    // ===================== 通用渐变按钮交互（提取文案 / 下一步 等）=====================
    function setupGradientButton(textSelector, bgSelector, onClick) {
        const btnText = $(textSelector);
        const btnBg = $(bgSelector);
        if (!btnText || !btnBg) return;

        btnText.style.cursor = 'pointer';
        btnBg.style.cursor = 'pointer';
        btnBg.style.transition = 'filter 0.2s ease, transform 0.1s ease';
        btnText.style.transition = 'transform 0.1s ease';

        function hover() {
            btnBg.style.filter = 'brightness(1.15)';
            btnBg.style.transform = 'scale(1.02)';
        }
        function leave() {
            btnBg.style.filter = 'brightness(1)';
            btnBg.style.transform = 'scale(1)';
        }
        function down() {
            btnBg.style.transform = 'scale(0.97)';
            btnText.style.transform = 'scale(0.97)';
        }
        function up() {
            btnBg.style.transform = 'scale(1.02)';
            btnText.style.transform = 'scale(1)';
        }

        [btnText, btnBg].forEach(function (el) {
            el.addEventListener('mouseenter', hover);
            el.addEventListener('mouseleave', leave);
            el.addEventListener('mousedown', down);
            el.addEventListener('mouseup', up);
        });

        if (typeof onClick === 'function') {
            btnBg.addEventListener('click', onClick);
            btnText.addEventListener('click', onClick);
        }
    }

    // ===================== “开始新任务”按钮交互 =====================
    function setupStartNewTaskButton() {
        const bg = $('.v6_74') || $('.v2_127') || $('.v8_8') || $('.v17_62') || $('.v18_175') || $('.v20_341');
        const text = $('.v6_75') || $('.v2_128') || $('.v8_9') || $('.v17_63') || $('.v18_176') || $('.v20_342');
        if (!bg || !text) return;

        bg.style.transition = 'filter 0.2s ease, transform 0.1s ease';
        text.style.transition = 'transform 0.1s ease';

        function hover() {
            bg.style.filter = 'brightness(1.2)';
            bg.style.transform = 'scale(1.05)';
        }
        function leave() {
            bg.style.filter = 'brightness(1)';
            bg.style.transform = 'scale(1)';
        }
        function down() {
            bg.style.transform = 'scale(0.96)';
            text.style.transform = 'scale(0.96)';
        }
        function up() {
            bg.style.transform = 'scale(1.05)';
            text.style.transform = 'scale(1)';
        }
        function onClick() {
            console.log('开始新任务');
        }

        [bg, text].forEach(function (el) {
            el.addEventListener('mouseenter', hover);
            el.addEventListener('mouseleave', leave);
            el.addEventListener('mousedown', down);
            el.addEventListener('mouseup', up);
        });

        bg.addEventListener('click', onClick);
        text.addEventListener('click', onClick);
    }

    // ===================== 可编辑框（占位文本自动显隐）=====================
    function setupEditableBox(box, placeholderSelector) {
        if (!box) return;
        box.setAttribute('contenteditable', 'true');
        box.classList.add('editable-area');
        box.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease';

        const placeholder = placeholderSelector ? $(placeholderSelector) : null;

        function updatePlaceholder() {
            if (!placeholder) return;
            const isEmpty = box.textContent.trim().length === 0;
            placeholder.style.display = (isEmpty && document.activeElement !== box) ? 'block' : 'none';
        }

        box.addEventListener('mouseenter', function () {
            box.style.boxShadow = '0 0 0 1px rgba(219,112,255,0.5)';
        });
        box.addEventListener('mouseleave', function () {
            box.style.boxShadow = 'none';
        });
        box.addEventListener('mousedown', function () {
            box.style.transform = 'scale(0.99)';
        });
        box.addEventListener('mouseup', function () {
            box.style.transform = 'scale(1)';
        });
        box.addEventListener('focus', updatePlaceholder);
        box.addEventListener('blur', updatePlaceholder);
        box.addEventListener('input', updatePlaceholder);

        updatePlaceholder();
    }

    // ===================== 输入框与上传区交互 =====================
    function setupInputs() {
        // LinkVideoExtract
        setupEditableBox($('.v6_114'), '.v6_116');
        setupEditableBox($('.v6_128'), '.v6_129');

        // ArticleRewrite
        setupEditableBox($('.v2_189'), '.v2_190');
        setupEditableBox($('.v2_181'), '.v2_182');

        // VoiceGenerate
        setupEditableBox($('.v8_62'), '.v8_63');
    }

    // ===================== 上传音频/视频文件选择 =====================
    function setupFilePicker() {
        const box = $('.v6_117');
        if (!box) return;

        box.style.cursor = 'pointer';
        box.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease';

        box.addEventListener('mouseenter', function () {
            box.style.boxShadow = '0 0 0 1px rgba(219,112,255,0.5)';
        });
        box.addEventListener('mouseleave', function () {
            box.style.boxShadow = 'none';
        });
        box.addEventListener('mousedown', function () {
            box.style.transform = 'scale(0.98)';
        });
        box.addEventListener('mouseup', function () {
            box.style.transform = 'scale(1)';
        });

        box.addEventListener('click', function () {
            nativeCall('pickFile').then(function (result) {
                if (result && result.path) {
                    const hint = $('.v6_121');
                    const input = $('.v6_114');
                    const placeholder = $('.v6_116');
                    if (hint) hint.textContent = '已选择：' + result.path;
                    if (input) {
                        input.textContent = result.path;
                        input.setAttribute('data-local-file', 'true');
                    }
                    if (placeholder) placeholder.style.display = 'none';
                }
            }).catch(function (e) {
                console.error('pickFile failed', e);
            });
        });
    }

    // ===================== 左侧工作流步骤交互 =====================
    function setupSidebarInteractions() {
        const pageDefs = {
            'LinkVideoExtract.html': [
                { bg: '.v6_77', text: '.v6_84', icon: '.v6_85' },
                { bg: '.v6_79', text: '.v6_88', icon: '.v6_99' },
                { bg: '.v6_78', text: '.v6_86', icon: '.v6_87' },
                { bg: '.v6_80', text: '.v6_89', icon: '.v6_100' },
                { bg: '.v6_83', text: '.v6_92', icon: '.v6_101' },
                { bg: '.v6_81', text: '.v6_90', icon: '.v6_102' },
                { bg: '.v6_82', text: '.v6_91', icon: '.v6_103' }
            ],
            'ArticleRewrite.html': [
                { bg: '.v2_130', text: '.v2_137', icon: '.v2_138' },
                { bg: '.v2_132', text: '.v2_141', icon: '.v2_152' },
                { bg: '.v2_131', text: '.v2_139', icon: '.v2_140' },
                { bg: '.v2_133', text: '.v2_142', icon: '.v2_153' },
                { bg: '.v2_136', text: '.v2_145', icon: '.v2_154' },
                { bg: '.v2_134', text: '.v2_143', icon: '.v2_155' },
                { bg: '.v2_135', text: '.v2_144', icon: '.v2_156' }
            ],
            'VoiceGernerate.html': [
                { bg: '.v8_11', text: '.v8_18', icon: '.v8_19' },
                { bg: '.v8_13', text: '.v8_22', icon: '.v8_33' },
                { bg: '.v8_12', text: '.v8_20', icon: '.v8_21' },
                { bg: '.v8_14', text: '.v8_23', icon: '.v8_34' },
                { bg: '.v8_17', text: '.v8_26', icon: '.v8_35' },
                { bg: '.v8_15', text: '.v8_24', icon: '.v8_36' },
                { bg: '.v8_16', text: '.v8_25', icon: '.v8_37' }
            ],
            'VideoGernerate.html': [
                { bg: '.v17_65', text: '.v17_72', icon: '.v17_73' },
                { bg: '.v17_67', text: '.v17_77', icon: '.v17_88' },
                { bg: '.v17_66', text: '.v17_74', icon: '.v17_75' },
                { bg: '.v17_68', text: '.v17_78', icon: '.v17_163' },
                { bg: '.v17_71', text: '.v17_81', icon: '.v17_90' },
                { bg: '.v17_69', text: '.v17_79', icon: '.v17_91' },
                { bg: '.v17_70', text: '.v17_80', icon: '.v17_92' }
            ],
            'VideoCut.html': [
                { bg: '.v18_178', text: '.v18_185', icon: '.v18_186' },
                { bg: '.v18_180', text: '.v18_190', icon: '.v18_201' },
                { bg: '.v18_179', text: '.v18_187', icon: '.v18_188' },
                { bg: '.v18_181', text: '.v18_191', icon: '.v18_244' },
                { bg: '.v18_184', text: '.v18_194', icon: '.v18_202' },
                { bg: '.v18_182', text: '.v18_192', icon: '.v18_203' },
                { bg: '.v18_183', text: '.v18_193', icon: '.v18_204' }
            ],
            'BannerGenerate.html': [
                { bg: '.v20_344', text: '.v20_351', icon: '.v20_352' },
                { bg: '.v20_346', text: '.v20_356', icon: '.v20_367' },
                { bg: '.v20_345', text: '.v20_353', icon: '.v20_354' },
                { bg: '.v20_347', text: '.v20_357', icon: '.v20_386' },
                { bg: '.v20_350', text: '.v20_360', icon: '.v20_368' },
                { bg: '.v20_348', text: '.v20_358', icon: '.v20_369' },
                { bg: '.v20_349', text: '.v20_359', icon: '.v20_370' }
            ],
            'Publish.html': [
                { bg: '.v23_626', text: '.v23_634', icon: '.v23_635' },
                { bg: '.v23_628', text: '.v23_639', icon: '.v23_650' },
                { bg: '.v23_627', text: '.v23_636', icon: '.v23_637' },
                { bg: '.v23_630', text: '.v23_640', icon: '.v23_661' },
                { bg: '.v23_633', text: '.v23_643', icon: '.v23_651' },
                { bg: '.v23_631', text: '.v23_641', icon: '.v23_652' },
                { bg: '.v23_632', text: '.v23_642', icon: '.v23_653' }
            ]
        };

        // 各步骤对应的目标页面（按顺序：提取文案 / 改写文案 / 声音生成 / 视频生成 / 网感剪辑 / 标题封面 / 一键发布）
        const routeTargets = [
            'LinkVideoExtract.html',
            'ArticleRewrite.html',
            'VoiceGernerate.html',
            'VideoGernerate.html',
            'VideoCut.html',
            'BannerGenerate.html',
            'Publish.html'
        ];

        const implementedPages = ['LinkVideoExtract.html', 'ArticleRewrite.html', 'VoiceGernerate.html', 'VideoGernerate.html', 'VideoCut.html', 'BannerGenerate.html', 'Publish.html'];
        const currentPage = window.__voicevideo_page__ || window.location.pathname;
        const pageKey = Object.keys(pageDefs).find(function (k) { return currentPage.indexOf(k) !== -1; });
        if (!pageKey) return;

        const items = pageDefs[pageKey];
        items.forEach(function (item, index) {
            const bg = $(item.bg);
            const text = $(item.text);
            const icon = item.icon ? $(item.icon) : null;
            if (!bg || !text) return;

            bg.style.transition = 'filter 0.2s ease, transform 0.1s ease';
            text.style.transition = 'color 0.2s ease, transform 0.1s ease';
            if (icon) icon.style.transition = 'transform 0.2s ease';

            function hover() {
                bg.style.filter = 'brightness(1.15)';
                bg.style.transform = 'scale(1.02)';
                text.style.color = 'rgba(255,255,255,1)';
                if (icon) icon.style.transform = 'scale(1.1)';
            }
            function leave() {
                bg.style.filter = 'brightness(1)';
                bg.style.transform = 'scale(1)';
                text.style.color = '';
                if (icon) icon.style.transform = 'scale(1)';
            }
            function down() {
                bg.style.transform = 'scale(0.97)';
                text.style.transform = 'scale(0.97)';
                if (icon) icon.style.transform = 'scale(0.95)';
            }
            function up() {
                bg.style.transform = 'scale(1.02)';
                text.style.transform = 'scale(1)';
                if (icon) icon.style.transform = 'scale(1.1)';
            }
            function onClick() {
                const target = routeTargets[index];
                if (!target || currentPage.indexOf(target) !== -1) return;
                if (implementedPages.indexOf(target) !== -1) {
                    navigateTo(target);
                } else {
                    console.log('即将进入：' + target);
                }
            }

            [bg, text, icon].forEach(function (el) {
                if (!el) return;
                el.style.cursor = 'pointer';
                el.addEventListener('mouseenter', hover);
                el.addEventListener('mouseleave', leave);
                el.addEventListener('mousedown', down);
                el.addEventListener('mouseup', up);
            });
            bg.addEventListener('click', onClick);
        });
    }

    function extractUrlFromText(text) {
        if (!text) return '';
        const match = text.match(/https?:\/\/[^\s\n]+/i);
        return match ? match[0] : text.trim();
    }

    // ===================== 链接输入框：粘贴取 URL、禁止换行、浅蓝色样式 =====================
    function setupLinkInput() {
        const box = $('.v6_114');
        if (!box) return;

        box.setAttribute('contenteditable', 'true');
        box.style.whiteSpace = 'nowrap';
        box.style.overflow = 'hidden';
        box.style.textOverflow = 'ellipsis';
        box.style.paddingLeft = '55px';
        box.style.paddingRight = '16px';
        box.style.color = 'rgba(135, 206, 250, 0.95)';
        box.style.lineHeight = '59px';
        box.style.outline = 'none';

        // 禁止回车换行
        box.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
            }
        });

        // 粘贴时只保留链接，去掉换行
        box.addEventListener('paste', function (e) {
            e.preventDefault();
            let text = '';
            if (e.clipboardData) {
                text = e.clipboardData.getData('text/plain') || '';
            } else if (window.clipboardData) {
                text = window.clipboardData.getData('Text') || '';
            }
            text = extractUrlFromText(text).replace(/[\r\n]+/g, ' ').trim();
            document.execCommand('insertText', false, text);
        });

        // 输入时一旦出现换行立即清掉
        box.addEventListener('input', function () {
            if (box.innerText && box.innerText.indexOf('\n') !== -1) {
                box.innerText = box.innerText.replace(/\n/g, ' ').trim();
            }
            const placeholder = $('.v6_116');
            if (placeholder) {
                placeholder.style.display = box.textContent.trim() ? 'none' : 'block';
            }
        });
    }

    // ===================== 提取文案按钮交互 =====================
    function setupExtractButton() {
        let isExtracting = false;
        let pollTimer = null;

        function setExtractLoading(output, placeholder) {
            if (!output) return;
            output.classList.add('extract-loading');
            output.setAttribute('contenteditable', 'false');
            output.textContent = '正在提取文案，首次使用需加载模型，请稍候...';
            const overlay = document.createElement('div');
            overlay.className = 'extract-loading-overlay';
            overlay.innerHTML = '<div class="extract-loading-spinner"></div>' +
                '<div class="extract-loading-text">正在提取文案</div>';
            output.appendChild(overlay);
            if (placeholder) placeholder.style.display = 'none';
        }

        function clearExtractLoading(output, placeholder, showPlaceholder) {
            if (!output) return;
            output.classList.remove('extract-loading');
            output.setAttribute('contenteditable', 'true');
            const overlay = output.querySelector('.extract-loading-overlay');
            if (overlay) overlay.remove();
            if (placeholder) placeholder.style.display = showPlaceholder ? 'block' : 'none';
        }

        function finish(output, placeholder, message, keepPlaceholderHidden) {
            clearExtractLoading(output, placeholder, !keepPlaceholderHidden);
            if (output) output.textContent = message;
            isExtracting = false;
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
        }

        setupGradientButton('.v6_124', '.v6_123', function () {
            const input = $('.v6_114');
            const output = $('.v6_128');
            const placeholder = $('.v6_129');
            const raw = input ? input.textContent.trim() : '';
            const url = extractUrlFromText(raw);
            if (isExtracting) return;
            if (!url) {
                if (output) output.textContent = '请先粘贴视频链接或选择本地文件';
                if (placeholder) placeholder.style.display = 'none';
                return;
            }
            // 把提取到的真正链接写回输入框
            if (input && input.textContent.trim() !== url) {
                input.textContent = url;
            }
            const payload = { url: url };
            const cloudCheck = maybeAppendCloudParams(payload, true);
            if (!cloudCheck.ok) {
                finish(output, placeholder, cloudCheck.missing, false);
                return;
            }

            isExtracting = true;
            setExtractLoading(output, placeholder);

            nativeCall('extractFromLink', payload)
                .then(function (result) {
                    if (typeof result === 'string') {
                        try { result = JSON.parse(result); }
                        catch (e) { result = { error: result }; }
                    }
                    if (!result || result.error || !result.taskId) {
                        finish(output, placeholder, '提取失败：' + (result.error || '未知错误'), false);
                        return;
                    }

                    const taskId = result.taskId;
                    pollTimer = setInterval(function () {
                        nativeCall('checkExtractTask', { taskId: taskId })
                            .then(function (check) {
                                if (typeof check === 'string') {
                                    try { check = JSON.parse(check); }
                                    catch (e) { check = {}; }
                                }
                                if (!check || check.status === 'running') return;

                                if (pollTimer) {
                                    clearInterval(pollTimer);
                                    pollTimer = null;
                                }

                                if (check.status === 'done' && typeof check.text === 'string') {
                                    finish(output, placeholder, check.text, true);
                                } else {
                                    finish(output, placeholder, '提取失败：' + (check.error || '未知错误'), false);
                                }
                            })
                            .catch(function (e) {
                                console.error('checkExtractTask failed', e);
                                finish(output, placeholder, '提取失败，请检查链接或网络', false);
                            });
                    }, 800);
                })
                .catch(function (e) {
                    console.error('extractFromLink failed', e);
                    finish(output, placeholder, '提取失败，请检查链接或网络', false);
                });
        });
    }

    // ===================== 下一步按钮交互 =====================
    function setupNextButton() {
        setupGradientButton('.v6_132', '.v6_130', function () {
            const output = $('.v6_128');
            if (output) {
                const text = output.textContent.trim();
                const isPlaceholder = !text ||
                    text.indexOf('正在提取') === 0 ||
                    text.indexOf('提取失败') === 0 ||
                    text.indexOf('请先粘贴') === 0;
                if (!isPlaceholder) {
                    try { sessionStorage.setItem('vv_extracted_text', text); }
                    catch (e) {}
                }
            }
            navigateTo('ArticleRewrite.html');
        });
    }

    // ===================== ArticleRewrite 辅助函数 =====================
    function pickNearestLength(charCount) {
        const options = [100, 300, 500, 800, 1000];
        let nearest = 300;
        let minDiff = Infinity;
        options.forEach(function (v) {
            const d = Math.abs(v - charCount);
            if (d < minDiff) {
                minDiff = d;
                nearest = v;
            }
        });
        return String(nearest);
    }

    function setLengthDropdown(value) {
        const labelMap = { '100': '100字', '300': '300字', '500': '500字', '800': '800字', '1000': '1000字' };
        const textEl = $('.v2_200');
        if (textEl) {
            textEl.textContent = labelMap[value] || labelMap['300'];
            textEl.setAttribute('data-value', value);
        }
    }

    function setOutputLoading(box, placeholder, message, loadingClass) {
        if (box) {
            box.classList.add(loadingClass);
            box.setAttribute('contenteditable', 'false');
            box.textContent = message;
        }
        if (placeholder) placeholder.style.display = 'none';
    }

    function clearOutputLoading(box, loadingClass) {
        if (box) {
            box.classList.remove(loadingClass);
            box.setAttribute('contenteditable', 'true');
        }
    }

    function computeCharDiff(oldText, newText) {
        const a = Array.from(oldText);
        const b = Array.from(newText);
        const n = a.length;
        const m = b.length;
        const dp = Array(n + 1).fill(null).map(function () { return Array(m + 1).fill(0); });
        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                if (a[i - 1] === b[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }
        const segments = [];
        let i = n, j = m;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
                segments.push({ type: 'same', text: a[i - 1] });
                i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                segments.push({ type: 'ins', text: b[j - 1] });
                j--;
            } else if (i > 0) {
                segments.push({ type: 'del', text: a[i - 1] });
                i--;
            } else {
                break;
            }
        }
        segments.reverse();
        const merged = [];
        segments.forEach(function (seg) {
            const last = merged[merged.length - 1];
            if (last && last.type === seg.type) {
                last.text += seg.text;
            } else {
                merged.push({ type: seg.type, text: seg.text });
            }
        });
        return merged;
    }

    function renderLegalDiff(oldText, newText) {
        const outputBox = $('.v2_181');
        if (!outputBox) return;
        outputBox.innerHTML = '';
        const segments = computeCharDiff(oldText || '', newText || '');
        let changeCount = 0;
        segments.forEach(function (seg, idx) {
            if (seg.type === 'ins') {
                const ins = document.createElement('ins');
                ins.className = 'ai-legal-ins';
                ins.textContent = seg.text;
                outputBox.appendChild(ins);
                if (idx === 0 || segments[idx - 1].type !== 'del') changeCount++;
            } else if (seg.type === 'del') {
                const del = document.createElement('del');
                del.className = 'ai-legal-del';
                del.textContent = seg.text;
                outputBox.appendChild(del);
                changeCount++;
            } else {
                outputBox.appendChild(document.createTextNode(seg.text));
            }
        });
        outputBox.setAttribute('data-legal-status',
            changeCount > 0 ? 'AI 法务已检查，共修改 ' + changeCount + ' 处' : 'AI 法务检查完成，未发现明显风险');
    }

    function clearLegalStatus() {
        const outputBox = $('.v2_181');
        if (outputBox) outputBox.removeAttribute('data-legal-status');
    }

    function updateAICheckButtonState() {
        const outputBox = $('.v2_181');
        const bg = $('.v2_209');
        const text = $('.v2_208');
        const hasText = outputBox && outputBox.textContent.trim().length > 0;
        if (bg) bg.classList.toggle('disabled', !hasText);
        if (text) text.classList.toggle('disabled', !hasText);
    }

    // ===================== 改写文案按钮交互 =====================
    function setupRewriteButton() {
        let isRewriting = false;
        let pollTimer = null;

        function finish(outputBox, placeholder, message, keepPlaceholderHidden) {
            clearOutputLoading(outputBox, 'rewrite-loading');
            clearLegalStatus();
            if (outputBox) outputBox.textContent = message;
            if (placeholder) placeholder.style.display = keepPlaceholderHidden ? 'none' : 'block';
            isRewriting = false;
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            updateAICheckButtonState();
        }

        setupGradientButton('.v2_205', '.v2_204', function () {
            const input = $('.v2_189');
            const outputBox = $('.v2_181');
            const placeholder = $('.v2_182');
            const text = input ? input.textContent.trim() : '';

            if (!text) {
                if (outputBox) outputBox.textContent = '请先输入原文案';
                if (placeholder) placeholder.style.display = 'none';
                return;
            }
            if (isRewriting) return;

            const styleEl = $('.v2_195');
            const lengthEl = $('.v2_200');
            const style = styleEl ? (styleEl.getAttribute('data-value') || 'default') : 'default';
            const length = lengthEl ? (lengthEl.getAttribute('data-value') || '300') : '300';

            const payload = { text: text, style: style, length: length };
            const cloudCheck = maybeAppendCloudParams(payload, true);
            if (!cloudCheck.ok) {
                finish(outputBox, placeholder, cloudCheck.missing, false);
                return;
            }

            isRewriting = true;
            clearLegalStatus();
            setOutputLoading(outputBox, placeholder, '正在改写文案，请稍候...', 'rewrite-loading');

            nativeCall('rewriteText', payload)
                .then(function (result) {
                    if (typeof result === 'string') {
                        try { result = JSON.parse(result); }
                        catch (e) { result = { error: result }; }
                    }
                    if (!result || result.error || !result.taskId) {
                        finish(outputBox, placeholder, '改写失败：' + (result.error || '未知错误'), false);
                        return;
                    }

                    const taskId = result.taskId;
                    pollTimer = setInterval(function () {
                        nativeCall('checkRewriteTask', { taskId: taskId })
                            .then(function (check) {
                                if (typeof check === 'string') {
                                    try { check = JSON.parse(check); }
                                    catch (e) { check = {}; }
                                }
                                if (!check || check.status === 'running') return;

                                if (pollTimer) {
                                    clearInterval(pollTimer);
                                    pollTimer = null;
                                }

                                if (check.status === 'done' && typeof check.text === 'string') {
                                    finish(outputBox, placeholder, check.text, true);
                                } else {
                                    finish(outputBox, placeholder, '改写失败：' + (check.error || '未知错误'), false);
                                }
                            })
                            .catch(function (e) {
                                console.error('checkRewriteTask failed', e);
                                finish(outputBox, placeholder, '改写失败，请检查模型或配置', false);
                            });
                    }, 500);
                })
                .catch(function (e) {
                    console.error('rewriteText failed', e);
                    finish(outputBox, placeholder, '改写失败，请检查模型或配置', false);
                });
        });
    }

    // ===================== AI 法务检查按钮交互 =====================
    function setupAICheckButton() {
        const outputBox = $('.v2_181');
        if (outputBox) {
            outputBox.addEventListener('input', function () {
                updateAICheckButtonState();
                clearLegalStatus();
            });
        }
        updateAICheckButtonState();

        let isChecking = false;
        let pollTimer = null;

        function finish(outputBox, placeholder) {
            clearOutputLoading(outputBox, 'legal-loading');
            if (placeholder) placeholder.style.display = 'none';
            isChecking = false;
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            updateAICheckButtonState();
        }

        setupGradientButton('.v2_209', '.v2_208', function () {
            const bg = $('.v2_209');
            if (bg && bg.classList.contains('disabled')) return;

            const outputBox = $('.v2_181');
            const placeholder = $('.v2_182');
            const originalText = outputBox ? outputBox.textContent : '';
            const text = originalText.trim();

            if (!text) return;
            if (isChecking) return;

            const payload = { text: text };
            const cloudCheck = maybeAppendCloudParams(payload, true);
            if (!cloudCheck.ok) {
                finish(outputBox, placeholder);
                if (outputBox) outputBox.textContent = cloudCheck.missing;
                return;
            }

            isChecking = true;
            clearLegalStatus();
            setOutputLoading(outputBox, placeholder, 'AI 法务检查中，请稍候...', 'legal-loading');

            nativeCall('legalCheckText', payload)
                .then(function (result) {
                    if (typeof result === 'string') {
                        try { result = JSON.parse(result); }
                        catch (e) { result = { error: result }; }
                    }
                    if (!result || result.error || !result.taskId) {
                        finish(outputBox, placeholder);
                        if (outputBox) outputBox.textContent = '法务检查失败：' + (result.error || '未知错误');
                        return;
                    }

                    const taskId = result.taskId;
                    pollTimer = setInterval(function () {
                        nativeCall('checkRewriteTask', { taskId: taskId })
                            .then(function (check) {
                                if (typeof check === 'string') {
                                    try { check = JSON.parse(check); }
                                    catch (e) { check = {}; }
                                }
                                if (!check || check.status === 'running') return;

                                if (pollTimer) {
                                    clearInterval(pollTimer);
                                    pollTimer = null;
                                }

                                if (check.status === 'done' && typeof check.text === 'string') {
                                    finish(outputBox, placeholder);
                                    renderLegalDiff(originalText, check.text);
                                } else {
                                    finish(outputBox, placeholder);
                                    if (outputBox) outputBox.textContent = '法务检查失败：' + (check.error || '未知错误');
                                }
                            })
                            .catch(function (e) {
                                console.error('checkRewriteTask failed', e);
                                finish(outputBox, placeholder);
                                if (outputBox) outputBox.textContent = '法务检查失败，请检查模型或配置';
                            });
                    }, 500);
                })
                .catch(function (e) {
                    console.error('legalCheckText failed', e);
                    finish(outputBox, placeholder);
                    if (outputBox) outputBox.textContent = '法务检查失败，请检查模型或配置';
                });
        });
    }

    // ===================== 通用下拉框 =====================
    function setupDropdown(boxSelector, textSelector, labelSelector, options, onChange) {
        const box = $(boxSelector);
        const text = $(textSelector);
        const label = labelSelector ? $(labelSelector) : null;
        if (!box || !text) return;

        if (options && options.length && !text.getAttribute('data-value')) {
            const currentLabel = text.textContent.trim();
            const matched = options.find(function (opt) { return opt.label === currentLabel; });
            text.setAttribute('data-value', matched ? matched.value : options[0].value);
        }

        box.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease';

        box.addEventListener('mouseenter', function () {
            box.style.boxShadow = '0 0 0 1px rgba(219,112,255,0.5)';
        });
        box.addEventListener('mouseleave', function () {
            box.style.boxShadow = 'none';
        });
        box.addEventListener('mousedown', function () {
            box.style.transform = 'scale(0.98)';
        });
        box.addEventListener('mouseup', function () {
            box.style.transform = 'scale(1)';
        });

        let menu = null;
        function closeMenu() {
            if (menu) {
                menu.remove();
                menu = null;
            }
            document.removeEventListener('click', closeMenuOutside);
        }
        function closeMenuOutside(e) {
            if (menu && !menu.contains(e.target) && e.target !== box && e.target !== label) {
                closeMenu();
            }
        }
        function openMenu() {
            if (menu) { closeMenu(); return; }
            const rect = box.getBoundingClientRect();
            menu = document.createElement('div');
            menu.className = 'largui-dropdown-menu';
            menu.style.left = rect.left + 'px';
            menu.style.top = (rect.bottom + 4) + 'px';
            menu.style.minWidth = rect.width + 'px';

            const currentValue = text.getAttribute('data-value') || text.textContent;
            options.forEach(function (opt) {
                const item = document.createElement('div');
                item.className = 'largui-dropdown-item';
                if (opt.value === currentValue || opt.label === text.textContent) {
                    item.classList.add('selected');
                }
                item.textContent = opt.label;
                item.addEventListener('click', function (e) {
                    e.stopPropagation();
                    text.textContent = opt.label;
                    text.setAttribute('data-value', opt.value);
                    closeMenu();
                    if (typeof onChange === 'function') onChange(opt);
                });
                menu.appendChild(item);
            });
            document.body.appendChild(menu);
            setTimeout(function () {
                document.addEventListener('click', closeMenuOutside);
            }, 0);
        }

        box.addEventListener('click', openMenu);
        if (label) label.addEventListener('click', openMenu);
    }

    // ===================== ArticleRewrite 下拉框配置 =====================
    function setupArticleRewriteDropdowns() {
        // 默认文案写作提示词
        setupDropdown('.v2_194', '.v2_195', '.v2_197', [
            { value: 'default', label: '默认文案写作提示词' },
            { value: 'xiaohongshu', label: '小红书风格' },
            { value: 'douyin', label: '抖音风格' },
            { value: 'professional', label: '专业正式' },
            { value: 'humorous', label: '轻松幽默' }
        ], function (opt) {
            console.log('提示词切换为：', opt.label);
        });

        // 字数
        setupDropdown('.v2_198', '.v2_200', '.v2_199', [
            { value: '100', label: '100字' },
            { value: '300', label: '300字' },
            { value: '500', label: '500字' },
            { value: '800', label: '800字' },
            { value: '1000', label: '1000字' }
        ], function (opt) {
            console.log('字数切换为：', opt.label);
        });
    }

    // ===================== 快捷打开视频网站图标 =====================
    function setupWebsiteShortcuts() {
        const shortcuts = [
            { sel: '.v6_110', url: 'https://www.douyin.com/', name: '抖音' },
            { sel: '.v6_122', url: 'https://www.xiaohongshu.com/', name: '小红书' },
            { sel: '.v6_108', url: 'https://www.kuaishou.com/', name: '快手' }
        ];

        shortcuts.forEach(function (item) {
            const el = $(item.sel);
            if (!el) return;
            el.title = item.name;
            el.addEventListener('click', function () {
                nativeCall('openUrl', { url: item.url }).catch(function () {});
            });
        });
    }

    // ===================== VoiceGenerate 页面交互 =====================
    function setupVoiceGenerateWordCount() {
        const box = $('.v8_62');
        const counter = $('.v8_78');
        if (!box || !counter) return;

        function update() {
            const len = box.textContent.trim().length;
            counter.textContent = len + '/1500字';
        }

        box.addEventListener('input', update);
        update();
    }

    function setupVoiceGenerateDropdowns() {
        // 语言选择
        setupDropdown('.v8_71', '.v8_73', null, [
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' }
        ], function (opt) {
            console.log('语言切换为：', opt.label);
        });

        // 情绪类型
        setupDropdown('.v10_23', '.v10_35', null, [
            { value: 'happy', label: '高兴' },
            { value: 'sad', label: '悲伤' },
            { value: 'angry', label: '生气' },
            { value: 'calm', label: '平静' }
        ], function (opt) {
            console.log('情绪切换为：', opt.label);
        });

        // 云端模式下情绪区域遮罩
        if (!$('.vv-emotion-cloud-mask')) {
            const mask = document.createElement('div');
            mask.className = 'vv-emotion-cloud-mask';
            mask.textContent = '云端模式不可用';
            document.body.appendChild(mask);
        }

        // 云端模式下经典/快速模型遮罩
        if (!$('.vv-model-cloud-mask')) {
            const modelMask = document.createElement('div');
            modelMask.className = 'vv-model-cloud-mask';
            modelMask.textContent = '云端模式不可用';
            document.body.appendChild(modelMask);
        }
    }

    function setupTranslationToggle() {
        const box = $('.v8_75');
        const text = $('.v8_76');
        const inputBox = $('.v8_62');
        const placeholder = $('.v8_63');
        if (!box || !text || !inputBox) return;

        box.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease, background 0.2s ease';

        box.addEventListener('mouseenter', function () {
            box.style.boxShadow = '0 0 0 1px rgba(219,112,255,0.5)';
        });
        box.addEventListener('mouseleave', function () {
            box.style.boxShadow = 'none';
        });
        box.addEventListener('mousedown', function () {
            box.style.transform = 'scale(0.96)';
        });
        box.addEventListener('mouseup', function () {
            box.style.transform = 'scale(1)';
        });
        box.addEventListener('click', function () {
            const content = inputBox.textContent.trim();
            if (!content) {
                alert('请先输入需要翻译的文案');
                return;
            }

            const settings = getCloudSettings();
            if (!settings.enabled || !settings.dashscopeKey || !settings.workspaceId) {
                alert('翻译需要开启云端加速并填写 API Key 与业务空间 ID');
                return;
            }

            function finishLoading(error) {
                inputBox.classList.remove('translate-loading');
                inputBox.setAttribute('contenteditable', 'true');
                if (error) {
                    if (placeholder) placeholder.style.display = 'block';
                    console.error(error);
                }
            }

            inputBox.classList.add('translate-loading');
            inputBox.setAttribute('contenteditable', 'false');
            if (placeholder) placeholder.style.display = 'none';

            const payload = { text: content, mode: 'translate', target_lang: 'en' };
            maybeAppendCloudParams(payload, true);

            nativeCall('rewriteText', payload)
                .then(function (result) {
                    if (typeof result === 'string') {
                        try { result = JSON.parse(result); }
                        catch (e) { result = { error: result }; }
                    }
                    if (!result || result.error || !result.taskId) {
                        finishLoading('翻译失败：' + (result.error || '未知错误'));
                        return;
                    }

                    const taskId = result.taskId;
                    let pollTimer = null;
                    pollTimer = setInterval(function () {
                        nativeCall('checkRewriteTask', { taskId: taskId })
                            .then(function (check) {
                                if (typeof check === 'string') {
                                    try { check = JSON.parse(check); }
                                    catch (e) { check = {}; }
                                }
                                if (!check || check.status === 'running') return;

                                clearInterval(pollTimer);
                                pollTimer = null;

                                if (check.status === 'done' && typeof check.text === 'string') {
                                    inputBox.textContent = check.text;
                                    finishLoading('');
                                    try {
                                        inputBox.dispatchEvent(new Event('input'));
                                    } catch (e) {}
                                } else {
                                    finishLoading('翻译失败：' + (check.error || '未知错误'));
                                }
                            })
                            .catch(function (e) {
                                clearInterval(pollTimer);
                                finishLoading('翻译查询失败：' + e);
                            });
                    }, 500);
                })
                .catch(function (e) {
                    finishLoading('翻译请求失败：' + e);
                });
        });
    }

    function setupModelToggle() {
        const left = $('.v10_5');
        const right = $('.v10_8');
        const leftText = $('.v10_10');
        const rightText = $('.v10_12');
        if (!left || !right) return;

        function activate(isLeft) {
            document.body.setAttribute('data-voice-model', isLeft ? 'classic' : 'fast');
            if (isLeft) {
                left.style.background = 'linear-gradient(rgba(219,112,255,1), rgba(55,87,254,1))';
                right.style.background = 'rgba(30,33,44,1)';
                if (leftText) leftText.style.color = '#fff';
                if (rightText) rightText.style.color = 'rgba(255,255,255,0.7)';
            } else {
                right.style.background = 'linear-gradient(rgba(219,112,255,1), rgba(55,87,254,1))';
                left.style.background = 'rgba(30,33,44,1)';
                if (leftText) leftText.style.color = 'rgba(255,255,255,0.7)';
                if (rightText) rightText.style.color = '#fff';
            }
        }

        left.addEventListener('click', function () { activate(true); });
        right.addEventListener('click', function () { activate(false); });
        activate(false);
    }

    function setupSimilarityStepper() {
        const valueEl = $('.v10_29');
        const up = $('.v10_31');
        const down = $('.v10_33');
        if (!valueEl || !up || !down) return;

        let val = parseFloat(valueEl.textContent) || 0.3;
        function update() {
            valueEl.textContent = val.toFixed(1);
        }

        up.addEventListener('click', function () {
            val = Math.min(1.0, Math.round((val + 0.1) * 10) / 10);
            update();
        });
        down.addEventListener('click', function () {
            val = Math.max(0.0, Math.round((val - 0.1) * 10) / 10);
            update();
        });
    }

    function setVoiceControlDisabled(el, disabled) {
        if (!el) return;
        if (disabled) {
            el.classList.add('cloud-disabled');
            el.setAttribute('title', '云端加速下无效');
        } else {
            el.classList.remove('cloud-disabled');
            el.removeAttribute('title');
        }
    }

    function getVoiceUploadLabel() {
        const labels = document.querySelectorAll('.v10_4');
        for (let i = 0; i < labels.length; i++) {
            const prev = labels[i].previousElementSibling;
            if (prev && prev.classList && prev.classList.contains('v10_2')) {
                return labels[i];
            }
        }
        return null;
    }

    function updateVoiceCloudUI() {
        const cloud = isCloudEnabled();
        const uploadLabel = getVoiceUploadLabel();
        if (uploadLabel) {
            uploadLabel.textContent = cloud ? '上传我的音色' : '上传音色';
        }

        // 重新初始化音色下拉框，切换本地/云端选项
        const box = $('.v8_87');
        const text = $('.v8_90');
        if (box && text) {
            const newBox = box.cloneNode(true);
            const newText = text.cloneNode(true);
            newText.textContent = '';
            newText.removeAttribute('data-value');
            box.parentNode.replaceChild(newBox, box);
            text.parentNode.replaceChild(newText, text);
            setupVoiceNameDropdown();
        }

        // 禁用本地专用控件
        ['.v10_5', '.v10_8', '.v10_10', '.v10_12'].forEach(function (sel) {
            setVoiceControlDisabled($(sel), cloud);
        });
        ['.v10_23', '.v10_24', '.v10_26', '.v10_35'].forEach(function (sel) {
            setVoiceControlDisabled($(sel), cloud);
        });
        ['.v10_29', '.v10_31', '.v10_33'].forEach(function (sel) {
            setVoiceControlDisabled($(sel), cloud);
        });

        const emotionMask = $('.vv-emotion-cloud-mask');
        if (emotionMask) emotionMask.classList.toggle('visible', cloud);

        const modelMask = $('.vv-model-cloud-mask');
        if (modelMask) modelMask.classList.toggle('visible', cloud);
    }

    function setupVoiceFilePicker() {
        // 找到「上传音色」标签前面的 .v10_2 区域（页面中多个 .v10_2/.v10_4，按相邻关系定位）
        let el = null;
        let uploadLabel = null;
        const labels = document.querySelectorAll('.v10_4');
        for (let i = 0; i < labels.length; i++) {
            const label = labels[i];
            const prev = label.previousElementSibling;
            if (prev && prev.classList && prev.classList.contains('v10_2')) {
                el = prev;
                uploadLabel = label;
                break;
            }
        }
        if (!el || !uploadLabel) return;

        el.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease';
        el.style.cursor = 'pointer';
        el.addEventListener('mouseenter', function () {
            el.style.boxShadow = '0 0 0 1px rgba(219,112,255,0.5)';
        });
        el.addEventListener('mouseleave', function () {
            el.style.boxShadow = 'none';
        });
        el.addEventListener('mousedown', function () {
            el.style.transform = 'scale(0.98)';
        });
        el.addEventListener('mouseup', function () {
            el.style.transform = 'scale(1)';
        });

        el.addEventListener('click', function () {
            if (!isCloudEnabled()) {
                alert('上传自定义音色需开启「默认使用云端算力加成」');
                return;
            }
            nativeCall('pickFile', { filter: '音频文件 (*.wav;*.mp3;*.m4a)|*.wav;*.mp3;*.m4a' }).then(function (result) {
                if (result && result.path) {
                    const ext = result.path.split('.').pop().toLowerCase();
                    if (['wav', 'mp3', 'm4a'].indexOf(ext) === -1) {
                        alert('请选择 wav、mp3 或 m4a 格式的音频');
                        return;
                    }
                    const name = result.path.split(/[\\/]/).pop();
                    setCustomVoiceState(result.path, name);
                    // 刷新下拉框，让自定义音色被选中
                    setupVoiceNameDropdown();
                    const textEl = $('.v8_90');
                    if (textEl) {
                        textEl.textContent = name;
                        textEl.setAttribute('data-value', 'custom');
                    }
                    if (label) label.textContent = '已选音色：' + name;
                }
            }).catch(function (e) {
                console.error('pickFile failed', e);
            });
        });
    }

    function setupGenerateVoiceButton() {
        let isGenerating = false;
        let pollTimer = null;

        function getLanguage() {
            const el = $('.v8_73');
            const val = el ? (el.getAttribute('data-value') || 'zh') : 'zh';
            return val === 'en' ? 'English' : 'Chinese';
        }

        function getSpeaker() {
            const el = $('.v8_90');
            return el ? (el.getAttribute('data-value') || 'female-sales') : 'female-sales';
        }

        function getEmotion() {
            const el = $('.v10_35');
            return el ? (el.getAttribute('data-value') || 'happy') : 'happy';
        }

        function getModel() {
            return document.body.getAttribute('data-voice-model') || 'fast';
        }

        function getSpeed() {
            const el = $('.v10_19');
            if (!el) return 1.0;
            const val = parseFloat(el.textContent.replace(/x/g, '').trim());
            return isNaN(val) ? 1.0 : val;
        }

        function getEmotionIntensity() {
            const el = $('.v10_29');
            if (!el) return 0.5;
            const val = parseFloat(el.textContent.trim());
            return isNaN(val) ? 0.5 : val;
        }

        function setResultLoading(loading) {
            const box = $('.v10_44');
            const title = $('.v10_46');
            const sub = $('.v10_47');
            if (box) box.classList.toggle('voice-result-loading', loading);
            if (title) title.textContent = loading ? '正在生成声音，请稍候...' : (box && box.getAttribute('data-audio-path') ? '点击此处预览声音' : '声音生成的结果将显示在这里');
            if (sub) sub.textContent = loading ? 'AI 正在根据最终文案和声音配置合成音频' : '生成完成后，点击此处可预览声音，右侧按钮可打开文件位置';
        }

        function finish(success, audioPath, errorMsg) {
            clearInterval(pollTimer);
            pollTimer = null;
            isGenerating = false;
            setResultLoading(false);

            const box = $('.v10_44');
            const title = $('.v10_46');
            const sub = $('.v10_47');

            if (success && audioPath) {
                try { sessionStorage.setItem('vv_generated_audio', audioPath); } catch (e) {}
                if (box) {
                    box.setAttribute('data-audio-path', audioPath);
                    box.classList.add('voice-result-generated');
                }
                if (title) title.textContent = '点击此处预览声音';
                if (sub) sub.textContent = '已生成：' + audioPath.split(/[\\/]/).pop();
            } else {
                if (box) box.classList.remove('voice-result-generated');
                if (title) title.textContent = '声音生成失败';
                if (sub) sub.textContent = errorMsg || '请检查文案、模型或网络连接';
            }
        }

        setupGradientButton('.v10_37', '.v10_36', function () {
            if (isGenerating) return;

            const textBox = $('.v8_62');
            const text = textBox ? textBox.textContent.trim() : '';
            if (!text) {
                finish(false, null, '请先在“最终文案”区域输入要配音的文案');
                return;
            }

            isGenerating = true;
            setResultLoading(true);

            const payload = {
                text: text,
                speaker: getSpeaker(),
                model: getModel(),
                speed: getSpeed(),
                emotion: getEmotion(),
                emotion_intensity: getEmotionIntensity(),
                language: getLanguage()
            };

            const cloudSettings = getCloudSettings();
            if (cloudSettings.enabled) {
                if (!cloudSettings.dashscopeKey || !cloudSettings.workspaceId) {
                    finish(false, null, '请先在设置中填写阿里云百炼 API Key 与业务空间 ID');
                    return;
                }
                payload.use_cloud = true;
                payload.dashscope_key = cloudSettings.dashscopeKey;
                payload.workspace_id = cloudSettings.workspaceId;
                if (payload.speaker === 'custom') {
                    const custom = getCustomVoiceState();
                    if (!custom.sample) {
                        finish(false, null, '请先点击「上传我的音色」选择音频样本');
                        return;
                    }
                    payload.custom_voice_sample = custom.sample;
                }
            }

            nativeCall('generateVoice', payload)
                .then(function (result) {
                    if (typeof result === 'string') {
                        try { result = JSON.parse(result); }
                        catch (e) { result = { error: result }; }
                    }
                    if (!result || result.error || !result.taskId) {
                        finish(false, null, result.error || '启动生成失败', result.error_code);
                        return;
                    }

                    const taskId = result.taskId;
                    pollTimer = setInterval(function () {
                        nativeCall('checkVoiceTask', { taskId: taskId })
                            .then(function (check) {
                                if (typeof check === 'string') {
                                    try { check = JSON.parse(check); }
                                    catch (e) { check = {}; }
                                }
                                if (!check || check.status === 'running') {
                                    if (check && check.progress && typeof check.progress.message === 'string') {
                                        setResultLoading(true, check.progress.message);
                                    }
                                    return;
                                }
                                clearInterval(pollTimer);
                                pollTimer = null;

                                if (check.status === 'done' && typeof check.audio_path === 'string') {
                                    finish(true, check.audio_path, null);
                                } else {
                                    finish(false, null, check.error || '生成失败，请稍后重试');
                                }
                            })
                            .catch(function (e) {
                                console.error('checkVoiceTask failed', e);
                                finish(false, null, '查询生成结果失败');
                            });
                    }, 500);
                })
                .catch(function (e) {
                    console.error('generateVoice failed', e);
                    finish(false, null, '调用声音生成失败');
                });
        });
    }

    function setupVoiceGenerateNavButtons() {
        // 上一步 -> ArticleRewrite
        setupGradientButton('.v8_65', '.v8_52', function () {
            navigateTo('ArticleRewrite.html');
        });

        // 下一步 -> VideoGenerate
        setupGradientButton('.v8_66', '.v8_64', function () {
            navigateTo('VideoGernerate.html');
        });
    }

    function getVoiceNameOptions() {
        if (isCloudEnabled()) {
            const custom = getCustomVoiceState();
            const opts = getCloudVoiceSystemOptions().slice();
            if (custom.sample) {
                opts.push({ value: 'custom', label: custom.name || '我的音色' });
            } else {
                opts.push({ value: 'custom', label: '上传我的音色...' });
            }
            return opts;
        }
        return [
            { value: 'female-sales', label: '女-带货' },
            { value: 'female-gentle', label: '女-温柔' },
            { value: 'male-magnetic', label: '男-磁性' },
            { value: 'male-youth', label: '男-少年' }
        ];
    }

    function setupVoiceNameDropdown() {
        const options = getVoiceNameOptions();
        const textEl = $('.v8_90');
        if (textEl && !textEl.getAttribute('data-value')) {
            const first = options[0];
            textEl.textContent = first.label;
            textEl.setAttribute('data-value', first.value);
        }
        setupDropdown('.v8_87', '.v8_90', null, options, function (opt) {
            console.log('选择音色：', opt.label);
        });
    }

    function setupSpeedSlider() {
        const box = $('.v10_15');
        const valueText = $('.v10_19');
        if (!box || !valueText) return;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0.5';
        slider.max = '2.0';
        slider.step = '0.1';
        slider.value = '1.0';
        slider.className = 'largui-speed-slider';
        slider.style.position = 'absolute';
        slider.style.left = '10%';
        slider.style.bottom = '12px';
        slider.style.width = '80%';
        slider.style.zIndex = '10';
        box.appendChild(slider);

        function update() {
            valueText.textContent = parseFloat(slider.value).toFixed(2) + 'x';
        }
        slider.addEventListener('input', update);
        update();
    }

    function setupVoicePreviewButton() {
        const btn = $('.v8_83');
        if (!btn) return;

        btn.style.cursor = 'pointer';
        btn.style.transition = 'transform 0.1s ease, filter 0.2s ease, box-shadow 0.2s ease';

        btn.addEventListener('mouseenter', function () {
            btn.style.transform = 'scale(1.15)';
            btn.style.filter = 'brightness(1.35)';
            btn.style.boxShadow = '0 0 16px rgba(219,112,255,0.6)';
        });
        btn.addEventListener('mouseleave', function () {
            btn.style.transform = 'scale(1)';
            btn.style.filter = 'brightness(1)';
            btn.style.boxShadow = 'none';
        });
        btn.addEventListener('mousedown', function () {
            btn.style.transform = 'scale(0.92)';
        });
        btn.addEventListener('mouseup', function () {
            btn.style.transform = 'scale(1.15)';
        });
        btn.addEventListener('click', function () {
            console.log('播放音色试听');
        });
    }

    function loadVoiceText() {
        try {
            const text = sessionStorage.getItem('vv_voice_text');
            const fallback = sessionStorage.getItem('vv_voice_fallback_text');
            const box = $('.v8_62');
            const placeholder = $('.v8_63');
            if (text && text.trim()) {
                if (box) box.textContent = text;
                if (placeholder) placeholder.style.display = 'none';
            } else if (fallback && fallback.trim()) {
                if (box) box.textContent = fallback;
                if (placeholder) placeholder.style.display = 'none';
            }
            sessionStorage.removeItem('vv_voice_text');
            sessionStorage.removeItem('vv_voice_fallback_text');
        } catch (e) {
            console.error('load voice text failed', e);
        }
    }

    function setupVoiceResultPreview() {
        const box = $('.v10_44');
        if (!box) return;

        // 隐藏音频元素
        let audio = document.getElementById('voice-audio-player');
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = 'voice-audio-player';
            audio.style.display = 'none';
            document.body.appendChild(audio);
        }

        // 点击结果区预览/暂停
        box.addEventListener('click', function () {
            const path = box.getAttribute('data-audio-path');
            if (!path) return;
            const fileUrl = 'file:///' + path.replace(/\\/g, '/');
            if (audio.src !== fileUrl) {
                audio.src = fileUrl;
                audio.load();
            }
            if (audio.paused) {
                audio.play().catch(function (err) {
                    console.error('audio play failed', err);
                    // 若 WebView 禁止直接播放本地文件，则退回到系统默认播放器
                    nativeCall('openUrl', { url: fileUrl }).catch(function () {});
                });
            } else {
                audio.pause();
            }
        });

        // 打开文件位置按钮
        let openBtn = box.querySelector('.voice-open-location-btn');
        if (!openBtn) {
            openBtn = document.createElement('div');
            openBtn.className = 'voice-open-location-btn';
            openBtn.textContent = '打开位置';
            box.appendChild(openBtn);
            openBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                const path = box.getAttribute('data-audio-path');
                if (path) nativeCall('openFileLocation', { path: path });
            });
        }
    }

    function initVoiceGerneratePage() {
        setupStartNewTaskButton();
        setupInputs();
        loadVoiceText();
        setupVoiceGenerateWordCount();
        setupVoiceNameDropdown();
        setupVoicePreviewButton();
        setupSpeedSlider();
        setupSidebarInteractions();
        setupVoiceGenerateNavButtons();
        setupVoiceGenerateDropdowns();
        setupTranslationToggle();
        setupModelToggle();
        setupSimilarityStepper();
        setupVoiceFilePicker();
        setupGenerateVoiceButton();
        setupVoiceResultPreview();
        updateVoiceCloudUI();
    }

    // ===================== VideoGenerate 页面交互 =====================
    function getVideoWanStyle() {
        // 已去掉「云端说话风格」选项，固定使用 speech
        return 'speech';
    }

    function getVideoWanResolution() {
        const el = $('.vc-wan-resolution-text');
        return el ? (el.getAttribute('data-value') || '480P') : '480P';
    }

    function setupVideoGenerateDropdowns() {
        // 输出分辨率（已左移到原「云端说话风格」位置）
        if (!$('.vc-wan-resolution-wrap')) {
            const root = $('.v17_167');
            if (root) {
                const wrap = document.createElement('div');
                wrap.className = 'vc-wan-resolution-wrap';
                wrap.innerHTML =
                    '<span class="vc-wan-resolution-label">输出分辨率</span>' +
                    '<div class="vc-wan-resolution-box">' +
                        '<span class="vc-wan-resolution-text">480P</span>' +
                        '<span class="vc-wan-resolution-arrow">&#9662;</span>' +
                    '</div>';
                root.appendChild(wrap);
            }
        }
        const savedResolution = (function () {
            try { return localStorage.getItem('vv_video_wan_resolution') || '480P'; }
            catch (e) { return '480P'; }
        })();
        const resolutionOptions = [
            { value: '480P', label: '480P（性价比高）' },
            { value: '720P', label: '720P（更清晰）' }
        ];
        const resolutionText = $('.vc-wan-resolution-text');
        if (resolutionText) {
            const initRes = resolutionOptions.find(function (o) { return o.value === savedResolution; }) || resolutionOptions[0];
            resolutionText.textContent = initRes.label;
            resolutionText.setAttribute('data-value', initRes.value);
        }
        setupDropdown('.vc-wan-resolution-box', '.vc-wan-resolution-text', '.vc-wan-resolution-label', resolutionOptions, function (opt) {
            try { localStorage.setItem('vv_video_wan_resolution', opt.value); } catch (e) {}
        });

        // 选择形象（带缩略图）
        setupAvatarSelector();
    }

    function setupAvatarSelector() {
        const box = $('.v17_133');
        const label = $('.v17_139');
        const thumb = $('.video-avatar-thumb');
        const uploadBtn = $('.video-upload-avatar-btn');
        if (!box) return;

        const samplePath = './thumbs/';
        const samples = [
            { value: 'sample1', label: '中年男士', thumb: samplePath + 'sample1.jpg' },
            { value: 'sample2', label: '绿幕示例', thumb: samplePath + 'sample2.jpg' },
            { value: 'sample3', label: '夜间示例', thumb: samplePath + 'sample3.jpg' }
        ];

        function loadUserAvatars() {
            try {
                const raw = sessionStorage.getItem('vv_user_avatars');
                return raw ? JSON.parse(raw) : [];
            } catch (e) { return []; }
        }
        function saveUserAvatars(list) {
            try { sessionStorage.setItem('vv_user_avatars', JSON.stringify(list)); } catch (e) {}
        }
        function getAllOptions() {
            return samples.concat(loadUserAvatars());
        }
        function thumbUrl(opt) {
            return opt.thumb || (opt.path ? 'file:///' + opt.path.replace(/\\/g, '/') : '');
        }
        function selectAvatar(opt) {
            document.body.setAttribute('data-selected-avatar', opt.value);
            document.body.setAttribute('data-selected-avatar-path', opt.path || opt.thumb);
            try { sessionStorage.setItem('vv_selected_avatar', JSON.stringify(opt)); } catch (e) {}
            if (label) label.textContent = opt.label;
            if (thumb) {
                thumb.src = thumbUrl(opt);
                thumb.style.display = 'block';
            }
        }

        const saved = (function () {
            try { return sessionStorage.getItem('vv_selected_avatar'); } catch (e) { return null; }
        })();
        if (saved) {
            try { selectAvatar(JSON.parse(saved)); } catch (e) { selectAvatar(samples[0]); }
        } else {
            selectAvatar(samples[0]);
        }

        if (uploadBtn) {
            uploadBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                nativeCall('pickFile').then(function (result) {
                    if (!result || !result.path) return;
                    const ext = result.path.split('.').pop().toLowerCase();
                    if (['jpg', 'jpeg', 'png'].indexOf(ext) === -1) {
                        alert('请选择 jpg 或 png 格式的图片');
                        return;
                    }
                    const uuid = 'user_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
                    const targetPath = 'temp/avatars/' + uuid + '/image.png';
                    const avatar = {
                        value: uuid,
                        label: '我的形象' + (loadUserAvatars().length + 1),
                        path: result.path,
                        targetPath: targetPath,
                        thumb: 'file:///' + result.path.replace(/\\/g, '/')
                    };
                    const list = loadUserAvatars();
                    list.push(avatar);
                    saveUserAvatars(list);
                    selectAvatar(avatar);
                }).catch(function (e) { console.error('pickFile failed', e); });
            });
        }

        let menu = null;
        function closeMenu() {
            if (menu) { menu.remove(); menu = null; }
            document.removeEventListener('click', closeMenuOutside);
        }
        function closeMenuOutside(e) {
            if (menu && !menu.contains(e.target) && e.target !== box && e.target !== label && !box.contains(e.target)) {
                closeMenu();
            }
        }
        function openMenu() {
            if (menu) { closeMenu(); return; }
            const rect = box.getBoundingClientRect();
            menu = document.createElement('div');
            menu.className = 'largui-avatar-dropdown';
            menu.style.left = rect.left + 'px';
            menu.style.top = (rect.bottom + 4) + 'px';
            menu.style.width = rect.width + 'px';

            const currentValue = document.body.getAttribute('data-selected-avatar');
            getAllOptions().forEach(function (opt) {
                const item = document.createElement('div');
                item.className = 'largui-avatar-item';
                if (opt.value === currentValue) item.classList.add('selected');
                const img = document.createElement('img');
                img.src = thumbUrl(opt);
                img.alt = opt.label;
                const span = document.createElement('span');
                span.textContent = opt.label;
                item.appendChild(img);
                item.appendChild(span);
                item.addEventListener('click', function (e) {
                    e.stopPropagation();
                    selectAvatar(opt);
                    closeMenu();
                });
                menu.appendChild(item);
            });
            document.body.appendChild(menu);
            setTimeout(function () { document.addEventListener('click', closeMenuOutside); }, 0);
        }
        box.addEventListener('click', openMenu);
        if (label) label.addEventListener('click', openMenu);
    }

    function setupShotModeToggle() {
        const left = $('.v17_123');
        const leftText = $('.v17_125');
        if (!left) return;

        left.style.background = 'linear-gradient(rgba(219,112,255,1), rgba(55,87,254,1))';
        if (leftText) leftText.style.color = '#fff';
        document.body.setAttribute('data-shot-mode', 'single');
    }

    function setupVideoGenerateFilePickers() {
        const areas = [{ sel: '.v17_150', status: '.v17_151' }];

        areas.forEach(function (item) {
            const el = $(item.sel);
            if (!el) return;

            el.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease';
            el.addEventListener('mouseenter', function () {
                el.style.boxShadow = '0 0 0 1px rgba(219,112,255,0.5)';
            });
            el.addEventListener('mouseleave', function () {
                el.style.boxShadow = 'none';
            });
            el.addEventListener('mousedown', function () {
                el.style.transform = 'scale(0.98)';
            });
            el.addEventListener('mouseup', function () {
                el.style.transform = 'scale(1)';
            });

            el.addEventListener('click', function () {
                nativeCall('pickFile').then(function (result) {
                    if (result && result.path) {
                        const fileName = result.path.split(/[\\/]/).pop();
                        const status = $(item.status);
                        if (status) status.textContent = fileName;
                        document.body.setAttribute('data-generated-audio', result.path);
                        try { sessionStorage.setItem('vv_generated_audio', result.path); } catch (e) {}
                    }
                }).catch(function (e) {
                    console.error('pickFile failed', e);
                });
            });
        });
    }

    function formatDuration(seconds) {
        if (!seconds || seconds <= 0 || !isFinite(seconds)) return '--:--';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    function openCloudCostModal(estimate, onConfirm, onCancel) {
        const overlay = document.createElement('div');
        overlay.className = 'vv-cost-modal-overlay';
        overlay.innerHTML =
            '<div class="vv-cost-modal-card">' +
                '<div class="vv-cost-modal-inner">' +
                    '<div class="vv-cost-modal-header">' +
                        '<div class="vv-cost-modal-title">云端生成费用确认</div>' +
                        '<button class="vv-cost-modal-close" aria-label="关闭">&times;</button>' +
                    '</div>' +
                    '<div class="vv-cost-rows">' +
                        '<div class="vv-cost-row"><span class="vv-cost-row-label">驱动音频时长</span><span class="vv-cost-row-value" id="vv-cost-duration"></span></div>' +
                        '<div class="vv-cost-row"><span class="vv-cost-row-label">输出分辨率</span><span class="vv-cost-row-value" id="vv-cost-resolution"></span></div>' +
                        '<div class="vv-cost-row"><span class="vv-cost-row-label">预计分段数</span><span class="vv-cost-row-value" id="vv-cost-chunks"></span></div>' +
                    '</div>' +
                    '<div class="vv-cost-divider"></div>' +
                    '<div class="vv-cost-total">' +
                        '<span class="vv-cost-total-label">预计消耗额度费用</span>' +
                        '<div><span class="vv-cost-total-price" id="vv-cost-price"></span><span class="vv-cost-total-unit">元</span></div>' +
                    '</div>' +
                    '<div class="vv-cost-warning" id="vv-cost-warning"></div>' +
                    '<div class="vv-cost-modal-footer">' +
                        '<button class="vv-cost-btn vv-cost-btn-secondary" id="vv-cost-cancel">取消</button>' +
                        '<button class="vv-cost-btn vv-cost-btn-primary" id="vv-cost-confirm">确认生成</button>' +
                    '</div>' +
                '</div>' +
            '</div>';

        document.body.appendChild(overlay);

        const durationEl = overlay.querySelector('#vv-cost-duration');
        const resolutionEl = overlay.querySelector('#vv-cost-resolution');
        const chunksEl = overlay.querySelector('#vv-cost-chunks');
        const priceEl = overlay.querySelector('#vv-cost-price');
        const warningEl = overlay.querySelector('#vv-cost-warning');

        durationEl.textContent = estimate.duration > 0 ? formatDuration(estimate.duration) : '无法获取';
        resolutionEl.textContent = estimate.resolutionLabel || estimate.resolution;
        chunksEl.textContent = estimate.chunks > 0 ? estimate.chunks + ' 段' : '无法预估';
        priceEl.textContent = estimate.cost > 0 ? estimate.cost.toFixed(2) : estimate.duration > 0 ? '0.00' : '无法预估';

        warningEl.innerHTML =
            '请确保阿里云百炼可用额度充足。云端数字人视频按<strong>输出秒数</strong>计费，每段 ≤20 秒单独扣费；' +
            '若账户额度不足导致中断，已生成的片段会自动拼接为部分视频返回（仍按实际生成秒数计费）。';

        function close() {
            overlay.remove();
        }

        overlay.querySelector('.vv-cost-modal-close').addEventListener('click', function () {
            close();
            if (onCancel) onCancel();
        });
        overlay.querySelector('#vv-cost-cancel').addEventListener('click', function () {
            close();
            if (onCancel) onCancel();
        });
        overlay.querySelector('#vv-cost-confirm').addEventListener('click', function () {
            close();
            if (onConfirm) onConfirm();
        });
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) {
                close();
                if (onCancel) onCancel();
            }
        });
    }

    function setupGenerateVideoButton() {
        let isGenerating = false;
        let pollTimer = null;
        let usedCloud = false;

        function getVideoProgressOverlay() {
            const preview = $('.v17_143');
            if (!preview) return null;
            return preview.querySelector('.vv-video-progress-overlay');
        }

        function setVideoProgressVisible(visible) {
            const overlay = getVideoProgressOverlay();
            if (!overlay) return;
            if (visible) {
                overlay.style.display = 'flex';
                void overlay.offsetWidth;
                overlay.classList.add('visible');
            } else {
                overlay.classList.remove('visible');
                setTimeout(function () {
                    if (!overlay.classList.contains('visible')) overlay.style.display = 'none';
                }, 350);
            }
        }

        function updateVideoProgress(percent, message) {
            const overlay = getVideoProgressOverlay();
            if (!overlay) return;
            if (typeof percent !== 'number' || !isFinite(percent)) percent = 0;
            percent = Math.max(0, Math.min(100, Math.round(percent)));
            overlay.setAttribute('data-progress', String(percent));
            const ring = overlay.querySelector('.vv-video-progress-ring');
            if (ring) ring.style.setProperty('--vv-progress', String(percent));
            const percentEl = overlay.querySelector('.vv-video-progress-percent');
            if (percentEl) percentEl.textContent = percent + '%';
            const fill = overlay.querySelector('.vv-video-progress-linear-fill');
            if (fill) fill.style.width = percent + '%';
            const msgEl = overlay.querySelector('.vv-video-progress-message');
            if (msgEl) msgEl.textContent = message || '正在生成视频...';
        }

        function setLoading(loading, message) {
            const preview = $('.v17_143');
            const title = $('.v17_145');
            const sub = $('.v17_146');
            if (preview) preview.classList.toggle('video-result-loading', loading);
            if (title) title.textContent = loading ? (message || '正在生成视频，请稍候...') : '暂无预览视频';
            if (sub) sub.textContent = loading ? (usedCloud ? '云端正在生成，请稍候...' : 'AI 正在根据声音与形象配置合成视频') : '生成的视频会在此处显示预览';
            if (loading) {
                setVideoProgressVisible(true);
                updateVideoProgress(0, message || (usedCloud ? '正在连接云端算力...' : '正在生成视频，请稍候...'));
            } else {
                setVideoProgressVisible(false);
            }
        }

        function finish(success, videoPath, errorMsg, errorCode, posterPath, warning) {
            clearInterval(pollTimer);
            pollTimer = null;
            isGenerating = false;
            setVideoProgressVisible(false);

            const preview = $('.v17_143');
            const title = $('.v17_145');
            const sub = $('.v17_146');
            const player = $('.video-preview-player');

            if (preview) preview.classList.remove('video-result-loading');
            if (success && videoPath) {
                try { sessionStorage.setItem('vv_generated_video', videoPath); } catch (e) {}
                document.body.setAttribute('data-generated-video', videoPath);
                if (preview) {
                    preview.setAttribute('data-video-path', videoPath);
                    preview.classList.add('video-result-generated');
                }
                if (warning) {
                    if (title) title.textContent = '视频生成未完成';
                    if (sub) sub.textContent = warning;
                } else {
                    if (title) title.textContent = '视频生成完成';
                    if (sub) sub.textContent = '已生成：' + videoPath.split(/[\\/]/).pop();
                }
                if (player) {
                    player.src = 'file:///' + videoPath.replace(/\\/g, '/');
                    player.style.display = 'block';
                    player.load();
                }
            } else {
                if (preview) preview.classList.remove('video-result-generated');
                if (title) title.textContent = '视频生成失败';
                if (sub) sub.textContent = errorMsg || '请检查声音、形象或模型配置';
                if (player) player.style.display = 'none';

                if (usedCloud) {
                    const code = errorCode || '';
                    if (code === 'INSUFFICIENT_BALANCE') {
                        if (confirm('阿里云百炼账户额度不足，是否前往控制台充值？')) {
                            nativeCall('openUrl', { url: 'https://dashscope.console.aliyun.com/' }).catch(function () {});
                        }
                    } else if (code === 'AUTH_FAILED') {
                        if (confirm('API Key 无效或已过期，是否打开设置重新填写？')) {
                            openSettingsModal();
                        }
                    } else if (code === 'NETWORK_ERROR' || code === 'POLL_TIMEOUT') {
                        alert(errorMsg || '网络连接失败，请检查网络后重试。');
                    } else if (code === 'INVALID_INPUT' || code === 'CONTENT_MODERATION') {
                        alert(errorMsg || '图片或音频不符合要求，请更换素材。');
                    } else if (code === 'DOWNLOAD_FAILED' || code === 'TASK_FAILED' || code === 'UNKNOWN_ERROR') {
                        if (confirm((errorMsg || '云端生成失败') + '，是否改用本地算力重试？')) {
                            usedCloud = false;
                            startGenerate(false, true);
                            return;
                        }
                    } else {
                        if (confirm('云端生成失败，是否改用本地算力重试？')) {
                            usedCloud = false;
                            startGenerate(false, true);
                            return;
                        }
                    }
                }
            }
        }

        function startGenerate(useCloud, isRetry) {
            if (isGenerating) return;

            let audioPath = document.body.getAttribute('data-generated-audio') || '';
            if (!audioPath) {
                try { audioPath = sessionStorage.getItem('vv_generated_audio') || ''; } catch (e) {}
            }
            const avatarOpt = (function () {
                try { return JSON.parse(sessionStorage.getItem('vv_selected_avatar') || '{}'); }
                catch (e) { return {}; }
            })();
            const wanStyle = getVideoWanStyle();
            const wanResolution = getVideoWanResolution();

            if (!audioPath || /未选取|点击选取/.test(audioPath) || !/\.(wav|mp3|m4a|aac|flac|ogg|wma)$/i.test(audioPath)) {
                finish(false, null, '请先选择驱动音频');
                return;
            }
            if (!avatarOpt.value) {
                finish(false, null, '请先选择形象');
                return;
            }

            const settings = getCloudSettings();
            const dashscopeKey = settings.dashscopeKey || '';

            isGenerating = true;
            usedCloud = useCloud;
            setLoading(true, useCloud ? '正在连接云端算力...' : '正在生成视频，请稍候...');

            const payload = {
                audio_path: audioPath,
                avatar_value: avatarOpt.value,
                avatar_path: avatarOpt.path || avatarOpt.thumb,
                avatar_target_path: avatarOpt.targetPath || '',
                shot_mode: 'single',
                wan_style: wanStyle,
                wan_resolution: wanResolution
            };

            if (useCloud) {
                payload.use_cloud = true;
                payload.dashscope_key = dashscopeKey;
            }

            nativeCall('generateVideo', payload)
                .then(function (result) {
                    if (typeof result === 'string') {
                        try { result = JSON.parse(result); }
                        catch (e) { result = { error: result }; }
                    }
                    if (!result || result.error || !result.taskId) {
                        finish(false, null, result.error || '启动生成失败');
                        return;
                    }
                    const taskId = result.taskId;
                    pollTimer = setInterval(function () {
                        nativeCall('checkVideoTask', { taskId: taskId })
                            .then(function (check) {
                                if (typeof check === 'string') {
                                    try { check = JSON.parse(check); }
                                    catch (e) { check = {}; }
                                }
                                if (!check || check.status === 'running') {
                                    if (check && check.progress && typeof check.progress.message === 'string') {
                                        const title = $('.v17_145');
                                        const sub = $('.v17_146');
                                        if (title) title.textContent = check.progress.message;
                                        if (sub && typeof check.progress.percent === 'number') {
                                            sub.textContent = '进度：' + check.progress.percent + '%';
                                        }
                                        updateVideoProgress(check.progress.percent, check.progress.message);
                                    }
                                    return;
                                }
                                clearInterval(pollTimer);
                                pollTimer = null;
                                if (check.status === 'done' && typeof check.video_path === 'string') {
                                    finish(true, check.video_path, null, null, check.poster_path, check.warning);
                                } else {
                                    finish(false, null, check.error || '生成失败，请稍后重试', check.error_code);
                                }
                            })
                            .catch(function (e) {
                                console.error('checkVideoTask failed', e);
                                finish(false, null, '查询生成结果失败', 'NETWORK_ERROR');
                            });
                    }, 500);
                })
                .catch(function (e) {
                    console.error('generateVideo failed', e);
                    finish(false, null, '调用视频生成失败');
                });
        }

        function preparePayload() {
            let audioPath = document.body.getAttribute('data-generated-audio') || '';
            if (!audioPath) {
                try { audioPath = sessionStorage.getItem('vv_generated_audio') || ''; } catch (e) {}
            }
            const avatarOpt = (function () {
                try { return JSON.parse(sessionStorage.getItem('vv_selected_avatar') || '{}'); }
                catch (e) { return {}; }
            })();
            return { audioPath: audioPath, avatarOpt: avatarOpt, wanStyle: getVideoWanStyle(), wanResolution: getVideoWanResolution() };
        }

        function validateInputs(payload) {
            const audioPath = payload.audioPath;
            if (!audioPath || /未选取|点击选取/.test(audioPath) || !/\.(wav|mp3|m4a|aac|flac|ogg|wma)$/i.test(audioPath)) {
                return '请先选择驱动音频';
            }
            if (!payload.avatarOpt.value) {
                return '请先选择形象';
            }
            return '';
        }

        setupGradientButton('.v17_141', '.v17_140', function () {
            const settings = getCloudSettings();
            const useCloud = settings.enabled && !!settings.dashscopeKey;
            if (!useCloud) {
                startGenerate(false, false);
                return;
            }

            const payload = preparePayload();
            const err = validateInputs(payload);
            if (err) {
                finish(false, null, err);
                return;
            }

            console.log('[getAudioDuration] request path:', payload.audioPath);
            nativeCall('getAudioDuration', { path: payload.audioPath })
                .then(function (result) {
                    console.log('[getAudioDuration] response:', result);
                    if (typeof result === 'string') {
                        try { result = JSON.parse(result); } catch (e) { result = {}; }
                    }
                    const duration = (result && typeof result.duration === 'number' && result.duration > 0) ? result.duration : 0;
                    const pricePerSecond = payload.wanResolution === '720P' ? 0.9 : 0.5;
                    const chunks = duration > 0 ? Math.ceil(duration / 20) : 0;
                    const cost = duration > 0 ? duration * pricePerSecond : 0;
                    const resolutionLabelMap = { '480P': '480P（性价比高）', '720P': '720P（更清晰）' };

                    openCloudCostModal(
                        {
                            duration: duration,
                            resolution: payload.wanResolution,
                            resolutionLabel: resolutionLabelMap[payload.wanResolution] || payload.wanResolution,
                            chunks: chunks,
                            cost: cost
                        },
                        function () {
                            startGenerate(true, false);
                        },
                        function () {
                            // user cancelled
                        }
                    );
                })
                .catch(function (e) {
                    console.error('getAudioDuration failed', e);
                    openCloudCostModal(
                        { duration: 0, resolution: payload.wanResolution, resolutionLabel: payload.wanResolution, chunks: 0, cost: 0 },
                        function () { startGenerate(true, false); },
                        function () {}
                    );
                });
        });
    }

    function setupVideoGenerateNavButtons() {
        // 上一步 -> VoiceGenerate
        setupGradientButton('.v17_102', '.v17_98', function () {
            navigateTo('VoiceGernerate.html');
        });

        // 下一步 -> VideoCut
        setupGradientButton('.v17_103', '.v17_101', function () {
            navigateTo('VideoCut.html');
        });
    }

    function loadGeneratedAudio() {
        try {
            const audioPath = sessionStorage.getItem('vv_generated_audio');
            if (!audioPath) return;
            const status = $('.v17_151');
            if (status) status.textContent = audioPath.split(/[\\/]/).pop();
            document.body.setAttribute('data-generated-audio', audioPath);
        } catch (e) { console.error('load generated audio failed', e); }
    }

    function setupOpenVideoFileButton() {
        const btn = $('.video-open-file-btn');
        if (!btn) return;
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const preview = $('.v17_143');
            const path = preview ? preview.getAttribute('data-video-path') : null;
            if (path) nativeCall('openFileLocation', { path: path });
        });
    }

    function initVideoGerneratePage() {
        setupStartNewTaskButton();
        setupSidebarInteractions();
        setupVideoGenerateDropdowns();
        setupShotModeToggle();
        setupVideoGenerateFilePickers();
        setupGenerateVideoButton();
        setupVideoGenerateNavButtons();
        loadGeneratedAudio();
        setupOpenVideoFileButton();
    }

    // ===================== VideoCut 页面交互 =====================
    function setupVideoCutNavButtons() {
        // 上一步 -> VideoGenerate
        setupGradientButton('.v18_210', '.v18_208', function () {
            navigateTo('VideoGernerate.html');
        });

        // 下一步 -> BannerGenerate
        setupGradientButton('.v18_211', '.v18_209', function () {
            navigateTo('BannerGenerate.html');
        });
    }

    function updateVideoSourceDisplay(videoPath) {
        let nameBox = $('.vc-video-source-name');
        if (!nameBox) {
            nameBox = document.createElement('div');
            nameBox.className = 'vc-video-source-name';
            const ref = $('.v18_215');
            if (ref && ref.parentNode) ref.parentNode.appendChild(nameBox);
        }
        if (!nameBox) return;
        if (videoPath) {
            nameBox.textContent = videoPath.split(/[\\/]/).pop();
            nameBox.style.display = 'block';
        } else {
            nameBox.style.display = 'none';
        }
    }

    function setupVideoCutUploadButton() {
        const box = $('.v19_250');
        const text = $('.v19_251');
        if (!box) return;

        box.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease';
        box.addEventListener('mouseenter', function () { box.style.boxShadow = '0 0 0 1px rgba(219,112,255,0.5)'; });
        box.addEventListener('mouseleave', function () { box.style.boxShadow = 'none'; });
        box.addEventListener('mousedown', function () { box.style.transform = 'scale(0.96)'; });
        box.addEventListener('mouseup', function () { box.style.transform = 'scale(1)'; });

        box.addEventListener('click', function () {
            nativeCall('pickFile').then(function (result) {
                if (result && result.path && text) {
                    text.textContent = '已上传';
                    document.body.setAttribute('data-video-path', result.path);
                    try { sessionStorage.setItem('vv_generated_video', result.path); } catch (e) {}
                    updateVideoSourceDisplay(result.path);
                }
            }).catch(function (e) { console.error('pickFile failed', e); });
        });
    }

    function setupVideoCutTabs() {
        const items = ['.v19_269', '.v19_270', '.v19_275', '.v19_279'];
        const elements = items.map($).filter(Boolean);
        if (elements.length === 0) return;

        const tabNames = ['params', 'subtitle', 'bgm', 'soundfx'];

        const subtitleSelectors = [
            '.v19_296', '.v19_293', '.v19_295',
            '.v19_297', '.v19_299', '.v19_301', '.v19_302', '.v19_306', '.v19_307', '.v19_311', '.v19_312',
            '.v19_298', '.v19_300', '.v19_303', '.v19_304', '.v19_308', '.v19_309', '.v19_313', '.v19_314'
        ];

        function setButtonActive(index) {
            elements.forEach(function (el, i) {
                el.style.background = (i === index) ? 'rgba(43,52,87,1)' : 'rgba(43,52,87,0.2)';
            });
        }

        function createSlider(labelText, paramKey, min, max, step, value) {
            const row = document.createElement('div');
            row.className = 'vc-param-row';
            row.setAttribute('data-vc-param', paramKey);

            const header = document.createElement('div');
            header.className = 'vc-param-header';

            const label = document.createElement('div');
            label.className = 'vc-param-label';
            label.textContent = labelText;

            const valueBox = document.createElement('div');
            valueBox.className = 'vc-param-value';
            valueBox.textContent = value.toFixed(1);

            header.appendChild(label);
            header.appendChild(valueBox);

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.className = 'vc-slider';
            slider.min = min;
            slider.max = max;
            slider.step = step;
            slider.value = value;

            slider.addEventListener('input', function () {
                valueBox.textContent = parseFloat(slider.value).toFixed(1);
            });

            row.appendChild(header);
            row.appendChild(slider);
            return row;
        }

        function createSelect(labelText, paramKey, options) {
            const row = document.createElement('div');
            row.className = 'vc-param-row vc-toggle-row';
            row.setAttribute('data-vc-param', paramKey);

            const left = document.createElement('div');
            const label = document.createElement('div');
            label.className = 'vc-param-label';
            label.textContent = labelText;
            left.appendChild(label);

            const select = document.createElement('select');
            select.className = 'vc-select';
            options.forEach(function (opt) {
                const option = document.createElement('option');
                option.value = opt;
                option.textContent = opt;
                if (opt === '1.00x') option.selected = true;
                select.appendChild(option);
            });

            row.appendChild(left);
            row.appendChild(select);
            return row;
        }

        function createToggle(labelText, paramKey, desc) {
            const row = document.createElement('div');
            row.className = 'vc-param-row vc-toggle-row';
            row.setAttribute('data-vc-param', paramKey);

            const left = document.createElement('div');
            const label = document.createElement('div');
            label.className = 'vc-param-label';
            label.textContent = labelText;
            const description = document.createElement('div');
            description.className = 'vc-param-desc';
            description.textContent = desc;
            left.appendChild(label);
            left.appendChild(description);

            const toggle = document.createElement('div');
            toggle.className = 'vc-toggle active';
            const knob = document.createElement('div');
            knob.className = 'vc-toggle-knob';
            toggle.appendChild(knob);

            toggle.addEventListener('click', function () {
                toggle.classList.toggle('active');
            });

            row.appendChild(left);
            row.appendChild(toggle);
            return row;
        }

        function ensurePanel() {
            let panel = $('#vc-dynamic-panel');
            if (panel) return panel;

            panel = document.createElement('div');
            panel.id = 'vc-dynamic-panel';

            // 音视频参数
            const params = document.createElement('div');
            params.className = 'vc-tab-content';
            params.dataset.vcTab = 'params';

            const paramsTitle = document.createElement('div');
            paramsTitle.className = 'vc-panel-title';
            paramsTitle.textContent = '音视频参数';
            params.appendChild(paramsTitle);

            const paramsSubtitle = document.createElement('div');
            paramsSubtitle.className = 'vc-panel-subtitle';
            paramsSubtitle.textContent = '精细调整人声、BGM 与播放节奏';
            params.appendChild(paramsSubtitle);

            params.appendChild(createSlider('人声音量', 'voice_volume', 0.0, 5.0, 0.1, 1.0));
            params.appendChild(createSlider('BGM音量', 'bgm_volume', 0.0, 2.0, 0.1, 1.0));
            params.appendChild(createSelect('视频倍速', 'speed', ['0.75x', '1.00x', '1.25x', '1.50x', '1.75x', '2.00x']));
            params.appendChild(createToggle('剪气口', 'cut_breath', '自动移除静音片段，增强短视频节奏'));

            // 背景音乐
            const bgm = document.createElement('div');
            bgm.className = 'vc-tab-content';
            bgm.dataset.vcTab = 'bgm';

            const bgmTitle = document.createElement('div');
            bgmTitle.className = 'vc-panel-title';
            bgmTitle.textContent = '背景音乐';
            bgm.appendChild(bgmTitle);

            const bgmSubtitle = document.createElement('div');
            bgmSubtitle.className = 'vc-panel-subtitle';
            bgmSubtitle.textContent = '上传一段音乐作为视频背景音';
            bgm.appendChild(bgmSubtitle);

            const uploadCard = document.createElement('div');
            uploadCard.className = 'vc-upload-card';
            const uploadIcon = document.createElement('div');
            uploadIcon.className = 'vc-upload-icon';
            uploadIcon.textContent = '+';
            const uploadText = document.createElement('div');
            uploadText.className = 'vc-upload-text';
            uploadText.textContent = '点击上传背景音乐';
            const uploadHint = document.createElement('div');
            uploadHint.className = 'vc-upload-hint';
            uploadHint.textContent = '支持 MP3 / WAV / AAC 格式';
            uploadCard.appendChild(uploadIcon);
            uploadCard.appendChild(uploadText);
            uploadCard.appendChild(uploadHint);
            bgm.appendChild(uploadCard);

            const pathBox = document.createElement('div');
            pathBox.className = 'vc-path-box';
            pathBox.id = 'vc-bgm-path';
            pathBox.textContent = '未选择文件';
            bgm.appendChild(pathBox);

            uploadCard.addEventListener('click', function () {
                nativeCall('pickFile').then(function (result) {
                    if (result && result.path) {
                        pathBox.textContent = result.path;
                        pathBox.style.color = '#fff';
                    }
                }).catch(function (e) { console.error('pickFile failed', e); });
            });

            // 音效
            const fx = document.createElement('div');
            fx.className = 'vc-tab-content';
            fx.dataset.vcTab = 'soundfx';

            const fxCard = document.createElement('div');
            fxCard.className = 'vc-fx-card';
            const fxIcon = document.createElement('div');
            fxIcon.className = 'vc-fx-icon';
            fxIcon.textContent = '✨';
            const fxTitle = document.createElement('div');
            fxTitle.className = 'vc-fx-title';
            fxTitle.textContent = 'AI 音效已开启';
            const fxDesc = document.createElement('div');
            fxDesc.className = 'vc-fx-desc';
            fxDesc.textContent = '已开启AI音效 剪辑时会根据文案内容自动匹配合适音效';
            fxCard.appendChild(fxIcon);
            fxCard.appendChild(fxTitle);
            fxCard.appendChild(fxDesc);
            fx.appendChild(fxCard);

            panel.appendChild(params);
            panel.appendChild(bgm);
            panel.appendChild(fx);

            const root = $('.v19_332') || document.body;
            root.appendChild(panel);
            return panel;
        }

        function showTab(index) {
            const name = tabNames[index];
            if (name === 'subtitle') {
                const panel = $('#vc-dynamic-panel');
                if (panel) panel.style.display = 'none';
                subtitleSelectors.forEach(function (sel) {
                    const el = $(sel);
                    if (el) el.style.display = '';
                });
            } else {
                subtitleSelectors.forEach(function (sel) {
                    const el = $(sel);
                    if (el) el.style.display = 'none';
                });
                const panel = ensurePanel();
                panel.style.display = 'flex';
                $$('.vc-tab-content').forEach(function (content) {
                    if (content.dataset.vcTab === name) {
                        content.classList.add('active');
                    } else {
                        content.classList.remove('active');
                    }
                });
                const keyMap = {
                    'params': 'enable_params',
                    'subtitle': 'enable_subtitle',
                    'bgm': 'enable_bgm',
                    'soundfx': 'enable_soundfx'
                };
                const key = keyMap[name];
                if (key) updateCutToggleVisuals(key, getNavToggleState(key));
            }
        }

        elements.forEach(function (el, index) {
            el.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease, background 0.2s ease';
            el.addEventListener('mouseenter', function () { el.style.boxShadow = '0 0 0 1px rgba(219,112,255,0.5)'; });
            el.addEventListener('mouseleave', function () { el.style.boxShadow = 'none'; });
            el.addEventListener('mousedown', function () { el.style.transform = 'scale(0.98)'; });
            el.addEventListener('mouseup', function () { el.style.transform = 'scale(1)'; });
            el.addEventListener('click', function () {
                setButtonActive(index);
                showTab(index);
            });
        });

        setButtonActive(1); // 默认选中“字幕”
        showTab(1);
    }

    function setupSubtitleStyleSelection() {
        const items = ['.v19_297', '.v19_299', '.v19_301', '.v19_302', '.v19_306', '.v19_307', '.v19_311', '.v19_312'];
        const labelSelectors = ['.v19_298', '.v19_300', '.v19_303', '.v19_304', '.v19_308', '.v19_309', '.v19_313', '.v19_314'];
        const elements = items.map($).filter(Boolean);
        if (elements.length === 0) return;

        // 与 tools/video_cut.py 中 SUBTITLE_STYLES 一一对应，仅用于前端预览
        const styles = [
            { color: '#FFFFFF', stroke: '#000000', strokeWidth: 1.2, fontSize: 18, fontWeight: 700 },
            { color: '#FFE700', stroke: '#000000', strokeWidth: 1.2, fontSize: 18, fontWeight: 700 },
            { color: '#FFFFFF', stroke: '#000000', strokeWidth: 1.5, fontSize: 22, fontWeight: 700 },
            { color: '#FF9B8A', stroke: '#FFFFFF', strokeWidth: 1.2, fontSize: 18, fontWeight: 700 },
            { color: '#FFFFFF', stroke: '#1A1A1A', strokeWidth: 1.5, fontSize: 20, fontWeight: 700 },
            { color: '#A1E7FF', stroke: '#000000', strokeWidth: 1.2, fontSize: 18, fontWeight: 700 },
            { color: '#FFB400', stroke: '#FFFFFF', strokeWidth: 1.2, fontSize: 19, fontWeight: 700 },
            { color: '#FFFFFF', stroke: '#000000', strokeWidth: 1.0, fontSize: 16, fontWeight: 400 }
        ];

        function select(index) {
            elements.forEach(function (el, i) {
                el.style.boxShadow = (i === index) ? 'inset 0 0 0 2px rgba(219,112,255,1)' : 'none';
            });
            document.body.setAttribute('data-subtitle-style', String(index));
        }

        elements.forEach(function (el, index) {
            // 防止页面重新注入后重复创建预览，导致多个 auto-margin 元素把文字顶到顶部
            if (el.querySelector('.vc-subtitle-preview')) return;

            const style = styles[index] || styles[0];

            // 布局样式统一在 .vc-subtitle-box 中定义，避免 tab 切换时 display 被重置回 block
            el.classList.add('vc-subtitle-box');

            const preview = document.createElement('div');
            preview.className = 'vc-subtitle-preview';
            preview.textContent = '字幕样式';
            preview.style.cssText = [
                'color: ' + style.color,
                '-webkit-text-stroke: ' + style.strokeWidth + 'px ' + style.stroke,
                'text-shadow: 0 2px 4px rgba(0,0,0,0.45)',
                'font-size: ' + style.fontSize + 'px',
                'font-weight: ' + style.fontWeight,
                'font-family: "Microsoft YaHei", Inter, sans-serif',
                'text-align: center',
                'line-height: 1.2',
                'user-select: none',
                'pointer-events: none'
            ].join(';');

            el.appendChild(preview);

            // 标签保持在顶部，点击标签也能选中当前样式
            const label = $(labelSelectors[index]);
            if (label) {
                label.style.cursor = 'pointer';
                label.style.pointerEvents = 'auto';
                label.style.whiteSpace = 'nowrap';
                label.style.overflow = 'hidden';
                label.style.textOverflow = 'ellipsis';
                label.addEventListener('click', function () { select(index); });
            }

            el.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease';
            el.addEventListener('mouseenter', function () { el.style.transform = 'scale(1.03)'; });
            el.addEventListener('mouseleave', function () { el.style.transform = 'scale(1)'; });
            el.addEventListener('mousedown', function () { el.style.transform = 'scale(0.97)'; });
            el.addEventListener('mouseup', function () { el.style.transform = 'scale(1.03)'; });
            el.addEventListener('click', function () { select(index); });
        });

        select(0);
    }

    function setupHighlightToggle() {
        const icon = $('.v19_293');
        const label = $('.v19_295');
        if (!icon) return;

        let active = true;

        function update() {
            if (active) {
                icon.classList.add('checked');
                icon.classList.remove('unchecked');
            } else {
                icon.classList.add('unchecked');
                icon.classList.remove('checked');
            }
        }

        function toggle() {
            active = !active;
            update();
            document.body.setAttribute('data-highlight-keywords', active ? '1' : '0');
        }

        icon.addEventListener('click', toggle);
        if (label) label.addEventListener('click', toggle);
        update();
        document.body.setAttribute('data-highlight-keywords', active ? '1' : '0');
    }

    function updateAudioParamLabels() {
        const map = {
            '.v19_272': '黄白双鱼·关键词高亮',
            '.v19_277': 'AI自动匹配',
            '.v19_287': 'AI根据文案自动匹配'
        };
        Object.keys(map).forEach(function (sel) {
            const el = $(sel);
            if (el) el.textContent = map[sel];
        });
    }

    function setupOpenPreviewButton() {
        const box = $('.v19_320');
        if (!box) return;

        box.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease';
        box.addEventListener('mouseenter', function () { box.style.boxShadow = '0 0 0 1px rgba(219,112,255,0.5)'; });
        box.addEventListener('mouseleave', function () { box.style.boxShadow = 'none'; });
        box.addEventListener('mousedown', function () { box.style.transform = 'scale(0.96)'; });
        box.addEventListener('mouseup', function () { box.style.transform = 'scale(1)'; });

        box.addEventListener('click', function () {
            nativeCall('pickFile').then(function (result) {
                if (result && result.path) {
                    document.body.setAttribute('data-video-path', result.path);
                    try { sessionStorage.setItem('vv_generated_video', result.path); } catch (e) {}
                    updateVideoSourceDisplay(result.path);
                    const name = result.path.split(/[\\/]/).pop() || '已选择视频';
                    setCutPreviewState('normal', { title: '已加载预览', sub: name });
                }
            }).catch(function (e) { console.error('pickFile failed', e); });
        });
    }

    function loadGeneratedVideo() {
        let videoPath = document.body.getAttribute('data-generated-video') || '';
        if (!videoPath) {
            try { videoPath = sessionStorage.getItem('vv_generated_video') || ''; } catch (e) {}
        }
        const label = $('.v19_251');
        if (videoPath) {
            document.body.setAttribute('data-video-path', videoPath);
            if (label) label.textContent = '已加载';
            updateVideoSourceDisplay(videoPath);
            const name = videoPath.split(/[\\/]/).pop() || '已加载视频';
            setCutPreviewState('normal', { title: '已加载预览', sub: name });
        } else {
            if (label) label.textContent = '上传';
            updateVideoSourceDisplay('');
        }
    }

    function createNavToggle() {
        const toggle = document.createElement('div');
        toggle.className = 'vc-nav-toggle';
        const knob = document.createElement('div');
        knob.className = 'vc-nav-toggle-knob';
        toggle.appendChild(knob);
        return toggle;
    }

    function setupVideoCutTabToggles() {
        const items = ['.v19_269', '.v19_270', '.v19_275', '.v19_279'];
        const keys = ['enable_params', 'enable_subtitle', 'enable_bgm', 'enable_soundfx'];
        const defaults = [true, true, false, false];
        items.forEach(function (sel, i) {
            const el = $(sel);
            if (!el) return;
            const key = keys[i];
            const toggle = createNavToggle();
            toggle.setAttribute('data-vc-toggle', key);
            toggle.classList.toggle('active', defaults[i]);
            toggle.addEventListener('click', function (e) {
                e.stopPropagation();
                toggle.classList.toggle('active');
                const active = toggle.classList.contains('active');
                document.body.setAttribute('data-' + key, active ? '1' : '0');
                updateCutToggleVisuals(key, active);
            });
            el.appendChild(toggle);
            document.body.setAttribute('data-' + key, defaults[i] ? '1' : '0');
            updateCutToggleVisuals(key, defaults[i]);
        });
    }

    function updateCutToggleVisuals(key, active) {
        const navMap = {
            'enable_params': '.v19_269',
            'enable_subtitle': '.v19_270',
            'enable_bgm': '.v19_275',
            'enable_soundfx': '.v19_279'
        };
        const tabMap = {
            'enable_params': 'params',
            'enable_subtitle': 'subtitle',
            'enable_bgm': 'bgm',
            'enable_soundfx': 'soundfx'
        };
        const nav = $(navMap[key]);
        if (nav) nav.classList.toggle('vc-nav-disabled', !active);
        const content = document.querySelector('.vc-tab-content[data-vc-tab="' + tabMap[key] + '"]');
        if (content) content.classList.toggle('vc-tab-disabled', !active);
    }

    function getNavToggleState(key) {
        const toggle = document.querySelector('[data-vc-toggle="' + key + '"]');
        return toggle ? toggle.classList.contains('active') : false;
    }

    function getCutOptions() {
        const options = {
            enable_params: getNavToggleState('enable_params'),
            enable_subtitle: getNavToggleState('enable_subtitle'),
            enable_bgm: getNavToggleState('enable_bgm'),
            enable_soundfx: getNavToggleState('enable_soundfx'),
            voice_volume: 1.0,
            bgm_volume: 1.0,
            speed: 1.0,
            cut_breath: true,
            subtitle_style: 0,
            highlight_keywords: true,
            bgm_path: ''
        };

        const panel = $('#vc-dynamic-panel');
        if (panel) {
            $$('[data-vc-param]').forEach(function (row) {
                const key = row.getAttribute('data-vc-param');
                if (key === 'voice_volume' || key === 'bgm_volume') {
                    const slider = row.querySelector('input[type="range"]');
                    if (slider) options[key] = parseFloat(slider.value);
                } else if (key === 'speed') {
                    const select = row.querySelector('select');
                    if (select) options.speed = parseFloat(select.value.replace('x', ''));
                } else if (key === 'cut_breath') {
                    const toggle = row.querySelector('.vc-toggle');
                    if (toggle) options.cut_breath = toggle.classList.contains('active');
                }
            });
        }

        const bgmPathBox = $('#vc-bgm-path');
        if (bgmPathBox && bgmPathBox.textContent && bgmPathBox.textContent !== '未选择文件') {
            options.bgm_path = bgmPathBox.textContent.trim();
        }

        options.subtitle_style = parseInt(document.body.getAttribute('data-subtitle-style') || '0', 10) || 0;
        options.highlight_keywords = (document.body.getAttribute('data-highlight-keywords') || '1') === '1';

        return options;
    }

    function initCutPreview() {
        const preview = $('.v19_326');
        if (!preview) return;
        if (preview.querySelector('.vc-preview-overlay')) return;

        ['.v19_328', '.v19_329', '.v19_330'].forEach(function (sel) {
            const el = $(sel);
            if (el) el.style.display = 'none';
        });

        const overlay = document.createElement('div');
        overlay.className = 'vc-preview-overlay state-normal';
        overlay.innerHTML = '<div class="state-block state-normal">' +
            '<div class="vc-preview-icon"><div class="preview-play"></div></div>' +
            '<div class="vc-preview-title">视频预览</div>' +
            '<div class="vc-preview-sub">剪辑完成后的视频将显示在这里</div>' +
            '</div>' +
            '<div class="state-block state-loading">' +
            '<div class="vc-preview-icon"><div class="vc-preview-spinner"></div></div>' +
            '<div class="vc-preview-title">正在剪辑视频</div>' +
            '<div class="vc-preview-progress"><div class="vc-preview-progress-fill"></div></div>' +
            '<div class="vc-preview-sub">AI 正在识别语音并生成网感字幕</div>' +
            '</div>' +
            '<div class="state-block state-done">' +
            '<div class="vc-preview-icon"><div class="preview-check"></div></div>' +
            '<div class="vc-preview-title">剪辑完成</div>' +
            '<div class="vc-preview-sub"><span class="filename"></span></div>' +
            '<button class="vc-preview-btn">打开文件位置</button>' +
            '</div>';

        const btn = overlay.querySelector('.vc-preview-btn');
        if (btn) {
            btn.addEventListener('click', function () {
                const path = preview.getAttribute('data-video-path') || '';
                if (path) nativeCall('openFileLocation', { path: path });
            });
        }
        preview.appendChild(overlay);
    }

    function setCutPreviewState(state, opts) {
        const overlay = $('.vc-preview-overlay');
        if (!overlay) return;
        opts = opts || {};
        overlay.classList.remove('state-normal', 'state-loading', 'state-done', 'is-error');
        overlay.classList.add('state-' + state);
        if (opts.error) overlay.classList.add('is-error');

        if (typeof opts.percent === 'number') {
            const fill = overlay.querySelector('.vc-preview-progress-fill');
            if (fill) fill.style.width = Math.max(0, Math.min(100, opts.percent)) + '%';
        }

        const block = overlay.querySelector('.state-' + state);
        if (!block) return;
        if (opts.title) {
            const t = block.querySelector('.vc-preview-title');
            if (t) t.textContent = opts.title;
        }
        if (opts.sub) {
            const s = block.querySelector('.vc-preview-sub');
            if (s) s.textContent = opts.sub;
        }
        if (opts.filename) {
            const fn = block.querySelector('.filename');
            if (fn) fn.textContent = opts.filename;
        }
    }

    function setPreviewBackground(path) {
        const preview = $('.v19_326');
        if (!preview) return;
        if (path) {
            const normalized = path.replace(/\\/g, '/');
            preview.style.backgroundImage = 'url("file:///' + normalized + '")';
        } else {
            preview.style.backgroundImage = '';
        }
    }

    function setupCutVideoButton() {
        let isCutting = false;
        let pollTimer = null;

        function finish(success, videoPath, errorMsg, posterPath) {
            clearInterval(pollTimer);
            pollTimer = null;
            isCutting = false;

            const preview = $('.v19_326');
            if (success && videoPath) {
                if (preview) preview.setAttribute('data-video-path', videoPath);
                try { sessionStorage.setItem('vv_generated_video', videoPath); } catch (e) {}
                setCutPreviewState('done', { filename: videoPath.split(/[\\/]/).pop() });
                if (posterPath) setPreviewBackground(posterPath);
            } else {
                setCutPreviewState('normal', { error: true, title: '剪辑失败', sub: errorMsg || '请检查视频源、ffmpeg 与模型配置' });
                setPreviewBackground('');
            }
        }

        setupGradientButton('.v19_260', '.v19_259', function () {
            if (isCutting) return;

            let videoPath = document.body.getAttribute('data-video-path') || '';
            if (!videoPath) {
                try { videoPath = sessionStorage.getItem('vv_generated_video') || ''; } catch (e) {}
            }
            videoPath = videoPath.replace(/\\/g, '/');
            if (!videoPath || !/\.(mp4|mov|mkv|avi|webm)$/i.test(videoPath)) {
                finish(false, null, '请先选择或生成视频源');
                return;
            }

            isCutting = true;
            setPreviewBackground('');
            setCutPreviewState('loading', { percent: 0, title: '正在剪辑视频', sub: '正在初始化剪辑环境...' });

            const options = getCutOptions();
            nativeCall('cutVideo', { video_path: videoPath, options: options })
                .then(function (result) {
                    if (typeof result === 'string') {
                        try { result = JSON.parse(result); }
                        catch (e) { result = { error: result }; }
                    }
                    if (!result || result.error || !result.taskId) {
                        finish(false, null, result.error || '启动剪辑失败');
                        return;
                    }
                    const taskId = result.taskId;
                    pollTimer = setInterval(function () {
                        nativeCall('checkCutTask', { taskId: taskId })
                            .then(function (check) {
                                if (typeof check === 'string') {
                                    try { check = JSON.parse(check); }
                                    catch (e) { check = {}; }
                                }
                                if (!check || check.status === 'running') {
                                    if (check && typeof check.percent === 'number') {
                                        setCutPreviewState('loading', {
                                            percent: check.percent,
                                            sub: '当前进度：' + Math.round(check.percent) + '%'
                                        });
                                    }
                                    return;
                                }
                                clearInterval(pollTimer);
                                pollTimer = null;
                                if (check.status === 'done' && typeof check.video_path === 'string') {
                                    finish(true, check.video_path, null, check.poster_path);
                                } else {
                                    finish(false, null, check.error || '剪辑失败');
                                }
                            })
                            .catch(function (e) {
                                console.error('checkCutTask failed', e);
                                finish(false, null, '查询剪辑结果失败');
                            });
                    }, 500);
                })
                .catch(function (e) {
                    console.error('cutVideo failed', e);
                    finish(false, null, '调用剪辑失败');
                });
        });
    }

    function initVideoCutPage() {
        initCutPreview();
        setupStartNewTaskButton();
        setupSidebarInteractions();
        setupVideoCutUploadButton();
        loadGeneratedVideo();
        setupVideoCutTabToggles();
        setupVideoCutTabs();
        updateAudioParamLabels();
        setupSubtitleStyleSelection();
        setupHighlightToggle();
        setupOpenPreviewButton();
        setupCutVideoButton();
        setupVideoCutNavButtons();
    }

    // ===================== BannerGenerate 页面交互 =====================
    function loadSubPage(containerSelector, pageName, initFn) {
        const container = $(containerSelector);
        if (!container) return;

        // 移除旧子页面样式
        $$('link[data-sub-page-css]').forEach(function (link) {
            link.remove();
        });

        const cssName = pageName.replace(/\.html$/i, '.css');
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = './css/' + cssName;
        link.setAttribute('data-sub-page-css', 'true');

        let cssLoaded = false;
        let htmlReady = null;

        function apply(html) {
            const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
            container.innerHTML = m ? m[1] : html;
            if (typeof initFn === 'function') initFn();
        }

        function maybeApply() {
            if (cssLoaded && htmlReady !== null) apply(htmlReady);
        }

        link.onload = function () { cssLoaded = true; maybeApply(); };
        link.onerror = function () { cssLoaded = true; maybeApply(); };
        document.head.appendChild(link);

        fetch(pageName)
            .then(function (response) { return response.text(); })
            .then(function (html) { htmlReady = html; maybeApply(); })
            .catch(function (err) {
                console.error('Sub-page load error:', err);
            });
    }

    function hideBannerPreviewOriginal() {
        const selectors = [
            '.v20_441', '.v20_442',
            '.v20_452',
            '.v20_453', '.v20_455', '.v20_456', '.v20_457', '.v20_458', '.v20_459', '.v20_460', '.v20_461', '.v20_463', '.v20_464', '.v20_465', '.v20_466',
            '.v20_468', '.v20_469', '.v20_470', '.v20_471', '.v20_472', '.v20_473', '.v20_474', '.v20_475', '.v20_476', '.v20_477', '.v20_478', '.v20_479',
            '.v20_443', '.v20_446', '.v20_444', '.v20_447',
            '.v21_547', '.v21_548'
        ];
        selectors.forEach(function (sel) {
            const el = $(sel);
            if (el) el.style.display = 'none';
        });
    }

    function restoreBannerTemplateView() {
        $$('link[data-sub-page-css]').forEach(function (link) {
            link.remove();
        });
        const container = $('.v20_430');
        if (container) container.innerHTML = '';

        const selectors = [
            '.v20_441', '.v20_442',
            '.v20_452',
            '.v20_453', '.v20_455', '.v20_456', '.v20_457', '.v20_458', '.v20_459', '.v20_460', '.v20_461', '.v20_463', '.v20_464', '.v20_465', '.v20_466',
            '.v20_468', '.v20_469', '.v20_470', '.v20_471', '.v20_472', '.v20_473', '.v20_474', '.v20_475', '.v20_476', '.v20_477', '.v20_478', '.v20_479',
            '.v20_443', '.v20_446', '.v20_444', '.v20_447',
            '.v21_547', '.v21_548'
        ];
        selectors.forEach(function (sel) {
            const el = $(sel);
            if (el) el.style.display = '';
        });

        const left = $('.v20_443');
        const right = $('.v20_446');
        const leftText = $('.v20_444');
        const rightText = $('.v20_447');
        if (left && right) {
            left.style.background = 'rgba(61,114,237,1)';
            right.style.background = 'rgba(43,52,87,1)';
            if (leftText) leftText.style.color = '#fff';
            if (rightText) rightText.style.color = 'rgba(255,255,255,0.7)';
        }
    }

    function setupBannerGenerateUpload() {
        setupGradientButton('.v20_439', '.v20_438', function () {
            nativeCall('pickFile').then(function (result) {
                if (result && result.path) {
                    console.log('已选择视频源：', result.path);
                }
            }).catch(function (e) {
                console.error('pickFile failed', e);
            });
        });
    }

    function getBannerTemplateGridSelectors() {
        return [
            '.v20_453', '.v20_455', '.v20_456', '.v20_457', '.v20_458', '.v20_459', '.v20_460', '.v20_461', '.v20_463', '.v20_464', '.v20_465', '.v20_466',
            '.v20_468', '.v20_469', '.v20_470', '.v20_471', '.v20_472', '.v20_473', '.v20_474', '.v20_475', '.v20_476', '.v20_477', '.v20_478', '.v20_479'
        ];
    }

    function hasBannerSubPage() {
        return !!$('.v21_613') || !!$('.v21_614');
    }

    function hideBannerSubPage() {
        $$('link[data-sub-page-css]').forEach(function (link) { link.remove(); });
        const container = $('.v20_430');
        if (container) container.innerHTML = '';
    }

    function setBannerTemplateGridVisible(visible) {
        getBannerTemplateGridSelectors().forEach(function (sel) {
            const el = $(sel);
            if (el) el.style.display = visible ? '' : 'none';
        });
    }

    function setBannerEditMode(mode) {
        window.__banner_edit_mode = mode;
        const templateTab = $('.v20_443');
        const sourceTab = $('.v20_446');
        const textTab = $('.banner-text-edit-tab');
        const templateText = $('.v20_444');
        const sourceText = $('.v20_447');
        const panel = $('.banner-text-edit-panel');

        function setTab(el, textEl, active) {
            if (el) el.style.background = active ? 'rgba(61,114,237,1)' : 'rgba(43,52,87,1)';
            if (textEl) textEl.style.color = active ? '#fff' : 'rgba(255,255,255,0.7)';
        }

        setTab(templateTab, templateText, mode === 'template');
        setTab(sourceTab, sourceText, mode === 'source');
        if (textTab) textTab.classList.toggle('active', mode === 'text');

        if (mode === 'template') {
            hideBannerSubPage();
            setBannerTemplateGridVisible(true);
            if (panel) panel.classList.remove('active');
            renderBannerPreview('.v20_452', true);
        } else if (mode === 'source') {
            setBannerTemplateGridVisible(false);
            if (panel) panel.classList.remove('active');
        } else if (mode === 'text') {
            hideBannerSubPage();
            setBannerTemplateGridVisible(false);
            if (panel) {
                panel.classList.add('active');
                renderTextEditPanel();
            }
            renderBannerPreview('.v20_452', true);
        }
    }

    function setupTextEditTab() {
        if ($('.banner-text-edit-tab')) return;

        const templateTab = $('.v20_443');
        const sourceTab = $('.v20_446');
        const templateText = $('.v20_444');
        const sourceText = $('.v20_447');

        // 将三个标签整体右对齐在 .v20_430 容器内（容器 right ≈ 1310，
        // 即相对原设计左移 25px），每个标签宽 80px、间距 5px。
        const tabW = 80;
        const gap = 5;
        const containerRight = 1310;
        const textLeft = containerRight - tabW;
        const sourceLeft = textLeft - gap - tabW;
        const templateLeft = sourceLeft - gap - tabW;

        if (templateTab) {
            templateTab.style.width = tabW + 'px';
            templateTab.style.left = templateLeft + 'px';
        }
        if (sourceTab) {
            sourceTab.style.width = tabW + 'px';
            sourceTab.style.left = sourceLeft + 'px';
        }
        if (templateText) {
            templateText.style.width = tabW + 'px';
            templateText.style.left = templateLeft + 'px';
            templateText.style.textAlign = 'center';
        }
        if (sourceText) {
            sourceText.style.width = tabW + 'px';
            sourceText.style.left = sourceLeft + 'px';
            sourceText.style.textAlign = 'center';
        }

        const tab = document.createElement('div');
        tab.className = 'banner-text-edit-tab';
        tab.textContent = '文本编辑';
        tab.style.left = textLeft + 'px';
        tab.style.width = tabW + 'px';
        document.body.appendChild(tab);

        const panel = document.createElement('div');
        panel.className = 'banner-text-edit-panel';
        panel.innerHTML = '<div class="banner-text-unit-list"></div><div class="banner-text-edit-form"></div>';
        document.body.appendChild(panel);
    }

    function patchSelectedTextUnit(field, rawValue) {
        const unit = getSelectedTextUnit();
        if (!unit) return;
        let value = rawValue;

        // 数值型字段统一转数字
        const numericFields = ['fontSize', 'opacity', 'letterSpacing', 'lineHeight', 'rotation'];
        const numericSubFields = ['opacity', 'radius', 'size', 'blur', 'distance', 'padding', 'width', 'height'];
        if (numericFields.indexOf(field) !== -1) {
            value = parseFloat(value);
            if (isNaN(value)) value = 0;
        } else if (field.indexOf('.') !== -1 && numericSubFields.indexOf(field.split('.')[1]) !== -1) {
            value = parseFloat(value);
            if (isNaN(value)) value = 0;
        }

        if (field === 'x' || field === 'y') {
            value = Math.max(0, Math.min(100, parseFloat(value) || 0)) / 100;
        }
        if (field.indexOf('.') !== -1) {
            const keys = field.split('.');
            const obj = JSON.parse(JSON.stringify(unit[keys[0]] || {}));
            obj[keys[1]] = value;
            updateSelectedTextUnit({ [keys[0]]: obj });
        } else {
            updateSelectedTextUnit({ [field]: value });
        }
        refreshAllBannerPreviews();
    }

    function numOr(value, fallback) {
        return (typeof value === 'number' && !isNaN(value)) ? value : fallback;
    }

    function buildTextEditForm(unit) {
        const fonts = ['Microsoft YaHei', 'PingFang SC', 'SimHei', 'Inter', 'Arial', 'Georgia', 'Verdana', 'Times New Roman'];
        const fontOptions = fonts.map(function (f) {
            return '<option value="' + f + '"' + (unit.fontFamily === f ? ' selected' : '') + '>' + f + '</option>';
        }).join('');
        const aligns = [
            { k: 'left', l: '左' }, { k: 'center', l: '中' }, { k: 'right', l: '右' }
        ];
        const alignButtons = aligns.map(function (a) {
            const active = unit.align === a.k;
            return '<button type="button" data-align="' + a.k + '" class="' + (active ? 'active' : '') + '">' + a.l + '</button>';
        }).join('');
        const bg = unit.background || {};
        const sd = unit.shadow || {};

        return '<div class="banner-text-edit-scroll">' +
            '<div class="banner-text-form-group"><label>文本内容</label><textarea class="banner-text-textarea" data-field="text">' + escapeHtml(unit.text) + '</textarea></div>' +
            '<div class="banner-text-form-row">' +
                '<div class="banner-text-form-group"><label>字体</label><select class="banner-text-select" data-field="fontFamily">' + fontOptions + '</select></div>' +
                '<div class="banner-text-form-group"><label>字号 (输出 px)</label><input type="number" class="banner-text-number" data-field="fontSize" value="' + numOr(unit.fontSize, 140) + '" min="12" max="600" step="1"></div>' +
            '</div>' +
            '<div class="banner-text-form-row">' +
                '<div class="banner-text-form-group"><label>样式</label>' +
                    '<div class="banner-text-form-row" style="gap:6px;">' +
                        '<button type="button" class="banner-text-style-btn" data-field="bold" style="flex:1;height:28px;background:' + (unit.bold ? 'rgba(61,114,237,0.35)' : 'rgba(44,48,66,1)') + ';border:1px solid rgba(73,87,145,0.4);border-radius:6px;color:' + (unit.bold ? '#fff' : 'rgba(255,255,255,0.7)') + ';cursor:pointer;font-weight:bold;">B</button>' +
                        '<button type="button" class="banner-text-style-btn" data-field="italic" style="flex:1;height:28px;background:' + (unit.italic ? 'rgba(61,114,237,0.35)' : 'rgba(44,48,66,1)') + ';border:1px solid rgba(73,87,145,0.4);border-radius:6px;color:' + (unit.italic ? '#fff' : 'rgba(255,255,255,0.7)') + ';cursor:pointer;font-style:italic;font-family:Georgia,serif;">I</button>' +
                        '<button type="button" class="banner-text-style-btn" data-field="underline" style="flex:1;height:28px;background:' + (unit.underline ? 'rgba(61,114,237,0.35)' : 'rgba(44,48,66,1)') + ';border:1px solid rgba(73,87,145,0.4);border-radius:6px;color:' + (unit.underline ? '#fff' : 'rgba(255,255,255,0.7)') + ';cursor:pointer;text-decoration:underline;">U</button>' +
                    '</div>' +
                '</div>' +
                '<div class="banner-text-form-group"><label>对齐</label><div class="banner-text-segment" data-segment="align">' + alignButtons + '</div></div>' +
            '</div>' +
            '<div class="banner-text-form-row">' +
                '<div class="banner-text-form-group"><label>颜色</label><input type="color" class="banner-text-color" data-field="color" value="' + unit.color + '"></div>' +
                '<div class="banner-text-form-group"><label>不透明度</label><input type="number" class="banner-text-number" data-field="opacity" value="' + numOr(unit.opacity, 1) + '" min="0" max="1" step="0.05"></div>' +
            '</div>' +
            '<div class="banner-text-form-row">' +
                '<div class="banner-text-form-group"><label>字间距</label><input type="number" class="banner-text-number" data-field="letterSpacing" value="' + numOr(unit.letterSpacing, 0) + '" min="-50" max="200" step="1"></div>' +
                '<div class="banner-text-form-group"><label>行高</label><input type="number" class="banner-text-number" data-field="lineHeight" value="' + numOr(unit.lineHeight, 1.2) + '" min="0.5" max="3" step="0.1"></div>' +
            '</div>' +
            '<div class="banner-text-form-row">' +
                '<div class="banner-text-form-group"><label>X 位置 (%)</label><input type="number" class="banner-text-number" data-field="x" value="' + Math.round(unit.x * 100) + '" min="0" max="100" step="1"></div>' +
                '<div class="banner-text-form-group"><label>Y 位置 (%)</label><input type="number" class="banner-text-number" data-field="y" value="' + Math.round(unit.y * 100) + '" min="0" max="100" step="1"></div>' +
                '<div class="banner-text-form-group"><label>旋转 (°)</label><input type="number" class="banner-text-number" data-field="rotation" value="' + numOr(unit.rotation, 0) + '" min="-180" max="180" step="1"></div>' +
            '</div>' +
            '<div class="banner-text-form-group" style="border-top:1px solid rgba(73,87,145,0.3);padding-top:10px;">' +
                '<label class="banner-text-toggle"><input type="checkbox" data-field="background.enabled" ' + (bg.enabled ? 'checked' : '') + '> 文本背景</label>' +
            '</div>' +
            (bg.enabled ?
                '<div class="banner-text-form-row">' +
                    '<div class="banner-text-form-group"><label>背景颜色</label><input type="color" class="banner-text-color" data-field="background.color" value="' + (bg.color || '#000000') + '"></div>' +
                    '<div class="banner-text-form-group"><label>背景不透明度</label><input type="number" class="banner-text-number" data-field="background.opacity" value="' + numOr(bg.opacity, 0.5) + '" min="0" max="1" step="0.05"></div>' +
                '</div>' +
                '<div class="banner-text-form-row">' +
                    '<div class="banner-text-form-group"><label>圆角</label><input type="number" class="banner-text-number" data-field="background.radius" value="' + numOr(bg.radius, 8) + '" min="0" max="100" step="1"></div>' +
                '</div>' : '') +
            '<div class="banner-text-form-group" style="border-top:1px solid rgba(73,87,145,0.3);padding-top:10px;">' +
                '<label class="banner-text-toggle"><input type="checkbox" data-field="shadow.enabled" ' + (sd.enabled ? 'checked' : '') + '> 文本阴影 / 描边</label>' +
            '</div>' +
            (sd.enabled ?
                '<div class="banner-text-form-row">' +
                    '<div class="banner-text-form-group"><label>阴影颜色</label><input type="color" class="banner-text-color" data-field="shadow.color" value="' + (sd.color || '#000000') + '"></div>' +
                    '<div class="banner-text-form-group"><label>阴影不透明度</label><input type="number" class="banner-text-number" data-field="shadow.opacity" value="' + numOr(sd.opacity, 0.5) + '" min="0" max="1" step="0.05"></div>' +
                '</div>' +
                '<div class="banner-text-form-row">' +
                    '<div class="banner-text-form-group"><label>描边粗细</label><input type="number" class="banner-text-number" data-field="shadow.size" value="' + numOr(sd.size, 0) + '" min="0" max="50" step="1"></div>' +
                    '<div class="banner-text-form-group"><label>模糊</label><input type="number" class="banner-text-number" data-field="shadow.blur" value="' + numOr(sd.blur, 0) + '" min="0" max="100" step="1"></div>' +
                    '<div class="banner-text-form-group"><label>偏移</label><input type="number" class="banner-text-number" data-field="shadow.distance" value="' + numOr(sd.distance, 0) + '" min="0" max="100" step="1"></div>' +
                '</div>' : '') +
        '</div>';
    }

    function renderTextEditPanel() {
        const panel = $('.banner-text-edit-panel');
        if (!panel) return;
        const units = getTextUnits();
        const selectedId = getSelectedTextUnitId();
        const unit = getSelectedTextUnit();

        const list = panel.querySelector('.banner-text-unit-list');
        if (list) {
            list.innerHTML = '';
            units.forEach(function (u) {
                const chip = document.createElement('div');
                chip.className = 'banner-text-unit-chip' + (u.id === selectedId ? ' selected' : '');
                chip.title = u.text || '无标题';
                chip.textContent = (u.text || '无标题').split(/\r?\n/)[0] || '无标题';
                const del = document.createElement('span');
                del.className = 'chip-del';
                del.textContent = '×';
                del.addEventListener('click', function (e) {
                    e.stopPropagation();
                    deleteTextUnit(u.id);
                    renderTextEditPanel();
                    refreshAllBannerPreviews();
                });
                chip.appendChild(del);
                chip.addEventListener('click', function () {
                    setSelectedTextUnitId(u.id);
                    renderTextEditPanel();
                    highlightSelectedBannerLayers();
                });
                list.appendChild(chip);
            });
            const addBtn = document.createElement('div');
            addBtn.className = 'banner-text-add-btn';
            addBtn.textContent = '+';
            addBtn.title = '添加标题';
            addBtn.addEventListener('click', function () {
                addTextUnit();
                renderTextEditPanel();
                refreshAllBannerPreviews();
                highlightSelectedBannerLayers();
            });
            list.appendChild(addBtn);
        }

        const form = panel.querySelector('.banner-text-edit-form');
        if (!form || !unit) return;
        form.innerHTML = buildTextEditForm(unit);

        // 绑定事件
        form.querySelectorAll('[data-field]').forEach(function (input) {
            const field = input.getAttribute('data-field');
            if (input.tagName === 'TEXTAREA') {
                input.addEventListener('input', function () { patchSelectedTextUnit(field, input.value); });
            } else if (input.type === 'checkbox') {
                input.addEventListener('change', function () {
                    patchSelectedTextUnit(field, input.checked);
                    renderTextEditPanel();
                });
            } else if (input.tagName === 'SELECT') {
                input.addEventListener('change', function () { patchSelectedTextUnit(field, input.value); });
            } else if (input.type === 'number' || input.type === 'color') {
                input.addEventListener('input', function () { patchSelectedTextUnit(field, input.value); });
            }
        });

        form.querySelectorAll('.banner-text-style-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const field = btn.getAttribute('data-field');
                const unit2 = getSelectedTextUnit();
                if (!unit2) return;
                patchSelectedTextUnit(field, !unit2[field]);
                renderTextEditPanel();
            });
        });

        form.querySelectorAll('[data-segment="align"] button').forEach(function (btn) {
            btn.addEventListener('click', function () {
                patchSelectedTextUnit('align', btn.getAttribute('data-align'));
                renderTextEditPanel();
            });
        });
    }

    function setupTemplateToggle() {
        setupTextEditTab();
        const templateTab = $('.v20_443');
        const sourceTab = $('.v20_446');
        const textTab = $('.banner-text-edit-tab');
        if (!templateTab || !sourceTab) return;

        templateTab.addEventListener('click', function () {
            setBannerEditMode('template');
        });
        sourceTab.addEventListener('click', function () {
            if (hasBannerSubPage()) return;
            setBannerEditMode('source');
            loadSubPage('.v20_430', 'BannerPriviewFrameSection.html', initBannerPreviewFrameSection);
        });
        if (textTab) {
            textTab.addEventListener('click', function () {
                setBannerEditMode('text');
            });
        }
        setBannerEditMode('template');
    }

    function setupStyleTemplateSelection() {
        const items = ['.v20_453', '.v20_455', '.v20_456', '.v20_457', '.v20_458', '.v20_459', '.v20_460', '.v20_461', '.v20_463', '.v20_464', '.v20_465', '.v20_466'];
        const elements = items.map($).filter(Boolean);
        if (elements.length === 0) return;

        function select(index) {
            elements.forEach(function (el, i) {
                el.style.boxShadow = (i === index) ? 'inset 0 0 0 2px rgba(219,112,255,1)' : 'none';
            });
        }

        elements.forEach(function (el, index) {
            el.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease';
            el.addEventListener('mouseenter', function () { el.style.transform = 'scale(1.05)'; });
            el.addEventListener('mouseleave', function () { el.style.transform = 'scale(1)'; });
            el.addEventListener('mousedown', function () { el.style.transform = 'scale(0.95)'; });
            el.addEventListener('mouseup', function () { el.style.transform = 'scale(1.05)'; });
            el.addEventListener('click', function () { select(index); });
        });
        select(0);
    }

    function setupCoverSourceButton() {
        setupGradientButton('.v21_548', '.v21_547', function () {
            console.log('生成封面');
        });
    }

    function setupBannerGenerateNavButtons() {
        // 上一步 -> VideoCut
        setupGradientButton('.v20_376', '.v20_374', function () {
            navigateTo('VideoCut.html');
        });

        // 下一步 -> Publish
        setupGradientButton('.v20_377', '.v20_375', function () {
            navigateTo('Publish.html');
        });
    }

    function initBannerPreviewFrameSection() {
        const tabTemplate = $('.v20_508');
        const tabSource = $('.v20_509');
        if (tabTemplate && tabSource) {
            tabSource.style.background = 'rgba(61,114,237,1)';
            tabTemplate.style.background = 'rgba(43,52,87,1)';
            tabTemplate.addEventListener('click', function () {
                restoreBannerTemplateView();
            });
        }

        const btnFrame = $('.v20_512');
        const btnLocal = $('.v20_521');
        if (btnFrame && btnLocal) {
            btnFrame.style.background = 'rgba(61,114,237,1)';
            btnLocal.style.background = 'rgba(44,48,66,1)';
            btnFrame.addEventListener('click', function () {
                btnFrame.style.background = 'rgba(61,114,237,1)';
                btnLocal.style.background = 'rgba(44,48,66,1)';
                console.log('自动抽帧');
            });
            btnLocal.addEventListener('click', function () {
                loadSubPage('.v20_430', 'BannerPriviewLocalImage.html', initBannerPreviewLocalImage);
            });
        }

        const btnResample = $('.v21_532');
        if (btnResample) {
            btnResample.style.cursor = 'pointer';
            btnResample.addEventListener('click', function () {
                console.log('重新随机抽帧');
            });
        }
    }

    function initBannerPreviewLocalImage() {
        const tabTemplate = $('.v21_585');
        const tabSource = $('.v21_586');
        if (tabTemplate && tabSource) {
            tabSource.style.background = 'rgba(61,114,237,1)';
            tabTemplate.style.background = 'rgba(43,52,87,1)';
            tabTemplate.addEventListener('click', function () {
                restoreBannerTemplateView();
            });
        }

        const btnFrame = $('.v21_589');
        const btnLocal = $('.v21_590');
        if (btnFrame && btnLocal) {
            btnLocal.style.background = 'rgba(61,114,237,1)';
            btnFrame.style.background = 'rgba(44,48,66,1)';
            btnFrame.addEventListener('click', function () {
                loadSubPage('.v20_430', 'BannerPriviewFrameSection.html', initBannerPreviewFrameSection);
            });
            btnLocal.addEventListener('click', function () {
                btnLocal.style.background = 'rgba(61,114,237,1)';
                btnFrame.style.background = 'rgba(44,48,66,1)';
                console.log('本地图片');
            });
        }

        const uploadArea = $('.v21_598');
        if (uploadArea) {
            uploadArea.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease';
            uploadArea.addEventListener('mouseenter', function () { uploadArea.style.boxShadow = '0 0 0 1px rgba(219,112,255,0.5)'; });
            uploadArea.addEventListener('mouseleave', function () { uploadArea.style.boxShadow = 'none'; });
            uploadArea.addEventListener('mousedown', function () { uploadArea.style.transform = 'scale(0.98)'; });
            uploadArea.addEventListener('mouseup', function () { uploadArea.style.transform = 'scale(1)'; });
            uploadArea.addEventListener('click', function () {
                nativeCall('pickFile').then(function (result) {
                    if (result && result.path) {
                        const text = $('.v21_611');
                        if (text) text.textContent = '已选择图片';
                    }
                }).catch(function (e) {
                    console.error('pickFile failed', e);
                });
            });
        }
    }

    function initBannerGeneratePage() {
        setupStartNewTaskButton();
        setupSidebarInteractions();
        setupBannerGenerateUpload();
        setupTemplateToggle();
        setupStyleTemplateSelection();
        setupCoverSourceButton();
        setupBannerGenerateNavButtons();
    }

    // ===================== Publish 页面交互 =====================
    function setupPublishNavButtons() {
        setupGradientButton('.v23_659', '.v23_657', function () {
            navigateTo('BannerGenerate.html');
        });
        setupGradientButton('.v23_660', '.v23_658', function () {
            publishNow();
        });
    }

    const PUBLISH_ACCOUNT_KEY = 'vv_publish_accounts';
    const PUBLISH_ACTIVE_ACCOUNT_KEY = 'vv_publish_active_account';

    function getPlatformLabel(platform) {
        const map = { 'xiaohongshu': '小红书', 'douyin': '抖音', 'kuaishou': '快手' };
        return map[platform] || platform;
    }

    function loadPublishAccounts() {
        try {
            const raw = localStorage.getItem(PUBLISH_ACCOUNT_KEY);
            const accounts = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(accounts)) return [];
            // 兼容旧账号数据：补充小红书账号所需的 servicePort / cookiePath
            let xhsCount = 0;
            accounts.forEach(function (acc) {
                if (acc.platform !== 'xiaohongshu') return;
                if (!acc.servicePort) {
                    acc.servicePort = 18060 + xhsCount;
                    xhsCount++;
                }
                if (!acc.cookiePath) {
                    acc.cookiePath = 'localdep/xiaohongshu-mcp/data/cookies' + (xhsCount > 1 || acc.servicePort !== 18060 ? '.' + acc.id : '') + '.json';
                }
            });
            return accounts;
        } catch (e) {
            return [];
        }
    }

    function savePublishAccounts(accounts) {
        try {
            localStorage.setItem(PUBLISH_ACCOUNT_KEY, JSON.stringify(accounts));
        } catch (e) {
            console.error('save accounts failed', e);
        }
    }

    function getActiveAccountId() {
        try {
            return localStorage.getItem(PUBLISH_ACTIVE_ACCOUNT_KEY) || '';
        } catch (e) {
            return '';
        }
    }

    function setActiveAccountId(id) {
        try {
            if (id) localStorage.setItem(PUBLISH_ACTIVE_ACCOUNT_KEY, id);
            else localStorage.removeItem(PUBLISH_ACTIVE_ACCOUNT_KEY);
        } catch (e) {
            console.error('set active account failed', e);
        }
    }

    function generateAccountId() {
        return 'acc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function getActiveAccount() {
        const accounts = loadPublishAccounts();
        const activeId = getActiveAccountId();
        return accounts.find(function (a) { return a.id === activeId; }) || accounts[0] || null;
    }

    function updatePublishButtonText() {
        const textEl = $('.v23_660');
        if (!textEl) return;
        textEl.textContent = '立即发布';
    }

    function updatePublishButtonState() {
        const bg = $('.v23_658');
        const text = $('.v23_660');
        if (!bg) return;
        const checking = !!(window.__pubAccountChecking && window.__pubAccountChecking.size > 0);
        const noVideo = !getPublishVideoPath();
        const noAccount = !getActiveAccount();
        if (checking || noVideo || noAccount) {
            bg.classList.add('pub-publish-btn-disabled');
            if (text) text.style.opacity = '0.5';
            bg.title = noVideo ? '请先上传或生成视频' : (noAccount ? '请先添加发布账号' : '正在刷新登录状态');
        } else {
            bg.classList.remove('pub-publish-btn-disabled');
            if (text) text.style.opacity = '';
            bg.title = '';
        }
    }

    function publishNow() {
        const active = getActiveAccount();
        if (!active) {
            setPublishResult('未选择账号', '请先添加并选中一个发布账号', true);
            return;
        }
        const platform = active.platform;
        if (platform === 'douyin') {
            publishDouyinNow();
        } else if (platform === 'kuaishou') {
            publishKuaishouNow();
        } else {
            publishXiaohongshuNow();
        }
    }

    function getAccountContainer() {
        let container = $('#pub-account-list');
        if (container) return container;
        const host = $('.v23_739');
        if (!host) return null;
        host.innerHTML = '';
        container = document.createElement('div');
        container.id = 'pub-account-list';
        container.className = 'pub-account-list';
        host.appendChild(container);
        return container;
    }

    function ensureAccountRefreshButton() {
        let btn = $('#pub-account-refresh-all');
        if (btn) return btn;
        const host = $('.v23_739');
        if (!host) return null;
        btn = document.createElement('div');
        btn.id = 'pub-account-refresh-all';
        btn.className = 'pub-account-refresh-all';
        btn.textContent = '刷新登录状态';
        btn.title = '刷新所有账号登录状态';
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            refreshXiaohongshuLoginStatus({ force: true });
        });
        host.appendChild(btn);
        return btn;
    }

    function setEmptyStateVisible(visible) {
        const emptyEls = ['.v23_741', '.v23_742', '.v23_744', '.v23_745'];
        emptyEls.forEach(function (sel) {
            const el = $(sel);
            if (el) el.style.display = visible ? '' : 'none';
        });
    }

    function ensureAccountStateMaps() {
        if (!window.__pubAccountChecking) window.__pubAccountChecking = new Set();
        if (!window.__pubAccountExpired) window.__pubAccountExpired = new Set();
    }

    function isAccountChecking(id) {
        return !!(window.__pubAccountChecking && window.__pubAccountChecking.has(id));
    }

    function isAccountExpired(id) {
        return !!(window.__pubAccountExpired && window.__pubAccountExpired.has(id));
    }

    function setAccountChecking(id, checking) {
        ensureAccountStateMaps();
        if (checking) window.__pubAccountChecking.add(id);
        else window.__pubAccountChecking.delete(id);
        renderAccountList();
        updatePublishButtonState();
    }

    function setAccountExpired(id, expired) {
        ensureAccountStateMaps();
        if (expired) window.__pubAccountExpired.add(id);
        else window.__pubAccountExpired.delete(id);
        renderAccountList();
    }

    function refreshSingleXiaohongshuLoginStatus(account, onDone) {
        if (!account || account.platform !== 'xiaohongshu' || !account.cookiePath) {
            if (onDone) onDone(false);
            return;
        }

        setAccountChecking(account.id, true);
        setAccountExpired(account.id, false);

        nativeCall('getXiaohongshuLoginStatusAsync', {
            cookiePath: account.cookiePath,
            servicePort: account.servicePort || 18060
        }).then(function (res) {
            if (typeof res === 'string') { try { res = JSON.parse(res); } catch (e) { res = {}; } }
            if (res.error || !res.taskId) {
                setAccountChecking(account.id, false);
                if (onDone) onDone(false);
                return;
            }

            const taskId = res.taskId;
            let checks = 0;
            const maxChecks = 300; // ~4 minutes at 800ms
            const timer = setInterval(function () {
                checks += 1;
                nativeCall('checkXiaohongshuLoginStatusTask', { taskId: taskId }).then(function (statusRes) {
                    if (typeof statusRes === 'string') { try { statusRes = JSON.parse(statusRes); } catch (e) { statusRes = {}; } }
                    if (statusRes.status !== 'done') {
                        if (checks >= maxChecks) {
                            clearInterval(timer);
                            setAccountChecking(account.id, false);
                            if (onDone) onDone(false);
                        }
                        return;
                    }

                    clearInterval(timer);
                    setAccountChecking(account.id, false);
                    const loggedIn = !!(statusRes.data && statusRes.data.is_logged_in);
                    updateAccountLoginStatus(account.id, loggedIn);
                    if (!loggedIn) setAccountExpired(account.id, true);
                    if (onDone) onDone(loggedIn);
                }).catch(function (e) {
                    console.error('check xiaohongshu login status task failed', e);
                    if (checks >= maxChecks) {
                        clearInterval(timer);
                        setAccountChecking(account.id, false);
                        if (onDone) onDone(false);
                    }
                });
            }, 800);
        }).catch(function (e) {
            console.error('refresh xiaohongshu login status failed', e);
            setAccountChecking(account.id, false);
            if (onDone) onDone(false);
        });
    }

    function refreshXiaohongshuLoginStatus(options) {
        options = options || {};
        const accounts = loadPublishAccounts();
        const xhsAccounts = accounts.filter(function (a) {
            if (a.platform !== 'xiaohongshu' || !a.cookiePath) return false;
            return options.force || !isAccountStatusFresh(a);
        });
        if (xhsAccounts.length === 0) {
            renderAccountList();
            return Promise.resolve();
        }
        showAccountListLoading('正在刷新登录状态...');
        const promises = xhsAccounts.map(function (acc) {
            return new Promise(function (resolve) {
                refreshSingleXiaohongshuLoginStatus(acc, resolve);
            });
        });
        return Promise.all(promises).then(function () {
            hideAccountListLoading();
        }).catch(function (e) {
            console.error('refresh all xiaohongshu accounts failed', e);
            hideAccountListLoading();
        });
    }

    function showAccountListLoading(text) {
        const host = $('.v23_739');
        if (!host) return;
        let overlay = $('#pub-account-list-loading');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'pub-account-list-loading';
            overlay.className = 'pub-account-list-loading';
            const spinner = document.createElement('div');
            spinner.className = 'pub-account-list-spinner';
            const txt = document.createElement('div');
            txt.className = 'pub-account-list-loading-text';
            txt.textContent = text || '正在刷新...';
            overlay.appendChild(spinner);
            overlay.appendChild(txt);
            host.appendChild(overlay);
        } else {
            const txt = overlay.querySelector('.pub-account-list-loading-text');
            if (txt && text) txt.textContent = text;
            overlay.style.display = '';
        }
    }

    function hideAccountListLoading() {
        const overlay = $('#pub-account-list-loading');
        if (overlay) overlay.style.display = 'none';
    }

    function renderAccountList() {
        const container = getAccountContainer();
        if (!container) return;
        const accounts = loadPublishAccounts();
        const activeId = getActiveAccountId();
        container.innerHTML = '';

        if (accounts.length === 0) {
            setEmptyStateVisible(true);
        } else {
            setEmptyStateVisible(false);
            accounts.forEach(function (acc) {
                const card = document.createElement('div');
                card.className = 'pub-account-card' + (acc.id === activeId ? ' active' : '');
                card.dataset.accountId = acc.id;
                card.addEventListener('click', function () { selectAccount(acc.id); });

                const icon = document.createElement('div');
                icon.className = 'pub-account-icon pub-account-icon-' + acc.platform;
                icon.textContent = getPlatformLabel(acc.platform).charAt(0);

                const info = document.createElement('div');
                info.className = 'pub-account-info';

                const name = document.createElement('div');
                name.className = 'pub-account-name';
                name.textContent = acc.displayName || acc.accountName || getPlatformLabel(acc.platform);

                const checking = isAccountChecking(acc.id);
                const expired = isAccountExpired(acc.id);
                const statusRow = document.createElement('div');
                statusRow.style.display = 'flex';
                statusRow.style.alignItems = 'center';

                const status = document.createElement('div');
                status.className = 'pub-account-status' +
                    (acc.loggedIn ? ' logged-in' : '') +
                    (checking ? ' checking' : '') +
                    (!acc.loggedIn && expired ? ' expired' : '');
                if (acc.loggedIn) status.textContent = '已登录';
                else if (checking) status.textContent = '检测中...';
                else if (expired) status.textContent = '已过期';
                else status.textContent = '未登录';

                statusRow.appendChild(status);

                // 小红书未登录/过期账号显示“刷新登录”按钮
                if (acc.platform === 'xiaohongshu' && !acc.loggedIn && !checking) {
                    const refresh = document.createElement('span');
                    refresh.className = 'pub-account-refresh';
                    refresh.textContent = '刷新登录';
                    refresh.title = '重新扫码登录';
                    refresh.addEventListener('click', function (e) {
                        e.stopPropagation();
                        loginXiaohongshuAccount(acc, function () {
                            updateAccountLoginStatus(acc.id, true);
                        }, function (err) {
                            console.error('刷新登录失败', err);
                        });
                    });
                    statusRow.appendChild(refresh);
                }

                const del = document.createElement('div');
                del.className = 'pub-account-delete';
                del.textContent = '×';
                del.title = '删除账号';
                del.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (confirm('确定删除该账号吗？')) removeAccount(acc.id);
                });

                info.appendChild(name);
                info.appendChild(statusRow);
                card.appendChild(icon);
                card.appendChild(info);
                card.appendChild(del);
                container.appendChild(card);
            });
        }

        updatePublishButtonText();
        updatePublishButtonState();
    }

    function selectAccount(id) {
        const accounts = loadPublishAccounts();
        if (!accounts.find(function (a) { return a.id === id; })) return;
        setActiveAccountId(id);
        renderAccountList();
        updatePublishButtonState();
    }

    function addAccount(account) {
        const accounts = loadPublishAccounts();
        accounts.push(account);
        savePublishAccounts(accounts);
        setActiveAccountId(account.id);
        renderAccountList();
    }

    function updateAccountLoginStatus(id, loggedIn) {
        const accounts = loadPublishAccounts();
        const idx = accounts.findIndex(function (a) { return a.id === id; });
        if (idx < 0) return;
        accounts[idx].loggedIn = loggedIn;
        accounts[idx].lastLoggedIn = loggedIn;
        accounts[idx].lastStatusAt = Date.now();
        savePublishAccounts(accounts);
        if (loggedIn) setAccountExpired(id, false);
        renderAccountList();
    }

    function isAccountStatusFresh(account) {
        if (!account) return false;
        if (typeof account.lastStatusAt !== 'number') return false;
        // 30 分钟内认为状态缓存有效
        return (Date.now() - account.lastStatusAt) < 30 * 60 * 1000;
    }

    function getNextXiaohongshuServicePort() {
        const accounts = loadPublishAccounts();
        const ports = accounts
            .filter(function (a) { return a.platform === 'xiaohongshu' && a.servicePort; })
            .map(function (a) { return a.servicePort; });
        let port = 18060;
        while (ports.indexOf(port) >= 0) port++;
        return port;
    }

    function makeXiaohongshuCookiePath(accountId) {
        return 'localdep/xiaohongshu-mcp/data/cookies.' + accountId + '.json';
    }

    function removeAccount(id) {
        let accounts = loadPublishAccounts();
        accounts = accounts.filter(function (a) { return a.id !== id; });
        savePublishAccounts(accounts);
        const activeId = getActiveAccountId();
        if (activeId === id) {
            setActiveAccountId(accounts.length ? accounts[0].id : '');
        }
        renderAccountList();
    }

    function ensureAddAccountModal() {
        let modal = $('#pub-add-account-modal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'pub-add-account-modal';
        modal.addEventListener('click', function (e) {
            if (e.target === modal) modal.classList.remove('active');
        });

        const card = document.createElement('div');
        card.className = 'pub-modal-card';

        const header = document.createElement('div');
        header.className = 'pub-modal-header';
        const title = document.createElement('div');
        title.className = 'pub-modal-title';
        title.textContent = '添加发布账号';
        const close = document.createElement('div');
        close.className = 'pub-modal-close';
        close.innerHTML = '&times;';
        close.addEventListener('click', function () { modal.classList.remove('active'); });
        header.appendChild(title);
        header.appendChild(close);

        function createRow(labelText, inputEl, tagHtml) {
            const row = document.createElement('div');
            row.className = 'pub-form-row';
            const label = document.createElement('label');
            label.className = 'pub-label';
            const span = document.createElement('span');
            span.textContent = labelText;
            label.appendChild(span);
            if (tagHtml) {
                const tag = document.createElement('span');
                tag.className = 'pub-field-tag';
                tag.innerHTML = tagHtml;
                label.appendChild(tag);
            }
            row.appendChild(label);
            row.appendChild(inputEl);
            return row;
        }

        const select = document.createElement('select');
        select.className = 'pub-select';
        [
            { key: 'xiaohongshu', label: '小红书' }
        ].forEach(function (p) {
            const opt = document.createElement('option');
            opt.value = p.key;
            opt.textContent = p.label;
            select.appendChild(opt);
        });
        const platformRow = createRow('平台类型', select, '<span class="pub-required">*</span>');

        const accountInput = document.createElement('input');
        accountInput.type = 'text';
        accountInput.className = 'pub-input';
        accountInput.placeholder = '请输入账号名称或用户名';
        accountInput.addEventListener('input', function () {
            if (accountInput.value.trim()) accountInput.style.borderColor = '';
        });
        const accountRow = createRow('账号名称', accountInput, '<span class="pub-required">*</span>');

        const displayInput = document.createElement('input');
        displayInput.type = 'text';
        displayInput.className = 'pub-input';
        displayInput.placeholder = '选填，用于展示';
        const displayRow = createRow('显示名称', displayInput, '<span class="pub-optional">可选</span>');

        const hint = document.createElement('div');
        hint.className = 'pub-modal-hint';
        hint.textContent = '添加后将自动打开浏览器，请使用小红书 App 扫码登录，登录成功后即可用于一键发布。';

        const footer = document.createElement('div');
        footer.className = 'pub-modal-footer';
        const cancel = document.createElement('button');
        cancel.className = 'pub-btn pub-btn-secondary';
        cancel.textContent = '取消';
        cancel.addEventListener('click', function () { modal.classList.remove('active'); });
        const confirm = document.createElement('button');
        confirm.className = 'pub-btn pub-btn-primary';
        confirm.textContent = '确认添加';
        confirm.addEventListener('click', function () {
            if (!accountInput.value.trim()) {
                accountInput.style.borderColor = '#ff5f56';
                return;
            }
            accountInput.style.borderColor = '';

            const platform = select.value;
            const account = {
                id: generateAccountId(),
                platform: platform,
                accountName: accountInput.value.trim(),
                displayName: displayInput.value.trim(),
                loggedIn: false
            };

            // 小红书账号需要独立的端口和 cookie 文件，用于多账号隔离
            if (platform === 'xiaohongshu') {
                account.servicePort = getNextXiaohongshuServicePort();
                account.cookiePath = makeXiaohongshuCookiePath(account.id);
            }

            addAccount(account);
            modal.classList.remove('active');
            accountInput.value = '';
            displayInput.value = '';

            // 自动进入登录流程
            setTimeout(function () {
                loginXiaohongshuAccount(account, function () {
                    updateAccountLoginStatus(account.id, true);
                });
            }, 100);
        });
        footer.appendChild(cancel);
        footer.appendChild(confirm);

        card.appendChild(header);
        card.appendChild(platformRow);
        card.appendChild(accountRow);
        card.appendChild(displayRow);
        card.appendChild(hint);
        card.appendChild(footer);
        modal.appendChild(card);

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && modal.classList.contains('active')) {
                modal.classList.remove('active');
            }
        });

        const root = $('.v23_761') || document.body;
        root.appendChild(modal);
        return modal;
    }

    function openAddAccountModal() {
        const modal = ensureAddAccountModal();
        modal.classList.add('active');
    }

    function setupAddAccountModal() {
        const emptyBtn = $('.v23_745');
        const emptyText = $('.v23_742');
        if (emptyBtn) {
            emptyBtn.style.cursor = 'pointer';
            emptyBtn.addEventListener('click', openAddAccountModal);
        }
        if (emptyText) {
            emptyText.style.cursor = 'pointer';
            emptyText.addEventListener('click', openAddAccountModal);
        }
        const topBtn = $('.v23_730');
        const topText = $('.v23_731');
        if (topBtn) {
            topBtn.style.cursor = 'pointer';
            topBtn.addEventListener('click', openAddAccountModal);
        }
        if (topText) {
            topText.style.cursor = 'pointer';
            topText.addEventListener('click', openAddAccountModal);
        }
        const bottomBtn = $('.v23_747');
        if (bottomBtn) {
            bottomBtn.style.cursor = 'pointer';
            bottomBtn.addEventListener('click', openAddAccountModal);
        }
    }

    function setupPublishEditableBoxes() {
        const fields = [
            { sel: '.v23_711', placeholder: '请输入标题' },
            { sel: '.v23_715', placeholder: '请输入描述' },
            { sel: '.v23_717', placeholder: '请输入标签，用空格或回车分隔' }
        ];
        fields.forEach(function (f) {
            const el = $(f.sel);
            if (!el) return;
            el.contentEditable = 'true';
            el.setAttribute('data-placeholder', f.placeholder);
            el.addEventListener('focus', function () {
                el.style.borderColor = 'rgba(219,112,255,0.8)';
                el.style.boxShadow = '0 0 0 3px rgba(219,112,255,0.12)';
            });
            el.addEventListener('blur', function () {
                el.style.borderColor = '';
                el.style.boxShadow = '';
            });
            if (f.sel === '.v23_711' || f.sel === '.v23_717') {
                el.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') e.preventDefault();
                });
            }
        });
    }

    function setupPublishCoverButton() {
        // 主按钮区域（背景 + 文字 + 图标）
        const coverBtnBg = $('.v23_723');
        const coverBtnText = $('.v23_724');
        const coverBtnIcon = $('.v23_736');

        function pickCover() {
            console.log('[publish] pick cover clicked');
            nativeCall('pickFile').then(function (result) {
                console.log('[publish] pick cover result', result);
                if (result && result.path) {
                    console.log('cover picked', result.path);
                    setPublishCoverPath(result.path);
                }
            }).catch(function (e) { console.error('pickFile failed', e); });
        }

        setupGradientButton('.v23_724', '.v23_723', pickCover);

        // 图标也绑定点击（保险，避免 pointer-events 失效时无法响应）
        if (coverBtnIcon) {
            coverBtnIcon.style.pointerEvents = 'none';
            coverBtnIcon.addEventListener('click', pickCover);
        }

        // 封面预览区本身也可点击上传
        const coverPreview = $('.v23_720');
        if (coverPreview) {
            coverPreview.title = '点击上传封面';
            coverPreview.addEventListener('click', function (e) {
                console.log('[publish] cover preview clicked');
                pickCover();
            });
        }

        // 保持文字/图标事件穿透，让点击真正落到背景按钮上
        if (coverBtnText) coverBtnText.style.pointerEvents = 'none';
        if (coverBtnBg) coverBtnBg.style.pointerEvents = 'auto';
    }

    function setupPublishVideoButton() {
        setupGradientButton('.v23_665', '.v23_664', function () {
            nativeCall('pickFile').then(function (result) {
                jsLog('[debug] pickFile result=' + JSON.stringify(result));
                if (result && result.path) setPublishVideoPath(result.path);
            }).catch(function (e) { console.error('pickFile failed', e); });
        });
    }

    function setupPublishModeToggle() {
        const draftBtn = $('.v23_751');
        const directBtn = $('.v23_752');
        const draftText = $('.v23_753');
        const directText = $('.v23_754');
        if (!draftBtn || !directBtn) return;

        function setMode(isDraft) {
            document.body.setAttribute('data-publish-mode', isDraft ? 'draft' : 'direct');
            if (isDraft) {
                draftBtn.style.background = 'linear-gradient(rgba(219,112,255,1), rgba(55,87,254,1))';
                draftBtn.style.borderColor = 'transparent';
                directBtn.style.background = 'rgba(30,33,44,1)';
                directBtn.style.borderColor = 'rgba(44,48,66,1)';
                if (draftText) draftText.style.color = '#fff';
                if (directText) directText.style.color = 'rgba(255,255,255,0.55)';
            } else {
                directBtn.style.background = 'linear-gradient(rgba(219,112,255,1), rgba(55,87,254,1))';
                directBtn.style.borderColor = 'transparent';
                draftBtn.style.background = 'rgba(30,33,44,1)';
                draftBtn.style.borderColor = 'rgba(44,48,66,1)';
                if (directText) directText.style.color = '#fff';
                if (draftText) draftText.style.color = 'rgba(255,255,255,0.55)';
            }
        }

        draftBtn.addEventListener('click', function () { setMode(true); });
        directBtn.addEventListener('click', function () { setMode(false); });
        setMode(true);
    }

    function getPublishMode() {
        return document.body.getAttribute('data-publish-mode') || 'direct';
    }

    function getPublishVideoPath() {
        let path = document.body.getAttribute('data-publish-video') || '';
        if (!path) path = _getSession('vv_generated_video', '');
        return path;
    }

    function setPublishVideoPath(path) {
        path = path || '';
        document.body.setAttribute('data-publish-video', path);
        _setSession('vv_publish_video', path);
        renderPublishVideoPreview();
        updatePublishButtonState();
    }

    function getPublishCoverPath() {
        let path = document.body.getAttribute('data-publish-cover') || '';
        if (!path) path = _getSession('vv_banner_output_path', '');
        return path;
    }

    function resolveMediaUrl(path) {
        return nativeCall('resolveMediaUrl', { path: path }).then(function (res) {
            if (typeof res === 'string') { try { res = JSON.parse(res); } catch (e) { res = {}; } }
            if (res && res.url) return res.url;
            return Promise.reject(res && res.error ? res.error : '无法解析媒体地址');
        });
    }

    function jsLog(msg) {
        nativeCall('jsLog', { msg: String(msg) }).catch(function () {});
    }

    function checkBackendHealth() {
        if (window.__backendHealthChecked) return;
        window.__backendHealthChecked = true;

        nativeCall('getBackendBaseUrl').then(function (res) {
            if (typeof res === 'string') { try { res = JSON.parse(res); } catch (e) { res = {}; } }
            const baseUrl = (res && res.url) ? res.url : 'http://127.0.0.1:18080';
            fetch(baseUrl + '/api/health', {
                method: 'GET',
                mode: 'cors',
                cache: 'no-cache'
            }).then(function (resp) {
                return resp.json().then(function (data) {
                    console.log('[backend] health ok', data);
                    jsLog('[backend] health ok: ' + JSON.stringify(data));
                });
            }).catch(function (err) {
                console.warn('[backend] health check failed', err);
                jsLog('[backend] health check failed: ' + err);
            });
        }).catch(function (err) {
            console.warn('[backend] getBackendBaseUrl failed', err);
        });
    }

    function setPublishCoverPath(path) {
        path = path || '';
        document.body.setAttribute('data-publish-cover', path);
        _setSession('vv_publish_cover', path);
        renderPublishCoverPreview();
    }

    function renderPublishVideoPreview() {
        const container = $('.v23_701');
        if (!container) return;
        const path = getPublishVideoPath();
        container.innerHTML = '';
        // .v23_701 已经是 position:absolute，作为子元素的定位包含块，不需要改成 relative
        console.log('[publish] render video preview, path=', path);

        const filenameEl = $('.v23_705');
        if (filenameEl) {
            if (path) {
                const parts = path.replace(/\\/g, '/').split('/');
                filenameEl.textContent = parts[parts.length - 1];
                filenameEl.style.display = '';
            } else {
                filenameEl.textContent = '';
                filenameEl.style.display = 'none';
            }
        }

        if (!path) {
            const placeholder = document.createElement('div');
            placeholder.className = 'pub-video-placeholder';
            placeholder.textContent = '暂无视频，请点击右上角上传';
            container.appendChild(placeholder);
            return;
        }

        jsLog('[debug] render video path=' + path);

        // 当前页面通过 file:// 加载，视频直接用 file:/// 路径即可在 WebView2 中预览
        const encoded = encodeURI(path.replace(/\\/g, '/'));
        renderPublishVideoPlayer('file:///' + encoded, path, container);
    }

    function renderPublishVideoPlayer(url, path, container) {
        jsLog('[debug] create video element, url=' + url + ' containerSize=' + container.offsetWidth + 'x' + container.offsetHeight);

        const video = document.createElement('video');
        video.className = 'pub-video-player';
        video.src = url;
        video.controls = true;
        video.muted = false;
        video.preload = 'auto';
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.display = 'block';
        video.style.objectFit = 'contain';
        video.style.background = '#000';
        video.style.borderRadius = '20px';
        video.classList.add('paused');

        const overlay = document.createElement('div');
        overlay.className = 'pub-video-overlay';
        overlay.innerHTML = '<div class="play-icon">▶</div>';

        function updateOverlay() {
            if (video.paused) {
                video.classList.add('paused');
                video.classList.remove('playing');
                overlay.style.opacity = '1';
            } else {
                video.classList.remove('paused');
                video.classList.add('playing');
                overlay.style.opacity = '0';
            }
        }

        video.addEventListener('loadstart', function () { jsLog('[debug] video loadstart'); });
        video.addEventListener('loadedmetadata', function () {
            jsLog('[debug] video loadedmetadata duration=' + video.duration + ' size=' + video.videoWidth + 'x' + video.videoHeight);
            updateOverlay();
        });
        video.addEventListener('canplay', function () { jsLog('[debug] video canplay'); });
        video.addEventListener('playing', function () { jsLog('[debug] video playing'); });
        video.addEventListener('play', updateOverlay);
        video.addEventListener('pause', updateOverlay);
        video.addEventListener('ended', updateOverlay);

        // 点击播放浮层切换播放/暂停；播放后隐藏浮层，原生控制条接管
        overlay.style.cursor = 'pointer';
        overlay.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (video.paused) video.play().catch(function () {});
            else video.pause();
        });

        video.onerror = function () {
            jsLog('[debug] video error: ' + (video.error ? ('code=' + video.error.code + ' msg=' + video.error.message) : 'unknown'));
            console.error('video preview failed', path, video.error);
            container.innerHTML = '';
            const err = document.createElement('div');
            err.className = 'pub-video-placeholder';
            err.innerHTML = '视频预览加载失败<br><small>可尝试用系统播放器打开</small>';
            err.style.cursor = 'pointer';
            err.addEventListener('click', function () {
                nativeCall('openFileLocation', { path: path }).catch(function (e) { console.error(e); });
            });
            container.appendChild(err);
        };
        video.onloadedmetadata = function () {
            console.log('video preview ready', path, video.duration);
            updateOverlay();
        };

        container.appendChild(video);
        container.appendChild(overlay);
        updateOverlay();

        // 调试：输出容器与视频元素的计算样式和尺寸
        setTimeout(function () {
            var csContainer = getComputedStyle(container);
            var csVideo = getComputedStyle(video);
            var csOverlay = getComputedStyle(overlay);
            var rectContainer = container.getBoundingClientRect();
            var rectVideo = video.getBoundingClientRect();
            var rectOverlay = overlay.getBoundingClientRect();
            var root = $('.v23_761');
            var rootRect = root ? root.getBoundingClientRect() : null;
            jsLog('[debug] windowSize=' + window.innerWidth + 'x' + window.innerHeight + ' scroll=' + (window.pageXOffset|0) + ',' + (window.pageYOffset|0) + ' dpr=' + window.devicePixelRatio);
            jsLog('[debug] root rect=' + JSON.stringify(rootRect ? {l:rootRect.left,t:rootRect.top,w:rootRect.width,h:rootRect.height} : null));
            jsLog('[debug] styles container: z=' + csContainer.zIndex + ' pos=' + csContainer.position + ' vis=' + csContainer.visibility + ' disp=' + csContainer.display + ' overflow=' + csContainer.overflow + ' rect=' + JSON.stringify({l:rectContainer.left,t:rectContainer.top,w:rectContainer.width,h:rectContainer.height}));
            jsLog('[debug] styles video: z=' + csVideo.zIndex + ' pos=' + csVideo.position + ' vis=' + csVideo.visibility + ' disp=' + csVideo.display + ' opacity=' + csVideo.opacity + ' objectFit=' + csVideo.objectFit + ' rect=' + JSON.stringify({l:rectVideo.left,t:rectVideo.top,w:rectVideo.width,h:rectVideo.height}));
            jsLog('[debug] styles overlay: z=' + csOverlay.zIndex + ' pos=' + csOverlay.position + ' vis=' + csOverlay.visibility + ' disp=' + csOverlay.display + ' opacity=' + csOverlay.opacity + ' rect=' + JSON.stringify({l:rectOverlay.left,t:rectOverlay.top,w:rectOverlay.width,h:rectOverlay.height}));
        }, 100);
    }

    function renderPublishCoverPreview() {
        const container = $('.v23_720');
        if (!container) return;
        const path = getPublishCoverPath();
        container.innerHTML = '';
        if (!path) {
            const placeholder = document.createElement('div');
            placeholder.className = 'pub-cover-placeholder';
            placeholder.textContent = '暂无封面';
            container.appendChild(placeholder);
            return;
        }

        const encoded = encodeURI(path.replace(/\\/g, '/'));
        const img = document.createElement('img');
        img.className = 'pub-cover-preview';
        img.src = 'file:///' + encoded + '?t=' + Date.now();
        img.alt = '封面预览';
        container.appendChild(img);
    }

    function loadPublishData() {
        const titleEl = $('.v23_711');
        const descEl = $('.v23_715');
        const tagsEl = $('.v23_717');

        const title = _getSession('vv_banner_title', '')
            || _getSession('vv_voice_text', '')
            || _getSession('vv_extracted_text', '')
            || '';
        const desc = _getSession('vv_voice_text', '')
            || _getSession('vv_extracted_text', '')
            || '';

        if (title && titleEl && !titleEl.textContent.trim()) {
            titleEl.textContent = title.slice(0, 20);
        }
        if (desc && descEl && !descEl.textContent.trim()) {
            descEl.textContent = desc;
        }
        if (tagsEl && !tagsEl.textContent.trim()) {
            tagsEl.textContent = '';
        }

        setPublishVideoPath(getPublishVideoPath());
        setPublishCoverPath(getPublishCoverPath());
        updatePublishButtonState();
    }

    function ensureQrModal() {
        let modal = $('#pub-qr-modal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'pub-qr-modal';
        modal.className = 'pub-qr-modal';
        modal.addEventListener('click', function (e) {
            if (e.target === modal) closeQrModal();
        });

        const card = document.createElement('div');
        card.className = 'pub-qr-card';

        const header = document.createElement('div');
        header.className = 'pub-qr-header';
        const title = document.createElement('div');
        title.id = 'pub-qr-title';
        title.className = 'pub-qr-title';
        title.textContent = '扫码登录';
        const close = document.createElement('div');
        close.className = 'pub-qr-close';
        close.innerHTML = '&times;';
        close.addEventListener('click', closeQrModal);
        header.appendChild(title);
        header.appendChild(close);

        const img = document.createElement('img');
        img.id = 'pub-qr-img';
        img.className = 'pub-qr-img';
        img.alt = '登录二维码';

        const status = document.createElement('div');
        status.id = 'pub-qr-status';
        status.className = 'pub-qr-status';
        status.textContent = '请使用 App 扫码登录';

        card.appendChild(header);
        card.appendChild(img);
        card.appendChild(status);
        modal.appendChild(card);

        const root = $('.v23_761') || document.body;
        root.appendChild(modal);
        return modal;
    }

    function showQrModal(platform, imgDataUrl, timeoutText) {
        const modal = ensureQrModal();
        const title = $('#pub-qr-title');
        const img = $('#pub-qr-img');
        const status = $('#pub-qr-status');
        const platformNames = { 'douyin': '抖音', 'xiaohongshu': '小红书', 'kuaishou': '快手' };
        const platformName = platformNames[platform] || '小红书';
        if (title) title.textContent = platformName + '扫码登录';
        if (img) img.src = imgDataUrl;
        if (status) status.textContent = '请使用' + platformName + ' App 在 ' + (timeoutText || '4分0秒') + ' 内扫码登录';
        modal.classList.add('active');
    }

    function closeQrModal() {
        const modal = $('#pub-qr-modal');
        if (modal) modal.classList.remove('active');
        if (window.__pubQrTimer) {
            clearInterval(window.__pubQrTimer);
            window.__pubQrTimer = null;
        }
    }

    function ensureXiaohongshuLoginModal() {
        let modal = $('#pub-xhs-login-modal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'pub-xhs-login-modal';
        modal.className = 'pub-qr-modal';
        modal.addEventListener('click', function (e) {
            if (e.target === modal && !modal.dataset.busy) cancelXiaohongshuLoginModal();
        });

        const card = document.createElement('div');
        card.className = 'pub-qr-card';

        const header = document.createElement('div');
        header.className = 'pub-qr-header';
        const title = document.createElement('div');
        title.className = 'pub-qr-title';
        title.textContent = '小红书账号登录';
        const close = document.createElement('div');
        close.className = 'pub-qr-close';
        close.innerHTML = '&times;';
        close.id = 'pub-xhs-login-close';
        close.addEventListener('click', function () {
            cancelXiaohongshuLoginModal();
        });
        header.appendChild(title);
        header.appendChild(close);

        const body = document.createElement('div');
        body.className = 'pub-qr-status';
        body.id = 'pub-xhs-login-status';
        body.textContent = '正在打开浏览器，请使用小红书 App 扫码登录...';

        const footer = document.createElement('div');
        footer.className = 'pub-xhs-login-footer';
        footer.id = 'pub-xhs-login-footer';

        const btnLoggedIn = document.createElement('button');
        btnLoggedIn.className = 'pub-btn pub-btn-primary';
        btnLoggedIn.textContent = '我已登录';
        btnLoggedIn.addEventListener('click', function () {
            dismissXiaohongshuLoginModal();
        });

        const btnClose = document.createElement('button');
        btnClose.className = 'pub-btn pub-btn-secondary';
        btnClose.textContent = '关闭';
        btnClose.addEventListener('click', function () {
            dismissXiaohongshuLoginModal();
        });

        footer.appendChild(btnLoggedIn);
        footer.appendChild(btnClose);

        card.appendChild(header);
        card.appendChild(body);
        card.appendChild(footer);
        modal.appendChild(card);

        const root = $('.v23_761') || document.body;
        root.appendChild(modal);
        return modal;
    }

    function showXiaohongshuLoginModal(message) {
        const modal = ensureXiaohongshuLoginModal();
        const status = $('#pub-xhs-login-status');
        if (status) status.textContent = message || '正在打开浏览器，请使用小红书 App 扫码登录...';
        modal.dataset.busy = '1';
        modal.classList.add('active');
    }

    function setXiaohongshuLoginModal(message, allowClose) {
        const modal = $('#pub-xhs-login-modal');
        const status = $('#pub-xhs-login-status');
        if (status) status.textContent = message;
        if (allowClose) delete modal.dataset.busy;
    }

    function closeXiaohongshuLoginModal() {
        const modal = $('#pub-xhs-login-modal');
        if (modal) modal.classList.remove('active');
        if (window.__pubXhsLoginTimer) {
            clearInterval(window.__pubXhsLoginTimer);
            window.__pubXhsLoginTimer = null;
        }
        // 用户主动关闭弹窗时，通知 C++ 结束登录工具进程
        if (window.__pubXhsLoginAccount && window.__pubXhsLoginAccount.cookiePath) {
            nativeCall('stopXiaohongshuLogin', { cookiePath: window.__pubXhsLoginAccount.cookiePath }).catch(function (e) {
                console.error('stopXiaohongshuLogin failed', e);
            });
        }
        window.__pubXhsLoginAccount = null;
        window.__pubXhsLoginOnSuccess = null;
        window.__pubXhsLoginOnError = null;
    }

    function dismissXiaohongshuLoginModal() {
        const account = window.__pubXhsLoginAccount;
        const onSuccess = window.__pubXhsLoginOnSuccess;
        closeXiaohongshuLoginModal();
        if (account) {
            refreshSingleXiaohongshuLoginStatus(account, function (loggedIn) {
                if (loggedIn && onSuccess) {
                    onSuccess();
                } else if (!loggedIn) {
                    setXiaohongshuLoginModal('登录状态校验未通过，请重新扫码登录', true);
                }
            });
        }
    }

    function cancelXiaohongshuLoginModal() {
        // 用户主动取消登录/发布，清空回调避免继续发布
        window.__pubXhsLoginOnSuccess = null;
        window.__pubXhsLoginOnError = null;
        closeXiaohongshuLoginModal();
    }

    function loginXiaohongshuAccount(account, onSuccess, onError) {
        if (!account || account.platform !== 'xiaohongshu') {
            if (onError) onError('不是小红书账号');
            return;
        }

        window.__pubXhsLoginAccount = account;
        window.__pubXhsLoginOnSuccess = onSuccess;
        window.__pubXhsLoginOnError = onError;
        showXiaohongshuLoginModal('已打开浏览器，请使用小红书 App 扫码登录，完成后点击“我已登录”');

        nativeCall('startXiaohongshuLogin', { cookiePath: account.cookiePath }).then(function (res) {
            if (typeof res === 'string') { try { res = JSON.parse(res); } catch (e) { res = {}; } }
            if (res && res.error) {
                setXiaohongshuLoginModal('登录启动失败：' + res.error, true);
                window.__pubXhsLoginAccount = null;
                window.__pubXhsLoginOnSuccess = null;
                window.__pubXhsLoginOnError = null;
                if (onError) onError(res.error);
            }
        }).catch(function (e) {
            console.error('startXiaohongshuLogin failed', e);
            window.__pubXhsLoginAccount = null;
            window.__pubXhsLoginOnSuccess = null;
            window.__pubXhsLoginOnError = null;
            setXiaohongshuLoginModal('登录调用失败，请关闭后重试', true);
            if (onError) onError(e);
        });
    }

    function startQrPolling(platform, deadlineMs, onLoggedIn) {
        if (window.__pubQrTimer) clearInterval(window.__pubQrTimer);
        const statusCalls = {
            'douyin': 'getDouyinLoginStatus',
            'xiaohongshu': 'getXiaohongshuLoginStatus',
            'kuaishou': 'getKuaishouLoginStatus'
        };
        const statusCall = statusCalls[platform] || 'getXiaohongshuLoginStatus';
        window.__pubQrTimer = setInterval(function () {
            nativeCall(statusCall).then(function (res) {
                if (typeof res === 'string') { try { res = JSON.parse(res); } catch (e) { res = {}; } }
                if (res && res.data && res.data.is_logged_in) {
                    closeQrModal();
                    onLoggedIn();
                    return;
                }
                if (Date.now() > deadlineMs) {
                    closeQrModal();
                    alert('扫码登录超时，请重试');
                }
            }).catch(function (e) {
                console.error('login status poll failed', e);
            });
        }, 2000);
    }

    function ensurePublishOverlay() {
        let overlay = $('#pub-publish-overlay');
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.id = 'pub-publish-overlay';
        overlay.className = 'pub-publish-overlay';
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay && !overlay.dataset.busy) {
                overlay.classList.remove('active');
            }
        });

        const box = document.createElement('div');
        box.className = 'pub-publish-box';

        const spinner = document.createElement('div');
        spinner.className = 'pub-publish-spinner';

        const icon = document.createElement('div');
        icon.className = 'pub-publish-icon';
        icon.innerHTML = '<svg viewBox="0 0 24 24" width="40" height="40"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>';

        const text = document.createElement('div');
        text.className = 'pub-publish-text';
        text.textContent = '正在发布...';

        const detail = document.createElement('div');
        detail.className = 'pub-publish-detail';

        const close = document.createElement('button');
        close.className = 'pub-publish-close';
        close.textContent = '我知道了';
        close.addEventListener('click', function () {
            overlay.classList.remove('active');
        });

        box.appendChild(spinner);
        box.appendChild(icon);
        box.appendChild(text);
        box.appendChild(detail);
        box.appendChild(close);
        overlay.appendChild(box);

        const root = $('.v23_761') || document.body;
        root.appendChild(overlay);
        return overlay;
    }

    function setPublishOverlay(active, text) {
        const overlay = ensurePublishOverlay();
        const spinner = overlay.querySelector('.pub-publish-spinner');
        const icon = overlay.querySelector('.pub-publish-icon');
        const txt = overlay.querySelector('.pub-publish-text');
        const detail = overlay.querySelector('.pub-publish-detail');
        const close = overlay.querySelector('.pub-publish-close');

        if (active) {
            if (spinner) spinner.style.display = '';
            if (icon) icon.style.display = 'none';
            if (txt) {
                txt.textContent = text || '正在发布...';
                txt.className = 'pub-publish-text';
            }
            if (detail) { detail.textContent = ''; detail.style.display = 'none'; }
            if (close) close.style.display = 'none';
            overlay.dataset.busy = '1';
            overlay.classList.add('active');
        } else {
            overlay.classList.remove('active');
            delete overlay.dataset.busy;
        }
    }

    function setPublishResult(titleText, message, isError) {
        const overlay = ensurePublishOverlay();
        const spinner = overlay.querySelector('.pub-publish-spinner');
        const icon = overlay.querySelector('.pub-publish-icon');
        const txt = overlay.querySelector('.pub-publish-text');
        const detail = overlay.querySelector('.pub-publish-detail');
        const close = overlay.querySelector('.pub-publish-close');

        if (spinner) spinner.style.display = 'none';
        if (icon) {
            icon.style.display = '';
            if (isError) {
                icon.classList.add('error');
                icon.innerHTML = '<svg viewBox="0 0 24 24" width="40" height="40"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="currentColor"/></svg>';
            } else {
                icon.classList.remove('error');
                icon.innerHTML = '<svg viewBox="0 0 24 24" width="40" height="40"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>';
            }
        }
        if (txt) {
            txt.textContent = titleText || (isError ? '发布失败' : '发布完成');
            txt.className = 'pub-publish-text' + (isError ? ' error' : ' success');
        }
        if (detail) {
            detail.textContent = message || '';
            detail.style.display = '';
        }
        if (close) close.style.display = '';
        delete overlay.dataset.busy;
        overlay.classList.add('active');
    }

    function doPublishXiaohongshu() {
        const titleEl = $('.v23_711');
        const descEl = $('.v23_715');
        const tagsEl = $('.v23_717');
        const title = (titleEl ? titleEl.textContent : '').trim();
        const content = (descEl ? descEl.textContent : '').trim();
        const tagsRaw = (tagsEl ? tagsEl.textContent : '').trim();
        const videoPath = getPublishVideoPath();
        const mode = getPublishMode();
        const isDraft = mode === 'draft';
        const active = getActiveAccount();

        if (!title) { setPublishResult('缺少标题', '请输入标题', true); return; }
        if (title.length > 20) { setPublishResult('标题过长', '小红书标题不能超过 20 个字', true); return; }
        if (!videoPath) { setPublishResult('缺少视频', '请选择要发布的视频', true); return; }
        if (!active || active.platform !== 'xiaohongshu') { setPublishResult('未选择账号', '请先选择小红书账号', true); return; }

        const tags = tagsRaw ? tagsRaw.split(/[\s,，]+/).filter(function (t) { return t; }) : [];

        const runningText = isDraft ? '正在打开小红书创作平台...' : '正在发布视频到小红书...';
        setPublishOverlay(true, runningText);

        const coverPath = getPublishCoverPath();

        nativeCall('publishXiaohongshu', {
            title: title,
            content: content,
            video: videoPath.replace(/\\/g, '/'),
            cover: coverPath ? coverPath.replace(/\\/g, '/') : '',
            tags: tags,
            mode: mode,
            servicePort: active.servicePort || 18060,
            cookiePath: active.cookiePath || ''
        }).then(function (result) {
            if (typeof result === 'string') { try { result = JSON.parse(result); } catch (e) { result = { error: result }; } }
            if (!result || result.error || !result.taskId) {
                setPublishResult('发布失败', result.error || '未知错误', true);
                return;
            }
            const taskId = result.taskId;
            const timer = setInterval(function () {
                nativeCall('checkXiaohongshuTask', { taskId: taskId }).then(function (check) {
                    if (typeof check === 'string') { try { check = JSON.parse(check); } catch (e) { check = {}; } }
                    if (!check || check.status === 'running') {
                        if (check && check.message) setPublishOverlay(true, check.message);
                        return;
                    }
                    clearInterval(timer);
                    if (check.status === 'done') {
                        const active = getActiveAccount();
                        if (active && active.platform === 'xiaohongshu') {
                            updateAccountLoginStatus(active.id, true);
                        }
                        if (isDraft) {
                            setPublishResult('创作平台已打开', '已在小红书创作平台填好视频、封面、标题、描述和标签，请继续编辑并保存草稿。');
                        } else {
                            const postId = check.post_id || '';
                            setPublishResult('发布完成', '已公开发布到小红书' + (postId ? '，笔记ID：' + postId : ''));
                        }
                    } else {
                        setPublishResult('发布失败', check.error || '未知错误', true);
                    }
                }).catch(function (e) {
                    clearInterval(timer);
                    setPublishResult('发布失败', '查询发布结果失败', true);
                });
            }, 800);
        }).catch(function (e) {
            setPublishResult('发布失败', '调用发布失败', true);
        });
    }

    function loginPlatform(platform, onSuccess) {
        // 小红书已改为浏览器登录工具扫码，不走通用二维码流程
        if (platform === 'xiaohongshu') {
            const active = getActiveAccount();
            if (!active || active.platform !== 'xiaohongshu') {
                setPublishResult('未选择账号', '请先选择一个小红书账号', true);
                return;
            }
            loginXiaohongshuAccount(active, onSuccess);
            return;
        }

        const statusCalls = {
            'douyin': 'getDouyinLoginStatus',
            'kuaishou': 'getKuaishouLoginStatus'
        };
        const qrcodeCalls = {
            'douyin': 'getDouyinQrcode',
            'kuaishou': 'getKuaishouQrcode'
        };
        const statusCall = statusCalls[platform];
        const qrcodeCall = qrcodeCalls[platform];
        if (!statusCall || !qrcodeCall) {
            alert('未知平台: ' + platform);
            return;
        }

        nativeCall(statusCall).then(function (res) {
            if (typeof res === 'string') { try { res = JSON.parse(res); } catch (e) { res = {}; } }
            if (res && res.error) {
                alert(res.error);
                return;
            }
            if (res && res.data && res.data.is_logged_in) {
                onSuccess();
                return;
            }
            return nativeCall(qrcodeCall);
        }).then(function (qr) {
            if (!qr) return;
            if (typeof qr === 'string') { try { qr = JSON.parse(qr); } catch (e) { qr = {}; } }
            if (qr && qr.error) {
                alert(qr.error);
                return;
            }
            if (qr && qr.data && qr.data.is_logged_in) {
                onSuccess();
                return;
            }
            const img = qr && qr.data && qr.data.img ? qr.data.img : '';
            const timeout = qr && qr.data && qr.data.timeout ? qr.data.timeout : '4m0s';
            if (!img) {
                alert('未能获取登录二维码');
                return;
            }
            showQrModal(platform, img, timeout);
            const deadline = Date.now() + 4 * 60 * 1000;
            startQrPolling(platform, deadline, onSuccess);
        }).catch(function (e) {
            console.error(platform + ' login flow failed', e);
            const labels = { 'xiaohongshu': '小红书', 'douyin': '抖音', 'kuaishou': '快手' };
            setPublishResult('登录流程失败', labels[platform] + ' 登录流程失败，请确认对应 MCP 服务已配置', true);
        });
    }

    function publishXiaohongshuNow() {
        const active = getActiveAccount();
        if (!active || active.platform !== 'xiaohongshu') {
            setPublishResult('未选择账号', '请先选择一个小红书账号', true);
            return;
        }

        // 发布前必须实际检查选中账号的登录状态，避免 UI 缓存过期导致误操作
        setPublishOverlay(true, '正在检查账号登录状态...');

        nativeCall('getXiaohongshuLoginStatus', {
            cookiePath: active.cookiePath,
            servicePort: active.servicePort || 18060
        }).then(function (res) {
            if (typeof res === 'string') { try { res = JSON.parse(res); } catch (e) { res = {}; } }
            const loggedIn = !!(res && res.data && res.data.is_logged_in);
            updateAccountLoginStatus(active.id, loggedIn);

            if (!loggedIn) {
                setAccountExpired(active.id, true);
                setPublishResult('账号登录已过期', '当前账号登录状态已过期，请先在账号列表中刷新登录状态', true);
                return;
            }

            doPublishXiaohongshu();
        }).catch(function (e) {
            console.error('check login status before publish failed', e);
            setPublishResult('检查失败', '检查账号状态失败，请重试', true);
        });
    }

    function doPublishDouyin() {
        const titleEl = $('.v23_711');
        const descEl = $('.v23_715');
        const tagsEl = $('.v23_717');
        const title = (titleEl ? titleEl.textContent : '').trim();
        const content = (descEl ? descEl.textContent : '').trim();
        const tagsRaw = (tagsEl ? tagsEl.textContent : '').trim();
        const videoPath = getPublishVideoPath();
        const coverPath = getPublishCoverPath();

        if (!title) { alert('请输入标题'); return; }
        if (!videoPath) { alert('请选择要发布的视频'); return; }

        const tags = tagsRaw ? tagsRaw.split(/[\s,，]+/).filter(function (t) { return t; }) : [];

        setPublishOverlay(true, '正在发布到抖音...');

        nativeCall('publishDouyin', {
            title: title,
            content: content,
            video: videoPath.replace(/\\/g, '/'),
            cover: coverPath ? coverPath.replace(/\\/g, '/') : '',
            tags: tags,
            mode: getPublishMode()
        }).then(function (result) {
            if (typeof result === 'string') { try { result = JSON.parse(result); } catch (e) { result = { error: result }; } }
            if (!result || result.error || !result.taskId) {
                setPublishOverlay(false);
                alert('发布失败：' + (result.error || '未知错误'));
                return;
            }
            const taskId = result.taskId;
            const timer = setInterval(function () {
                nativeCall('checkDouyinTask', { taskId: taskId }).then(function (check) {
                    if (typeof check === 'string') { try { check = JSON.parse(check); } catch (e) { check = {}; } }
                    if (!check || check.status === 'running') {
                        if (check && check.message) setPublishOverlay(true, check.message);
                        return;
                    }
                    clearInterval(timer);
                    setPublishOverlay(false);
                    if (check.status === 'done') {
                        alert('发布成功' + (check.post_id ? '，作品ID：' + check.post_id : ''));
                    } else {
                        alert('发布失败：' + (check.error || '未知错误'));
                    }
                }).catch(function (e) {
                    clearInterval(timer);
                    setPublishOverlay(false);
                    alert('查询发布结果失败');
                });
            }, 800);
        }).catch(function (e) {
            setPublishOverlay(false);
            alert('调用发布失败');
        });
    }

    function publishDouyinNow() {
        loginPlatform('douyin', doPublishDouyin);
    }

    function doPublishKuaishou() {
        const titleEl = $('.v23_711');
        const descEl = $('.v23_715');
        const tagsEl = $('.v23_717');
        const title = (titleEl ? titleEl.textContent : '').trim();
        const content = (descEl ? descEl.textContent : '').trim();
        const tagsRaw = (tagsEl ? tagsEl.textContent : '').trim();
        const videoPath = getPublishVideoPath();
        const coverPath = getPublishCoverPath();

        if (!title) { alert('请输入标题'); return; }
        if (!videoPath) { alert('请选择要发布的视频'); return; }

        const tags = tagsRaw ? tagsRaw.split(/[\s,，]+/).filter(function (t) { return t; }) : [];

        setPublishOverlay(true, '正在发布到快手...');

        nativeCall('publishKuaishou', {
            title: title,
            content: content,
            video: videoPath.replace(/\\/g, '/'),
            cover: coverPath ? coverPath.replace(/\\/g, '/') : '',
            tags: tags,
            mode: getPublishMode()
        }).then(function (result) {
            if (typeof result === 'string') { try { result = JSON.parse(result); } catch (e) { result = { error: result }; } }
            if (!result || result.error || !result.taskId) {
                setPublishOverlay(false);
                alert('发布失败：' + (result.error || '未知错误'));
                return;
            }
            const taskId = result.taskId;
            const timer = setInterval(function () {
                nativeCall('checkKuaishouTask', { taskId: taskId }).then(function (check) {
                    if (typeof check === 'string') { try { check = JSON.parse(check); } catch (e) { check = {}; } }
                    if (!check || check.status === 'running') {
                        if (check && check.message) setPublishOverlay(true, check.message);
                        return;
                    }
                    clearInterval(timer);
                    setPublishOverlay(false);
                    if (check.status === 'done') {
                        alert('发布成功' + (check.post_id ? '，作品ID：' + check.post_id : ''));
                    } else {
                        alert('发布失败：' + (check.error || '未知错误'));
                    }
                }).catch(function (e) {
                    clearInterval(timer);
                    setPublishOverlay(false);
                    alert('查询发布结果失败');
                });
            }, 800);
        }).catch(function (e) {
            setPublishOverlay(false);
            alert('调用发布失败');
        });
    }

    function publishKuaishouNow() {
        loginPlatform('kuaishou', doPublishKuaishou);
    }

    function initPublishPage() {
        jsLog('[debug] initPublishPage called');
        setupStartNewTaskButton();
        setupSidebarInteractions();
        setupPublishNavButtons();
        setupAddAccountModal();
        setupPublishEditableBoxes();
        setupPublishCoverButton();
        setupPublishVideoButton();
        setupPublishModeToggle();
        renderAccountList();
        ensureAccountRefreshButton();
        updatePublishButtonState();
        refreshXiaohongshuLoginStatus();
        renderPublishVideoPreview();
        renderPublishCoverPreview();
        loadPublishData();
    }

    // ===================== 页面初始化 =====================
    function initLinkVideoExtractPage() {
        setupStartNewTaskButton();
        setupLinkInput();
        setupInputs();
        setupFilePicker();
        setupExtractButton();
        setupNextButton();
        setupSidebarInteractions();
        setupWebsiteShortcuts();
    }

    function loadExtractedTextIntoArticleRewrite() {
        try {
            const text = sessionStorage.getItem('vv_extracted_text');
            if (text) {
                const box = $('.v2_189');
                const placeholder = $('.v2_190');
                if (box) box.textContent = text;
                if (placeholder) placeholder.style.display = 'none';
                // 根据原文案字数智能匹配默认字数
                const charCount = text.replace(/\s/g, '').length;
                setLengthDropdown(pickNearestLength(charCount));
                sessionStorage.removeItem('vv_extracted_text');
            }
        } catch (e) {
            console.error('load extracted text failed', e);
        }
    }

    function initArticleRewritePage() {
        setupStartNewTaskButton();
        setupInputs();
        setupSidebarInteractions();
        loadExtractedTextIntoArticleRewrite();

        // 上一步 -> LinkVideoExtract
        setupGradientButton('.v2_184', '.v2_171', function () {
            navigateTo('LinkVideoExtract.html');
        });

        // 下一步 -> VoiceGenerate
        setupGradientButton('.v2_185', '.v2_183', function () {
            try {
                const outputBox = $('.v2_181');
                const inputBox = $('.v2_189');
                if (outputBox) sessionStorage.setItem('vv_voice_text', outputBox.textContent || '');
                if (inputBox) sessionStorage.setItem('vv_voice_fallback_text', inputBox.textContent || '');
            } catch (e) {
                console.error('save voice text failed', e);
            }
            navigateTo('VoiceGernerate.html');
        });

        setupRewriteButton();
        setupAICheckButton();
        setupArticleRewriteDropdowns();
    }

    function escapeHtml(text) {
        if (typeof text !== 'string') return '';
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function injectUserMenu() {
        if ($('#vv-user-menu')) return;

        const username = (localStorage.getItem('vv_username') || 'User').trim();
        const initial = username.charAt(0).toUpperCase() || 'U';

        const container = document.createElement('div');
        container.id = 'vv-user-menu';
        container.className = 'vv-user-menu';
        container.innerHTML =
            '<div class="vv-user-avatar" title="' + escapeHtml(username) + '">' + escapeHtml(initial) + '</div>' +
            '<div class="vv-user-dropdown">' +
            '<div class="vv-user-name">' + escapeHtml(username) + '</div>' +
            '<div class="vv-user-logout">退出登录</div>' +
            '</div>';

        document.body.appendChild(container);

        const avatar = container.querySelector('.vv-user-avatar');
        const dropdown = container.querySelector('.vv-user-dropdown');
        const logoutBtn = container.querySelector('.vv-user-logout');

        avatar.addEventListener('click', function (e) {
            e.stopPropagation();
            dropdown.classList.toggle('open');
        });

        logoutBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            logout();
        });

        document.addEventListener('click', function () {
            dropdown.classList.remove('open');
        });
    }

    function logout() {
        localStorage.removeItem('vv_access_token');
        localStorage.removeItem('vv_username');
        nativeCall('logout').then(function () {
            // C++ will close the main window and return to the startup gate
        }).catch(function (e) {
            console.warn('logout native call failed, falling back to close app:', e);
            nativeCall('close').catch(function () {});
        });
    }

    function injectProductLogo() {
        const spans = document.querySelectorAll('span');
        let title = null;
        spans.forEach(function (s) {
            if (!title && s.textContent.trim() === '菈泽智能AI' && !s.dataset.logoInjected) {
                title = s;
            }
        });
        if (!title) return;
        title.dataset.logoInjected = '1';

        const cs = getComputedStyle(title);
        const top = parseFloat(cs.top) || 9;
        const left = parseFloat(cs.left) || 46;

        // Logo 当前 48x48，再增大 1/3 为 64x64；相对原位置往左 6px、往上 2px；标题右移留出空间
        title.style.setProperty('left', (left + 72) + 'px', 'important');

        const logo = document.createElement('img');
        logo.src = 'logo/LAZERAGENT_256.png';
        logo.alt = 'LazerAgent';
        logo.className = 'app-product-logo';
        logo.style.top = (top - 4) + 'px';
        logo.style.left = (left - 6) + 'px';
        if (title.parentElement) title.parentElement.appendChild(logo);
    }

    function init() {
        injectProductLogo();
        injectUserMenu();
        injectSettingsButton();
        checkBackendHealth();
        markCurrentPageStyle();
        initDragRegion();
        initWindowControls();
        fitPage(true);
        bindResize();

        const currentPage = window.__voicevideo_page__ || window.location.pathname;
        if (currentPage.includes('LinkVideoExtract.html')) {
            initLinkVideoExtractPage();
        } else if (currentPage.includes('ArticleRewrite.html')) {
            initArticleRewritePage();
        } else if (currentPage.includes('VoiceGernerate.html')) {
            initVoiceGerneratePage();
        } else if (currentPage.includes('VideoGernerate.html')) {
            initVideoGerneratePage();
        } else if (currentPage.includes('VideoCut.html')) {
            initVideoCutPage();
        } else if (currentPage.includes('BannerGenerate.html')) {
            initBannerGeneratePage();
        } else if (currentPage.includes('Publish.html')) {
            initPublishPage();
        }
    }

    // ===================== BannerGenerate 核心功能（覆盖早期占位实现）====================

    const BANNER_TEMPLATES = [
        { name: 'V0', label: '经典白边', align: 'center', valign: 'middle', color: '#FFFFFF', stroke: '#000000', strokeWidth: 2, shadow: '0 4px 10px rgba(0,0,0,0.7)', fontSize: 38, fontWeight: 700 },
        { name: 'V1', label: '顶部描边', align: 'center', valign: 'top', color: '#FFFFFF', stroke: '#DB70FF', strokeWidth: 2, shadow: '0 6px 12px rgba(0,0,0,0.7)', fontSize: 40, fontWeight: 700, marginTop: 50 },
        { name: 'V2', label: '底部黄字', align: 'center', valign: 'bottom', color: '#FFE700', stroke: '#000000', strokeWidth: 3, shadow: '0 8px 16px rgba(0,0,0,0.8)', fontSize: 40, fontWeight: 700, marginBottom: 50 },
        { name: 'V3', label: '左侧竖感', align: 'left', valign: 'middle', color: '#FFFFFF', stroke: '#000000', strokeWidth: 2, shadow: '6px 0 10px rgba(0,0,0,0.6)', fontSize: 34, fontWeight: 700, marginLeft: 12 },
        { name: 'V4', label: '右侧对齐', align: 'right', valign: 'middle', color: '#FFFFFF', stroke: '#000000', strokeWidth: 2, shadow: '-6px 0 10px rgba(0,0,0,0.6)', fontSize: 34, fontWeight: 700, marginRight: 12 },
        { name: 'V5', label: '红底白字', align: 'center', valign: 'middle', color: '#FFFFFF', stroke: null, strokeWidth: 0, shadow: 'none', fontSize: 34, fontWeight: 700, bar: 'rgba(255,60,80,0.9)' },
        { name: 'V6', label: '底部渐变条', align: 'center', valign: 'bottom', color: '#FFFFFF', stroke: null, strokeWidth: 0, shadow: 'none', fontSize: 36, fontWeight: 700, gradientBar: true, marginBottom: 0 },
        { name: 'V7', label: '顶部紫字', align: 'center', valign: 'top', color: '#DB70FF', stroke: '#FFFFFF', strokeWidth: 2, shadow: '0 6px 12px rgba(0,0,0,0.7)', fontSize: 38, fontWeight: 700, marginTop: 55 },
        { name: 'V8', label: '左下白字', align: 'left', valign: 'bottom', color: '#FFFFFF', stroke: '#000000', strokeWidth: 2, shadow: '4px 4px 10px rgba(0,0,0,0.7)', fontSize: 34, fontWeight: 700, marginLeft: 12, marginBottom: 45 },
        { name: 'V9', label: '右下黄字', align: 'right', valign: 'bottom', color: '#FFE700', stroke: '#000000', strokeWidth: 2, shadow: '-4px 4px 10px rgba(0,0,0,0.7)', fontSize: 34, fontWeight: 700, marginRight: 12, marginBottom: 45 },
        { name: 'V10', label: '蓝字白边', align: 'center', valign: 'middle', color: '#3757FE', stroke: '#FFFFFF', strokeWidth: 3, shadow: '0 8px 16px rgba(0,0,0,0.8)', fontSize: 38, fontWeight: 700, badge: true },
        { name: 'V11', label: '白底黑字', align: 'center', valign: 'middle', color: '#000000', stroke: '#FFFFFF', strokeWidth: 2, shadow: 'none', fontSize: 34, fontWeight: 700, bgBox: 'rgba(255,255,255,0.92)' }
    ];

    function _getSession(key, fallback) {
        try { return sessionStorage.getItem(key) || fallback; } catch (e) { return fallback; }
    }

    function _setSession(key, value) {
        try { sessionStorage.setItem(key, value); } catch (e) {}
    }

    function getDefaultBannerTitle() {
        return _getSession('vv_banner_title', '')
            || _getSession('vv_voice_text', '')
            || _getSession('vv_extracted_text', '')
            || '请输入标题';
    }

    function getBannerTitle() {
        return _getSession('vv_banner_title', getDefaultBannerTitle());
    }

    function setBannerTitle(value) {
        _setSession('vv_banner_title', value);
    }

    function getBannerTemplate() {
        return parseInt(_getSession('vv_banner_template', '0'), 10) || 0;
    }

    function setBannerTemplate(index) {
        _setSession('vv_banner_template', String(index));
    }

    function getBannerCoverSource() {
        return _getSession('vv_banner_cover_source', 'none');
    }

    function setBannerCoverSource(source) {
        _setSession('vv_banner_cover_source', source);
    }

    function getBannerCoverPath() {
        return _getSession('vv_banner_cover_path', '');
    }

    function setBannerCoverPath(path) {
        _setSession('vv_banner_cover_path', path);
    }

    function getBannerTextRect() {
        try {
            return JSON.parse(_getSession('vv_banner_text_rect', '{}'));
        } catch (e) {
            return {};
        }
    }

    function setBannerTextRect(rect) {
        _setSession('vv_banner_text_rect', JSON.stringify(rect));
    }

    function getBannerVideoSource() {
        return _getSession('vv_generated_video', '');
    }

    function ensureDefaultTextRect() {
        const rect = getBannerTextRect();
        if (typeof rect.x !== 'number') rect.x = 0.5;
        if (typeof rect.y !== 'number') rect.y = 0.75;
        if (typeof rect.scale !== 'number') rect.scale = 1.0;
        setBannerTextRect(rect);
        return rect;
    }

    // ===================== 多标题文本单元数据层 =====================
    function generateUnitId() {
        return 'tu_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
    }

    function getDefaultTextUnit() {
        const rect = ensureDefaultTextRect();
        return {
            id: generateUnitId(),
            text: getBannerTitle() || '请输入标题',
            fontFamily: 'Microsoft YaHei',
            fontSize: Math.max(60, Math.round(140 * (rect.scale || 1))),
            bold: true,
            italic: false,
            underline: false,
            align: 'center',
            color: '#FFFFFF',
            opacity: 1,
            letterSpacing: 0,
            lineHeight: 1.2,
            x: rect.x,
            y: rect.y,
            rotation: 0,
            background: { enabled: false, radius: 8, width: 0, height: 0, color: '#000000', opacity: 0.5 },
            shadow: { enabled: false, color: '#000000', size: 0, opacity: 0.5, blur: 0, distance: 0 }
        };
    }

    function migrateTextUnits() {
        if (_getSession('vv_banner_text_units')) return;
        const unit = getDefaultTextUnit();
        const tplIndex = getBannerTemplate();
        const tpl = BANNER_TEMPLATES[tplIndex] || BANNER_TEMPLATES[0];
        if (tpl) {
            unit.align = tpl.align;
            unit.color = tpl.color;
            unit.bold = tpl.fontWeight >= 600;
        }
        setTextUnits([unit]);
        setSelectedTextUnitId(unit.id);
    }

    function getTextUnits() {
        migrateTextUnits();
        try {
            const raw = _getSession('vv_banner_text_units', '[]');
            const units = JSON.parse(raw);
            if (Array.isArray(units) && units.length > 0) return units;
        } catch (e) {}
        const unit = getDefaultTextUnit();
        setTextUnits([unit]);
        setSelectedTextUnitId(unit.id);
        return [unit];
    }

    function setTextUnits(units) {
        _setSession('vv_banner_text_units', JSON.stringify(units || []));
        // 保持旧的 vv_banner_title 与第一个单元同步，避免其他页面读取不到
        if (units && units.length > 0) {
            _setSession('vv_banner_title', units[0].text || '');
        }
    }

    function getSelectedTextUnitId() {
        const units = getTextUnits();
        let id = _getSession('vv_banner_selected_text_id', '');
        if (!id || !units.some(function (u) { return u.id === id; })) {
            id = units[0] ? units[0].id : '';
            setSelectedTextUnitId(id);
        }
        return id;
    }

    function setSelectedTextUnitId(id) {
        _setSession('vv_banner_selected_text_id', id || '');
    }

    function getSelectedTextUnit() {
        const units = getTextUnits();
        const id = getSelectedTextUnitId();
        return units.find(function (u) { return u.id === id; }) || units[0] || null;
    }

    function addTextUnit(text) {
        const units = getTextUnits();
        const base = getSelectedTextUnit() || getDefaultTextUnit();
        const unit = JSON.parse(JSON.stringify(base));
        unit.id = generateUnitId();
        unit.text = text || '新标题';
        // 稍微错开位置，避免完全重叠
        unit.x = Math.min(0.95, Math.max(0.05, unit.x + 0.05));
        unit.y = Math.min(0.95, Math.max(0.05, unit.y + 0.05));
        units.push(unit);
        setTextUnits(units);
        setSelectedTextUnitId(unit.id);
        return unit.id;
    }

    function deleteTextUnit(id) {
        let units = getTextUnits();
        units = units.filter(function (u) { return u.id !== id; });
        if (units.length === 0) {
            const unit = getDefaultTextUnit();
            unit.text = '请输入标题';
            units.push(unit);
        }
        setTextUnits(units);
        const selected = getSelectedTextUnitId();
        if (selected === id || !units.some(function (u) { return u.id === selected; })) {
            setSelectedTextUnitId(units[0].id);
        }
    }

    function updateTextUnit(id, patch) {
        const units = getTextUnits();
        const idx = units.findIndex(function (u) { return u.id === id; });
        if (idx === -1) return;
        units[idx] = Object.assign({}, units[idx], patch);
        setTextUnits(units);
    }

    function updateSelectedTextUnit(patch) {
        const id = getSelectedTextUnitId();
        if (id) updateTextUnit(id, patch);
    }

    function getBannerTitleRaw() {
        return _getSession('vv_banner_title', getDefaultBannerTitle());
    }

    function getBannerTitle() {
        try {
            const raw = _getSession('vv_banner_text_units');
            if (raw) {
                const units = JSON.parse(raw);
                if (Array.isArray(units) && units.length > 0) {
                    return units[0].text || '';
                }
            }
        } catch (e) {}
        return getBannerTitleRaw();
    }

    function setBannerTitle(value) {
        _setSession('vv_banner_title', value);
        try {
            const raw = _getSession('vv_banner_text_units');
            if (raw) {
                const units = JSON.parse(raw);
                if (Array.isArray(units) && units.length > 0) {
                    units[0].text = value;
                    _setSession('vv_banner_text_units', JSON.stringify(units));
                }
            }
        } catch (e) {}
    }

    function applyTemplateToSelectedUnit(tplIndex) {
        const tpl = BANNER_TEMPLATES[tplIndex] || BANNER_TEMPLATES[0];
        if (!tpl) return;
        updateSelectedTextUnit({
            align: tpl.align,
            color: tpl.color,
            bold: tpl.fontWeight >= 600,
            fontSize: Math.max(60, Math.round((tpl.fontSize || 38) * 3.7))
        });
        setBannerTemplate(tplIndex);
    }

    function applyTemplateStyle(el, index, scale, isLayer) {
        const tpl = BANNER_TEMPLATES[index] || BANNER_TEMPLATES[0];
        scale = scale || 1;
        el.style.color = tpl.color;
        el.style.fontFamily = '"Microsoft YaHei", "PingFang SC", "SimHei", sans-serif';
        el.style.fontWeight = tpl.fontWeight;
        el.style.fontSize = Math.round(tpl.fontSize * scale) + 'px';
        el.style.lineHeight = '1.2';
        el.style.textAlign = tpl.align;
        el.style.wordBreak = 'break-word';
        el.style.userSelect = 'none';
        el.style.pointerEvents = isLayer ? 'auto' : 'none';
        el.style.webkitFontSmoothing = 'antialiased';
        if (isLayer) {
            el.style.whiteSpace = 'pre-wrap';
            el.style.overflow = 'visible';
            el.style.textOverflow = 'clip';
        } else {
            el.style.whiteSpace = 'nowrap';
            el.style.overflow = 'hidden';
            el.style.textOverflow = 'ellipsis';
        }
        if (tpl.stroke && tpl.strokeWidth) {
            if (isLayer) {
                el.style.webkitTextStroke = tpl.strokeWidth + 'px ' + tpl.stroke;
                if (tpl.shadow && tpl.shadow !== 'none') {
                    el.style.textShadow = tpl.shadow;
                } else {
                    el.style.textShadow = 'none';
                }
            } else {
                // 缩略图使用按比例缩放的极细描边，避免小字号下描边糊成一团
                el.style.textShadow = 'none';
                el.style.webkitTextStroke = Math.max(0.3, tpl.strokeWidth * scale * 0.5).toFixed(2) + 'px ' + tpl.stroke;
            }
        } else {
            el.style.webkitTextStroke = 'none';
            if (tpl.shadow && tpl.shadow !== 'none') {
                el.style.textShadow = tpl.shadow;
            } else {
                el.style.textShadow = 'none';
            }
        }
        el.style.marginTop = '';
        el.style.marginBottom = '';
        el.style.marginLeft = '';
        el.style.marginRight = '';
        el.style.padding = '';
        el.style.background = 'transparent';
        el.style.borderRadius = '';
        if (tpl.bar) {
            el.style.background = tpl.bar;
            el.style.padding = '6px 10px';
            el.style.borderRadius = '6px';
        }
        if (tpl.bgBox) {
            el.style.background = tpl.bgBox;
            el.style.padding = '10px 14px';
            el.style.borderRadius = '10px';
        }
        if (!isLayer) {
            if (tpl.marginTop) el.style.marginTop = tpl.marginTop + 'px';
            if (tpl.marginBottom) el.style.marginBottom = tpl.marginBottom + 'px';
            if (tpl.marginLeft) el.style.marginLeft = tpl.marginLeft + 'px';
            if (tpl.marginRight) el.style.marginRight = tpl.marginRight + 'px';
        }
    }

    function prepareBannerPreviewContainer(selector) {
        const container = $(selector);
        if (!container) return null;
        container.style.overflow = 'hidden';
        container.style.background = '#000';
        container.style.border = '1px solid rgba(73, 87, 145, 0.9)';
        container.style.boxShadow = 'inset 0 0 0 1px rgba(73, 87, 145, 0.35)';
        container.style.boxSizing = 'border-box';
        return container;
    }

    function createBannerPreviewContainer(selector) {
        const container = prepareBannerPreviewContainer(selector);
        if (container) {
            container.innerHTML = '';
            container.removeAttribute('data-banner-state');
            container.removeAttribute('data-thumb-state');
        }
        return container;
    }

    function showBannerPreviewLoading(selector, message) {
        const container = createBannerPreviewContainer(selector);
        if (!container) return;
        const msg = document.createElement('div');
        msg.className = 'banner-preview-loading';
        msg.textContent = message || '处理中...';
        container.appendChild(msg);
    }

    function hexToRgba(hex, alpha) {
        hex = (hex || '#000000').replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
        const bigint = parseInt(hex, 16);
        if (isNaN(bigint)) return 'rgba(0,0,0,' + alpha + ')';
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    function escapeHtml(str) {
        return String(str || '').replace(/[&<>"']/g, function (m) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
        });
    }

    function applyTextUnitStyle(layer, unit, scale) {
        scale = scale || 1;
        const sizePx = Math.max(10, Math.round(unit.fontSize * scale));
        layer.style.color = unit.color || '#FFFFFF';
        layer.style.fontFamily = '"' + (unit.fontFamily || 'Microsoft YaHei') + '", "Microsoft YaHei", "PingFang SC", sans-serif';
        layer.style.fontSize = sizePx + 'px';
        layer.style.fontWeight = unit.bold ? '700' : '400';
        layer.style.fontStyle = unit.italic ? 'italic' : 'normal';
        layer.style.textDecoration = unit.underline ? 'underline' : 'none';
        layer.style.textAlign = unit.align || 'center';
        layer.style.opacity = (typeof unit.opacity === 'number') ? unit.opacity : 1;
        layer.style.letterSpacing = (unit.letterSpacing || 0) * scale + 'px';
        layer.style.lineHeight = (typeof unit.lineHeight === 'number') ? unit.lineHeight : 1.2;
        layer.style.wordBreak = 'break-word';
        layer.style.whiteSpace = 'pre-wrap';
        layer.style.overflow = 'visible';
        layer.style.textOverflow = 'clip';
        layer.style.userSelect = 'none';
        layer.style.webkitUserSelect = 'none';
        layer.style.pointerEvents = 'auto';
        layer.style.cursor = 'move';
        layer.style.maxWidth = '90%';
        layer.style.transformOrigin = 'center center';
        layer.style.transform = 'translate(-50%, -50%) rotate(' + (unit.rotation || 0) + 'deg)';

        const bg = unit.background || {};
        if (bg.enabled) {
            layer.style.background = hexToRgba(bg.color || '#000000', (typeof bg.opacity === 'number') ? bg.opacity : 0.5);
            const pad = Math.round((bg.padding || 12) * scale);
            layer.style.padding = pad + 'px ' + Math.round(pad * 1.3) + 'px';
            layer.style.borderRadius = Math.round((bg.radius || 8) * scale) + 'px';
        } else {
            layer.style.background = 'transparent';
            layer.style.padding = '';
            layer.style.borderRadius = '';
        }

        const s = unit.shadow || {};
        const shadows = [];
        if (s.enabled) {
            const blur = Math.round((s.blur || 0) * scale);
            const distance = Math.round((s.distance || 0) * scale);
            const size = Math.round((s.size || 0) * scale);
            const color = hexToRgba(s.color || '#000000', (typeof s.opacity === 'number') ? s.opacity : 0.5);
            if (distance > 0 || blur > 0) {
                shadows.push(distance + 'px ' + distance + 'px ' + blur + 'px ' + color);
            }
            if (size > 0) {
                layer.style.webkitTextStroke = size + 'px ' + color;
            } else {
                layer.style.webkitTextStroke = 'none';
            }
        } else {
            layer.style.webkitTextStroke = 'none';
        }
        layer.style.textShadow = shadows.join(', ') || 'none';
    }

    function highlightSelectedBannerLayers() {
        const selectedId = getSelectedTextUnitId();
        $$('.banner-title-layer').forEach(function (layer) {
            layer.classList.toggle('selected', layer.getAttribute('data-unit-id') === selectedId);
        });
    }

    function createBannerTextLayer(container, unit, scale, isSelected) {
        const layer = document.createElement('div');
        layer.className = 'banner-title-layer' + (isSelected ? ' selected' : '');
        layer.setAttribute('data-unit-id', unit.id);
        layer.textContent = unit.text || '';
        layer.style.cssText = 'position:absolute;left:' + (unit.x * 100) + '%;top:' + (unit.y * 100) + '%;z-index:2;';
        applyTextUnitStyle(layer, unit, scale);
        layer.setAttribute('title', '双击编辑文本');
        container.appendChild(layer);

        let dragging = false;
        let startX, startY, startLeftPx, startTopPx, startUnitX, startUnitY;

        function selectThis(e) {
            setSelectedTextUnitId(unit.id);
            highlightSelectedBannerLayers();
            renderTextEditPanel();
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
        }

        layer.addEventListener('mousedown', function (e) {
            if (layer.getAttribute('data-editing') === 'true') return;
            selectThis(e);
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const cw = container.clientWidth;
            const ch = container.clientHeight;
            startLeftPx = unit.x * cw;
            startTopPx = unit.y * ch;
            startUnitX = unit.x;
            startUnitY = unit.y;
        });

        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            const cw = container.clientWidth;
            const ch = container.clientHeight;
            let nx = startLeftPx + (e.clientX - startX);
            let ny = startTopPx + (e.clientY - startY);
            nx = Math.max(0, Math.min(cw, nx));
            ny = Math.max(0, Math.min(ch, ny));
            unit.x = nx / cw;
            unit.y = ny / ch;
            layer.style.left = (unit.x * 100) + '%';
            layer.style.top = (unit.y * 100) + '%';
            updateTextUnit(unit.id, { x: unit.x, y: unit.y });
            // 同步位置输入框，避免重绘面板时丢失未提交的拖拽值
            const pxInput = $('.banner-text-edit-panel [data-field="x"]');
            const pyInput = $('.banner-text-edit-panel [data-field="y"]');
            if (pxInput) pxInput.value = Math.round(unit.x * 100);
            if (pyInput) pyInput.value = Math.round(unit.y * 100);
        });
        document.addEventListener('mouseup', function () { dragging = false; });

        // 双击进入编辑模式
        layer.addEventListener('dblclick', function (e) {
            e.stopPropagation();
            if (layer.getAttribute('data-editing') === 'true') return;
            layer.setAttribute('data-editing', 'true');
            layer.contentEditable = 'true';
            layer.style.cursor = 'text';
            layer.style.webkitUserSelect = 'text';
            layer.style.userSelect = 'text';
            layer.style.boxShadow = '0 0 0 2px rgba(219,112,255,0.9), 0 4px 20px rgba(0,0,0,0.5)';
            const range = document.createRange();
            range.selectNodeContents(layer);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });

        function finishEdit(save) {
            if (layer.getAttribute('data-editing') !== 'true') return;
            layer.removeAttribute('data-editing');
            layer.contentEditable = 'false';
            layer.style.cursor = 'move';
            layer.style.webkitUserSelect = 'none';
            layer.style.userSelect = 'none';
            if (save) {
                unit.text = layer.innerText || '';
                updateTextUnit(unit.id, { text: unit.text });
            } else {
                layer.textContent = unit.text || '';
            }
            applyTextUnitStyle(layer, unit, scale);
            layer.style.boxShadow = '';
            layer.style.borderRadius = '';
            renderTextEditPanel();
        }

        layer.addEventListener('blur', function () { finishEdit(true); });
        layer.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                finishEdit(true);
                layer.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finishEdit(false);
                layer.blur();
            }
        });

        if (isSelected) {
            // 四边 + 四角共 8 个缩放把手
            const handleConfigs = [
                { mode: 'nw', cursor: 'nw-resize', left: '-5px', top: '-5px' },
                { mode: 'n', cursor: 'n-resize', left: '50%', top: '-5px' },
                { mode: 'ne', cursor: 'ne-resize', right: '-5px', top: '-5px' },
                { mode: 'w', cursor: 'w-resize', left: '-5px', top: '50%' },
                { mode: 'e', cursor: 'e-resize', right: '-5px', top: '50%' },
                { mode: 'sw', cursor: 'sw-resize', left: '-5px', bottom: '-5px' },
                { mode: 's', cursor: 's-resize', left: '50%', bottom: '-5px' },
                { mode: 'se', cursor: 'se-resize', right: '-5px', bottom: '-5px' }
            ];

            let resizing = false;
            let resizeMode = '';
            let startResizeX, startResizeY, startFontSize;

            handleConfigs.forEach(function (cfg) {
                const h = document.createElement('div');
                h.className = 'banner-resize-handle';
                h.setAttribute('data-resize-mode', cfg.mode);
                let css = 'position:absolute;width:10px;height:10px;background:rgba(219,112,255,1);border:2px solid #fff;border-radius:50%;pointer-events:auto;z-index:20;transform:translate(-50%,-50%);cursor:' + cfg.cursor + ';';
                if (cfg.left) css += 'left:' + cfg.left + ';';
                if (cfg.right) css += 'right:' + cfg.right + ';';
                if (cfg.top) css += 'top:' + cfg.top + ';';
                if (cfg.bottom) css += 'bottom:' + cfg.bottom + ';';
                h.style.cssText = css;
                layer.appendChild(h);

                h.addEventListener('mousedown', function (e) {
                    resizing = true;
                    resizeMode = cfg.mode;
                    startResizeX = e.clientX;
                    startResizeY = e.clientY;
                    startFontSize = unit.fontSize;
                    e.preventDefault();
                    e.stopPropagation();
                });
            });

            document.addEventListener('mousemove', function (e) {
                if (!resizing) return;
                const dx = e.clientX - startResizeX;
                const dy = e.clientY - startResizeY;
                let delta = 0;
                switch (resizeMode) {
                    case 'n': delta = -dy; break;
                    case 's': delta = dy; break;
                    case 'w': delta = -dx; break;
                    case 'e': delta = dx; break;
                    case 'nw': delta = Math.hypot(Math.max(-dx, 0), Math.max(-dy, 0)); break;
                    case 'ne': delta = Math.hypot(Math.max(dx, 0), Math.max(-dy, 0)); break;
                    case 'sw': delta = Math.hypot(Math.max(-dx, 0), Math.max(dy, 0)); break;
                    case 'se': delta = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)); break;
                }
                const newSize = Math.max(12, Math.round(startFontSize + delta * 1.2));
                if (newSize !== unit.fontSize) {
                    unit.fontSize = newSize;
                    layer.style.fontSize = Math.round(newSize * scale) + 'px';
                    updateTextUnit(unit.id, { fontSize: newSize });
                    const fsInput = $('.banner-text-edit-panel [data-field="fontSize"]');
                    if (fsInput) fsInput.value = newSize;
                }
            });
            document.addEventListener('mouseup', function () { resizing = false; resizeMode = ''; });
        }
    }

    function renderBannerPreview(containerSelector, showInput) {
        const container = prepareBannerPreviewContainer(containerSelector);
        if (!container) return;

        const coverPath = getBannerCoverPath();
        const units = getTextUnits();
        const selectedId = getSelectedTextUnitId();
        // 完整序列化所有文本单元，确保任何属性改动都能触发重新渲染
        const state = JSON.stringify({
            coverPath: coverPath,
            selectedId: selectedId,
            units: JSON.parse(JSON.stringify(units))
        });
        if (container.getAttribute('data-banner-state') === state && container.querySelectorAll('.banner-title-layer').length === units.length) return;
        container.setAttribute('data-banner-state', state);
        container.innerHTML = '';

        const bg = document.createElement('div');
        bg.className = 'banner-preview-bg';
        bg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;background:#000;background-size:cover;background-position:center;';
        if (coverPath) {
            const encoded = encodeURI(coverPath.replace(/\\/g, '/'));
            const img = new Image();
            img.onload = function () {
                bg.style.backgroundImage = 'url("file:///' + encoded + '?t=' + Date.now() + '")';
            };
            img.onerror = function () {
                const err = document.createElement('div');
                err.className = 'banner-preview-loading';
                err.textContent = '封面加载失败';
                container.appendChild(err);
            };
            img.src = 'file:///' + encoded;
        } else {
            const empty = document.createElement('div');
            empty.className = 'banner-preview-loading';
            empty.textContent = '暂无封面，请上传视频源或选择本地图片';
            container.appendChild(empty);
        }
        container.appendChild(bg);

        if (!coverPath || !showInput) return;

        const previewScale = container.clientHeight / 1920;
        units.forEach(function (unit) {
            createBannerTextLayer(container, unit, previewScale, unit.id === selectedId);
        });
    }

    function renderFrameThumbnail(selector, path) {
        const container = prepareBannerPreviewContainer(selector);
        if (!container) return;
        const state = path || '';
        if (container.getAttribute('data-thumb-state') === state) return;
        container.setAttribute('data-thumb-state', state);
        container.innerHTML = '';
        if (!path) {
            const msg = document.createElement('div');
            msg.className = 'banner-preview-loading';
            msg.textContent = '暂无抽帧封面';
            container.appendChild(msg);
            return;
        }
        const bg = document.createElement('div');
        bg.className = 'banner-preview-bg';
        bg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;background:#000;background-size:contain;background-repeat:no-repeat;background-position:center;';
        const encoded = encodeURI(path.replace(/\\/g, '/'));
        const img = new Image();
        img.onload = function () {
            bg.style.backgroundImage = 'url("file:///' + encoded + '?t=' + Date.now() + '")';
        };
        img.src = 'file:///' + encoded;
        container.appendChild(bg);
    }

    function refreshAllBannerPreviews() {
        renderBannerPreview('.v20_452', true);
        renderBannerPreview('.v20_483', true);
        renderBannerPreview('.v21_584', true);
        renderFrameThumbnail('.v21_544', getBannerCoverPath());
    }

    function setupStyleTemplateSelection() {
        const items = ['.v20_453', '.v20_455', '.v20_456', '.v20_457', '.v20_458', '.v20_459', '.v20_460', '.v20_461', '.v20_463', '.v20_464', '.v20_465', '.v20_466'];
        const labels = ['.v20_468', '.v20_469', '.v20_470', '.v20_471', '.v20_472', '.v20_473', '.v20_474', '.v20_475', '.v20_476', '.v20_477', '.v20_478', '.v20_479'];
        const elements = items.map($).filter(Boolean);
        if (elements.length === 0) return;

        function selectVisual(index) {
            elements.forEach(function (el, i) {
                el.style.boxShadow = (i === index) ? 'inset 0 0 0 2px rgba(219,112,255,1)' : 'none';
            });
        }

        function select(index) {
            selectVisual(index);
            applyTemplateToSelectedUnit(index);
            renderTextEditPanel();
            refreshAllBannerPreviews();
        }

        elements.forEach(function (el, index) {
            // 避免重复注入
            if (el.querySelector('.banner-template-preview')) return;

            el.style.display = 'flex';
            el.style.flexDirection = 'column';
            el.style.alignItems = 'center';
            el.style.justifyContent = 'center';
            el.style.overflow = 'hidden';

            const preview = document.createElement('div');
            preview.className = 'banner-template-preview';
            preview.textContent = '标题示例';
            applyTemplateStyle(preview, index, 0.42);
            preview.style.maxWidth = '90%';
            el.appendChild(preview);

            const originalLabel = $(labels[index]);
            if (originalLabel) {
                originalLabel.style.display = 'none';
            }

            const label = document.createElement('div');
            label.className = 'banner-template-label';
            label.textContent = (BANNER_TEMPLATES[index] || BANNER_TEMPLATES[0]).label;
            el.appendChild(label);

            el.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease';
            el.addEventListener('mouseenter', function () { el.style.transform = 'scale(1.05)'; });
            el.addEventListener('mouseleave', function () { el.style.transform = 'scale(1)'; });
            el.addEventListener('mousedown', function () { el.style.transform = 'scale(0.95)'; });
            el.addEventListener('mouseup', function () { el.style.transform = 'scale(1.05)'; });
            el.addEventListener('click', function () { select(index); });
        });

        selectVisual(getBannerTemplate());
    }

    function runBannerTask(nativeName, args, onDone, onError) {
        nativeCall(nativeName, args).then(function (result) {
            if (typeof result === 'string') {
                try { result = JSON.parse(result); } catch (e) { result = { error: result }; }
            }
            if (!result || result.error || !result.taskId) {
                if (onError) onError(result.error || '启动失败');
                return;
            }
            const taskId = result.taskId;
            const timer = setInterval(function () {
                nativeCall('checkBannerTask', { taskId: taskId }).then(function (check) {
                    if (typeof check === 'string') {
                        try { check = JSON.parse(check); } catch (e) { check = {}; }
                    }
                    if (!check || check.status === 'running') return;
                    clearInterval(timer);
                    if (check.status === 'done' && check.path) {
                        if (onDone) onDone(check.path);
                    } else {
                        if (onError) onError(check.error || '任务失败');
                    }
                }).catch(function (e) {
                    clearInterval(timer);
                    if (onError) onError('查询失败');
                });
            }, 500);
        }).catch(function (e) {
            if (onError) onError('调用失败');
        });
    }

    function extractBannerFrameFromVideo(videoPath, onDone, onError) {
        if (!videoPath) {
            if (onError) onError('缺少视频源');
            return;
        }
        ['.v20_452', '.v20_483', '.v21_584'].forEach(function (sel) {
            showBannerPreviewLoading(sel, '正在抽取封面帧...');
        });
        showBannerPreviewLoading('.v21_544', '正在抽取封面帧...');
        runBannerTask('extractBannerFrame', { video_path: videoPath.replace(/\\/g, '/') }, function (path) {
            setBannerCoverSource('video');
            setBannerCoverPath(path);
            refreshAllBannerPreviews();
            if (onDone) onDone(path);
        }, function (err) {
            ['.v20_452', '.v20_483', '.v21_584'].forEach(function (sel) {
                showBannerPreviewLoading(sel, '抽帧失败：' + (err || '未知错误'));
            });
            showBannerPreviewLoading('.v21_544', '抽帧失败：' + (err || '未知错误'));
            if (onError) onError(err);
        });
    }

    function setBannerVideoSourceName(path) {
        const name = path ? path.split(/[\\/]/).pop() : '';
        let el = $('.banner-video-source-name');
        if (!el) {
            el = document.createElement('div');
            el.className = 'banner-video-source-name';
            const root = $('.v21_615');
            if (root) root.appendChild(el);
        }
        if (el) el.textContent = name ? ('已选择视频：' + name) : '';
    }

    function setupBannerGenerateUpload() {
        const bg = $('.v20_438');
        const text = $('.v20_439');
        if (bg) {
            bg.style.cursor = 'pointer';
            bg.style.pointerEvents = 'auto';
        }
        if (text) {
            text.style.cursor = 'pointer';
            text.style.pointerEvents = 'auto';
        }
        setupGradientButton('.v20_439', '.v20_438', function () {
            console.log('上传视频源 clicked');
            nativeCall('pickFile').then(function (result) {
                console.log('pickFile result:', result);
                if (result && result.path) {
                    _setSession('vv_generated_video', result.path);
                    setBannerVideoSourceName(result.path);
                    extractBannerFrameFromVideo(result.path);
                }
            }).catch(function (e) {
                console.error('pickFile failed', e);
            });
        });
    }

    function setupCoverSourceButton() {
        setupGradientButton('.v21_548', '.v21_547', function () {
            generateFinalBanner();
        });
    }

    function generateFinalBanner() {
        const coverPath = getBannerCoverPath();
        const title = getBannerTitle();
        const tplIndex = getBannerTemplate();
        const rect = ensureDefaultTextRect();
        const videoPath = getBannerVideoSource();

        const btnText = $('.v21_548');
        const originalText = btnText ? btnText.textContent : '';
        if (btnText) btnText.textContent = '生成中...';

        runBannerTask('generateBanner', {
            title: title,
            template_index: tplIndex,
            cover_path: coverPath,
            text_rect: rect,
            video_path: videoPath.replace(/\\/g, '/'),
            text_units: getTextUnits()
        }, function (path) {
            _setSession('vv_banner_output_path', path);
            if (btnText) btnText.textContent = originalText;
            refreshAllBannerPreviews();
            nativeCall('openFileLocation', { path: path }).catch(function () {});
            alert('封面已生成');
        }, function (error) {
            if (btnText) btnText.textContent = originalText;
            alert('封面生成失败：' + error);
        });
    }

    function initBannerCoverSource() {
        const videoPath = getBannerVideoSource();
        const coverPath = getBannerCoverPath();
        if (videoPath) {
            setBannerVideoSourceName(videoPath);
        }
        if (!coverPath && videoPath) {
            extractBannerFrameFromVideo(videoPath);
        } else if (!coverPath) {
            setBannerCoverSource('none');
            refreshAllBannerPreviews();
        } else {
            refreshAllBannerPreviews();
        }
    }

    function setupTemplateToggle() {
        setupTextEditTab();
        const templateTab = $('.v20_443');
        const sourceTab = $('.v20_446');
        const textTab = $('.banner-text-edit-tab');
        if (!templateTab || !sourceTab) return;

        templateTab.addEventListener('click', function () {
            setBannerEditMode('template');
        });
        sourceTab.addEventListener('click', function () {
            if (hasBannerSubPage()) return;
            setBannerEditMode('source');
            loadSubPage('.v20_430', 'BannerPriviewFrameSection.html', initBannerPreviewFrameSection);
        });
        if (textTab) {
            textTab.addEventListener('click', function () {
                setBannerEditMode('text');
            });
        }
        setBannerEditMode('template');
    }

    function initBannerPreviewFrameSection() {
        renderBannerPreview('.v20_483', true);
        renderFrameThumbnail('.v21_544', getBannerCoverPath());

        const tabTemplate = $('.v20_508');
        const tabSource = $('.v20_509');
        if (tabTemplate && tabSource) {
            tabSource.style.background = 'rgba(61,114,237,1)';
            tabTemplate.style.background = 'rgba(43,52,87,1)';
            tabTemplate.addEventListener('click', function () {
                restoreBannerTemplateView();
            });
        }

        const btnFrame = $('.v20_512');
        const btnLocal = $('.v20_521');
        if (btnFrame && btnLocal) {
            btnFrame.style.background = 'rgba(61,114,237,1)';
            btnLocal.style.background = 'rgba(44,48,66,1)';
            btnFrame.addEventListener('click', function () {
                btnFrame.style.background = 'rgba(61,114,237,1)';
                btnLocal.style.background = 'rgba(44,48,66,1)';
                const videoPath = getBannerVideoSource();
                if (videoPath) {
                    extractBannerFrameFromVideo(videoPath);
                }
            });
            btnLocal.addEventListener('click', function () {
                loadSubPage('.v20_430', 'BannerPriviewLocalImage.html', initBannerPreviewLocalImage);
            });
        }

        const btnResample = $('.v21_532');
        if (btnResample) {
            btnResample.style.cursor = 'pointer';
            btnResample.addEventListener('click', function () {
                const videoPath = getBannerVideoSource();
                if (videoPath) {
                    extractBannerFrameFromVideo(videoPath);
                }
            });
        }
    }

    function initBannerPreviewLocalImage() {
        renderBannerPreview('.v21_584', true);

        const tabTemplate = $('.v21_585');
        const tabSource = $('.v21_586');
        if (tabTemplate && tabSource) {
            tabSource.style.background = 'rgba(61,114,237,1)';
            tabTemplate.style.background = 'rgba(43,52,87,1)';
            tabTemplate.addEventListener('click', function () {
                restoreBannerTemplateView();
            });
        }

        const btnFrame = $('.v21_589');
        const btnLocal = $('.v21_590');
        if (btnFrame && btnLocal) {
            btnLocal.style.background = 'rgba(61,114,237,1)';
            btnFrame.style.background = 'rgba(44,48,66,1)';
            btnFrame.addEventListener('click', function () {
                loadSubPage('.v20_430', 'BannerPriviewFrameSection.html', initBannerPreviewFrameSection);
            });
        }

        const uploadArea = $('.v21_598');
        const statusText = $('.v21_611');
        if (uploadArea) {
            uploadArea.style.transition = 'box-shadow 0.2s ease, transform 0.1s ease';
            uploadArea.style.cursor = 'pointer';
            uploadArea.addEventListener('mouseenter', function () { uploadArea.style.boxShadow = '0 0 0 1px rgba(219,112,255,0.5)'; });
            uploadArea.addEventListener('mouseleave', function () { uploadArea.style.boxShadow = 'none'; });
            uploadArea.addEventListener('mousedown', function () { uploadArea.style.transform = 'scale(0.98)'; });
            uploadArea.addEventListener('mouseup', function () { uploadArea.style.transform = 'scale(1)'; });
            uploadArea.addEventListener('click', function () {
                nativeCall('pickFile').then(function (result) {
                    if (result && result.path) {
                        setBannerCoverSource('upload');
                        setBannerCoverPath(result.path.replace(/\\/g, '/'));
                        renderBannerPreview('.v21_584', true);
                        renderBannerPreview('.v20_452', true);
                        if (statusText) statusText.textContent = '已选择图片';
                    }
                }).catch(function (e) {
                    console.error('pickFile failed', e);
                });
            });
        }
    }

    function initBannerGeneratePage() {
        setupStartNewTaskButton();
        setupSidebarInteractions();
        setupBannerGenerateUpload();
        setupTemplateToggle();
        setupStyleTemplateSelection();
        setupCoverSourceButton();
        setupBannerGenerateNavButtons();
        initBannerCoverSource();
    }

    function restoreBannerTemplateView() {
        $$('link[data-sub-page-css]').forEach(function (link) {
            link.remove();
        });
        const container = $('.v20_430');
        if (container) container.innerHTML = '';

        const selectors = [
            '.v20_441', '.v20_442',
            '.v20_452',
            '.v20_453', '.v20_455', '.v20_456', '.v20_457', '.v20_458', '.v20_459', '.v20_460', '.v20_461', '.v20_463', '.v20_464', '.v20_465', '.v20_466',
            '.v20_468', '.v20_469', '.v20_470', '.v20_471', '.v20_472', '.v20_473', '.v20_474', '.v20_475', '.v20_476', '.v20_477', '.v20_478', '.v20_479',
            '.v20_443', '.v20_446', '.v20_444', '.v20_447',
            '.v21_547', '.v21_548'
        ];
        selectors.forEach(function (sel) {
            const el = $(sel);
            if (el) el.style.display = '';
        });

        setBannerEditMode('template');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
