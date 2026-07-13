<!-- AGENTS.md: Voicevideo 项目代理工作手册 -->

# Voicevideo — Agent 工作手册

> 本文件面向后续接手本项目的 AI Agent，记录项目结构、构建方式、代码组织、开发约定与常见注意事项。阅读前请确认：本项目没有 `pyproject.toml`、`package.json`、`Cargo.toml` 等根级包管理文件，依赖关系通过 `vcpkg.json`（C++）和 `localdep/python`（嵌入式 Python）管理。

---

## 1. 项目概览

- **项目名**：Voicevideo
- **定位**：基于本地大模型的 AI 短视频创作桌面端工具
- **技术栈**：C++20 + CMake + Ninja + vcpkg + Microsoft WebView2 + 嵌入式 Python 3.12.10
- **窗口**：无边框窗口，设计稿尺寸固定为 **1400×972**
- **入口**：`src/Voicevideo.cpp` 中的 `main()`
- **核心流程**：视频/链接提取文案 → AI 改写/法务检查 → 声音生成（TTS）→ 数字人视频生成 → 网感剪辑 → 标题封面 → 一键发布（小红书/抖音/快手）

---

## 2. 目录结构

```
Voicevideo/
├── src/                          # C++ 源码
│   ├── Voicevideo.cpp            # 主入口、WebView2 桥接、Python 进程管理（约 2810 行）
│   ├── Voicevideo.h              # 占位头文件
│   └── largui/                   # 跨平台 WebView 封装（目前仅 Windows 完整实现）
│       ├── ILarWebView.h         # 跨平台抽象接口
│       ├── CLarWebview.h/.cpp    # Windows WebView2 实现
│       ├── LarWebViewFactory.cpp # 工厂函数 CreateWebView()
│       ├── LarWebviewHostBase.h/.cpp # JS 脚本队列基类（当前未被主程序继承）
│       └── LarWebViewMacOS.h/.cpp    # macOS 桩实现
├── assets/                       # 前端资源
│   ├── StartUp.html              # 启动/登录/激活窗口（480×320）
│   ├── Admin.html                # 激活码管理后台（680×520，--admin 启动）
│   ├── LinkVideoExtract.html     # 主流程第一步：视频链接提取
│   ├── *.html                    # 其他主页面及封面预览子页面
│   ├── css/*.css                 # 页面级样式 + 全局覆盖 app.css
│   │   ├── app.css               # 主窗口全局样式与覆盖
│   │   ├── startup.css           # 启动窗口样式
│   │   └── admin.css             # 激活码管理后台样式
│   ├── js/
│   │   ├── app.js                # 主窗口统一交互脚本
│   │   ├── startup.js            # 启动窗口：更新检查/登录/激活码校验
│   │   └── admin.js              # 激活码管理后台逻辑
│   ├── logo/                     # 产品 Logo
│   └── images/                   # 其他图片资源
├── server/                       # FastAPI 后端（认证、更新、激活码管理）
│   ├── app/
│   │   ├── main.py               # FastAPI 应用工厂与生命周期
│   │   ├── config.py             # 端口/JWT/Admin 密钥等配置
│   │   ├── db.py                 # SQLAlchemy 数据库配置
│   │   ├── models.py             # User / ActivationCode 数据模型
│   │   ├── activation.py         # 激活码生成辅助函数
│   │   ├── db_migrate.py         # 自动迁移脚本
│   │   └── api/                  # API 路由
│   │       ├── auth.py           # 注册/登录/激活/me
│   │       ├── admin.py          # 激活码生成/查询（Admin 用）
│   │       ├── update.py         # 客户端更新检查/下载
│   │       └── health.py         # 健康检查
│   ├── data/users.db             # SQLite 用户与激活码数据库
│   ├── run.py                    # Uvicorn 启动入口
│   └── updatezip/                # 客户端热更新包
├── tools/                        # Python 后端脚本及部署脚本
│   ├── extract_link.py           # 视频文案提取
│   ├── rewrite_text.py           # 文案改写 / 法务检查
│   ├── generate_voice.py         # 声音生成
│   ├── generate_video.py         # 数字人视频生成
│   ├── video_cut.py              # 网感剪辑
│   ├── generate_banner.py        # 标题封面合成
│   ├── build_sfx_index.py        # 本地音效关键词索引生成
│   ├── manage_activation_codes.py # 命令行激活码管理（生成/列出/禁用/grant）
│   ├── ensure_rewrite_model.py   # 构建期检查/下载改写模型
│   ├── ensure_tts_model.py       # 构建期检查/下载 TTS 模型
│   ├── ensure_video_model.py     # 构建期检查/下载 SadTalker 模型
│   ├── publish_xiaohongshu.py    # 小红书发布代理
│   ├── publish_douyin.py         # 抖音发布代理
│   ├── publish_kuaishou.py       # 快手发布代理
│   ├── kuaishou_mcp_service.py   # 快手 FastAPI 服务封装
│   ├── setup_xiaohongshu_mcp.ps1
│   ├── setup_douyin_mcp.ps1
│   ├── setup_kuaishou_mcp.ps1
│   ├── sync_localdep.cmake       # localdep 增量同步脚本
│   └── douyin-mcp-qrcode.patch   # 抖音 MCP 二维码补丁
├── localdep/                     # 离线依赖仓库（嵌入式 Python + 模型 + 工具）
│   ├── python/                   # 嵌入式 Python 3.12.10
│   ├── modelscope/               # ModelScope 模型缓存
│   ├── huggingface/              # Hugging Face 缓存
│   ├── tools/                    # ffmpeg.exe / ffprobe.exe
│   ├── sfx/                      # 本地音效库 + sfx_index.json
│   ├── douyin-mcp/               # 抖音 MCP 服务
│   ├── xiaohongshu-mcp/          # 小红书 MCP 服务
│   ├── social-auto-upload/       # 快手 social-auto-upload 服务
│   └── .stamp                    # 同步时间戳
├── vcpkg_installed/              # vcpkg 已安装 C++ 依赖目录
├── build/                        # CMake 构建输出（Debug/Release）
│   └── Voicevideo.exe            # 构建产物
├── out/build/                    # Visual Studio CMake 额外输出目录
├── github/
│   └── SadTalker/                # 数字人视频生成源码
├── temp/                         # 运行时临时目录
│   ├── extract/                  # extract_link.py 输出
│   ├── rewrite/                  # rewrite_text.py 输出
│   ├── voice/                    # generate_voice.py 输出
│   ├── video/                    # generate_video.py 输出
│   ├── video_cut/                # video_cut.py 输出
│   ├── banner/                   # generate_banner.py 输出
│   └── testdata/                 # 手动测试用参数与日志
├── CMakeLists.txt
├── CMakePresets.json
├── CMakeUserPresets.json
├── vcpkg.json
└── vcpkg-configuration.json
```

---

## 3. 技术栈与构建系统

### 3.1 C++ 层

- **标准**：C++20
- **构建工具**：CMake 3.16+，生成器为 **Ninja**
- **包管理**：vcpkg，清单文件 `vcpkg.json`
- **已安装依赖**（`vcpkg.json`）：
  - `curl` —— HTTP 请求
  - `fmt` —— 格式化
  - `libsodium` —— 加密
  - `minizip` —— ZIP 压缩
  - `nlohmann-json` —— JSON 解析
  - `zlib` —— 压缩
  - `spdlog` —— 日志
  - `webview2` —— Windows WebView2（仅 Windows）
- **vcpkg 安装目录固定为**：`${CMAKE_CURRENT_SOURCE_DIR}/vcpkg_installed`，避免多 build 目录重复下载。

### 3.2 CMake 预设

| 预设名 | 用途 | 输出目录 | VCPKG_ROOT |
|---|---|---|---|
| `vcpkg` | Windows x64 Ninja | `build/` | 来自环境变量 |
| `vcpkg-macos` | macOS（桩实现） | `build-macos/` | 来自环境变量 |
| `default` | 继承 `vcpkg` | `build/` | `C:\Users\86187\vcpkg` |
| `default-macos` | 继承 `vcpkg-macos` | `build-macos/` | `/Users/86187/vcpkg` |

### 3.3 Python 层

- **主解释器**：`localdep/python/python.exe`（嵌入式 Python 3.12.10）
- **备用解释器**：`.venv/Scripts/python.exe` → PATH 中的 `python.exe`
- **当前 torch**：`torch 2.5.1+cu121` + `torchaudio 2.5.1+cu121`
- **关键包分组**：
  - LLM：`transformers 4.57.3`、`accelerate`、`torch`
  - TTS：`qwen-tts 0.1.1`（editable 安装）、`soundfile`、`librosa`
  - ASR/提取：`funasr 1.3.14`、`yt-dlp`、`you-get`、`modelscope`
  - 视频生成（SadTalker）：`facexlib`、`kornia`、`pydub`、`imageio-ffmpeg`、`scikit-image`、`yacs`
  - 通用：`numpy`、`scipy`、`requests`、`fastapi` 等
- **qwen-tts editable 源码位置**：`E:\MyOwnProgram\VoiceVideo\github\Qwen3-TTS-main`，改源码直接生效，无需重新 pip install。
- **SadTalker 源码位置**：`E:\MyOwnProgram\VoiceVideo\github\SadTalker`（单张人像图 + 音频 → 说话人脸视频）。

### 3.4 前端

- 无现代构建工具（无 webpack/vite/rollup，无 `package.json`）
- 原生 HTML/CSS/JS，通过 `file://` 或 WebView2 虚拟主机加载
- 页面由 Figma 导出，类名规则为 `.v{数字}_{数字}`

---

## 4. 构建与运行命令

### 4.1 配置与构建（命令行）

```bash
# 使用 CMake 预设配置
cmake --preset=default

# 构建
cmake --build build --config Debug

# 或 Visual Studio 打开项目，选择 x64-windows / default 预设
```

### 4.2 构建后自动执行的操作

`CMakeLists.txt` 在 `POST_BUILD` 阶段依次执行：

1. 运行 `tools/ensure_rewrite_model.py` 检查/下载改写模型
2. 运行 `tools/ensure_tts_model.py` 检查/下载 TTS 模型
3. 运行 `tools/ensure_video_model.py` 检查/下载 SadTalker 模型
4. `copy_directory assets → $<TARGET_FILE_DIR>/assets`
5. `copy_directory tools → $<TARGET_FILE_DIR>/tools`

> 注意：构建时**不再自动复制 `localdep/`** 到输出目录。开发阶段 `build/Voicevideo.exe` 会直接使用源码主目录下的 `localdep/`；发布前请手动将 `localdep/` 复制到 exe 同级目录。

### 4.3 运行

```bash
# 直接运行构建产物
./build/Voicevideo.exe
```

前端页面通过 `file://` 协议加载 `build/assets/*.html`，C++ 通过 WebView2 注入 `window.native_call`。

### 4.4 localdep 同步注意事项

- 构建时**不再自动同步** `localdep/` 到 `build/localdep/`。
- 开发阶段，`build/Voicevideo.exe` 启动 Python 子进程时会优先使用**源码主目录下的 `localdep/`**，因此修改 `localdep` 后无需 touch `.stamp` 也无需等待同步，直接重启 exe 即可生效。
- `tools/sync_localdep.cmake` 仍保留，用于手动或 CI 场景下将 `localdep/` 复制到目标目录：
  ```bash
  cmake -P tools/sync_localdep.cmake localdep build/localdep
  ```
- 发布打包前，请将 `localdep/` 复制到 `Voicevideo.exe` 同级目录，此时 exe 会优先使用源码主目录 `localdep/`，若不存在则回退到 exe 同级目录的 `localdep/`。

---

## 5. 代码组织与架构

### 5.1 C++ 层

`src/Voicevideo.cpp`（约 2810 行）承载几乎全部应用逻辑：

- `main()`：初始化 spdlog 日志 → libcurl/libsodium/json 烟测 → 创建 1400×972 无边框 WebView 窗口 → 注册全部原生调用 → 导航到 `LinkVideoExtract.html` → 消息循环
- 窗口管理：无边框拖拽、最小化、关闭、缩放、居中、DPI 适配
- Python 进程管理：解释器查找、参数写入、进程启动、异步任务轮询
- 原生调用处理器：`extractFromLink`、`rewriteText`、`legalCheckText`、`generateVoice`、`generateVideo`、`cutVideo`、`generateBanner`、`extractBannerFrame`、云端费用预估 `getAudioDuration`、小红书/抖音/快手发布及登录状态查询等

`src/largui/` 是薄封装层：

- `ILarWebView.h`：跨平台接口
- `LarWebViewFactory.cpp`：工厂函数，Windows 返回 `CLarWebview`，macOS 返回 `LarWebViewMacOS`
- `CLarWebview.h/.cpp`：Windows WebView2 完整实现（窗口注册、无边框、虚拟主机 `openclaw.local`、bridge 注入）
- `LarWebviewHostBase.h/.cpp`：JS 脚本队列基类（当前未被主程序继承）
- `LarWebViewMacOS.h/.cpp`：macOS 桩实现，仅打印警告

### 5.2 Python 层

| 脚本 | 职责 | 调用方式 |
|---|---|---|
| `extract_link.py` | 下载/读取视频 → ffmpeg 抽音频 → FunASR 转写 | `python tools/extract_link.py <args.json>` |
| `rewrite_text.py` | Qwen2.5-0.5B 文案改写 / 法务检查 | `python tools/rewrite_text.py <args.json>` |
| `generate_voice.py` | Qwen3-TTS 声音生成 | `python tools/generate_voice.py <args.json>` |
| `generate_video.py` | SadTalker 人像视频生成 | `python tools/generate_video.py <args.json>` |
| `video_cut.py` | FunASR + ffmpeg 网感剪辑 | `python tools/video_cut.py <args.json>` |
| `generate_banner.py` | 视频抽帧 + Pillow 合成 1080×1920 封面 | `python tools/generate_banner.py <args.json>` |
| `publish_xiaohongshu.py` | 小红书 MCP 代理，端口 18060 | `python tools/publish_xiaohongshu.py <args.json>` |
| `publish_douyin.py` | 抖音 MCP 代理，端口 18062 | `python tools/publish_douyin.py <args.json>` |
| `publish_kuaishou.py` | 快手 MCP 代理，端口 18063 | `python tools/publish_kuaishou.py <args.json>` |
| `kuaishou_mcp_service.py` | FastAPI 封装 social-auto-upload | Python 子进程 |
| `build_sfx_index.py` | 扫描 `localdep/sfx/` 生成 `sfx_index.json` | 手动运行 |
| `ensure_rewrite_model.py` | 构建期检查/下载改写模型 | CMake POST_BUILD |
| `ensure_tts_model.py` | 构建期检查/下载 TTS 模型 | CMake POST_BUILD |
| `ensure_video_model.py` | 构建期检查/下载 SadTalker 模型 | CMake POST_BUILD |
| `sync_localdep.cmake` | localdep 增量同步 | 手动/CI 调用 |

### 5.3 前端层

- `assets/js/app.js`（单 IIFE）：
  - `nativeCall(name, arg)`：封装 `window.native_call`
  - `navigateTo(pageName)`：fetch 替换 body、动态加载 CSS、重新注入 `app.js`
  - `fitPage()`：基于 1400×972 设计稿缩放适配
  - 各页面初始化：`initLinkVideoExtractPage()`、`initArticleRewritePage()`、`initVoiceGerneratePage()`、`initVideoGerneratePage()`、`initVideoCutPage()`、`initBannerGeneratePage()`、`initPublishPage()`
- `assets/js/startup.js`：启动窗口逻辑
  - 更新检查 → 登录/注册 → 激活码校验 → `startupReady`
  - 失败时通过 `nativeCall('close')` 关闭应用
- `assets/js/admin.js`：激活码管理后台逻辑（`--admin` 启动）
  - 管理密钥校验 → 生成激活码 → 复制/导出 CSV
- `assets/css/app.css`：主窗口全局样式覆盖、页面切换动画、自定义控件样式
- `assets/css/startup.css`：启动窗口样式（含登录/激活面板）
- `assets/css/admin.css`：激活码管理后台样式
- 页面间状态通过 `sessionStorage` / `localStorage` 传递：
  - `vv_extracted_text`：提取文案 → 改写页
  - `vv_voice_text` / `vv_voice_fallback_text`：改写页 → 声音生成页
  - `vv_generated_audio`：声音生成 → 视频生成
  - `vv_generated_video`：视频生成 → 网感剪辑/封面/Publish
  - `vv_banner_output_path`：封面生成 → Publish
  - `vv_publish_accounts` / `vv_publish_active_account`：Publish 页账号列表

### 5.4 Native Call 列表

C++ 在 `main()` 中通过 `w->BindNativeCall()` 注册。不同窗口绑定的调用如下：

**主窗口（`runMainWindow`，加载主流程页面）**

| 名称 | 用途 |
|---|---|
| `startDrag` | 开始无边框窗口拖拽 |
| `minimize` | 最小化窗口 |
| `close` | 关闭应用 |
| `resizeWindow` | 调整并重新居中窗口 |
| `getPlatform` | 返回 `windows` / `macos` |
| `openUrl` | 用默认浏览器打开 URL |
| `openFileLocation` | 打开文件所在资源管理器 |
| `resolveMediaUrl` | 将本地路径转为 `file://` URL |
| `jsLog` | 前端日志透传到 C++ 日志 |
| `extractFromLink` | 视频文案提取（同步） |
| `rewriteText` | 文案改写（异步） |
| `legalCheckText` | 法务检查（异步） |
| `checkRewriteTask` | 轮询改写/法务任务 |
| `generateVoice` | 声音生成（异步） |
| `checkVoiceTask` | 轮询声音任务 |
| `getAudioDuration` | 调用 ffprobe 获取音频时长，用于云端生成费用预估 |
| `generateVideo` | 视频生成（异步；本地 SadTalker / 云端 wan2.2-s2v） |
| `checkVideoTask` | 轮询视频生成任务；云端余额不足时已生成片段会以 `partial` 标记返回 |
| `cutVideo` | 网感剪辑（异步） |
| `checkCutTask` | 轮询剪辑任务 |
| `extractBannerFrame` | 从视频随机抽帧（同步/异步） |
| `generateBanner` | 合成最终封面（异步） |
| `checkBannerTask` | 轮询封面任务 |
| `getXiaohongshuLoginStatus` | 查询小红书登录状态（同步；无有效 cookie 时快速返回） |
| `getXiaohongshuLoginStatusAsync` | 异步启动小红书登录状态检查，返回 `taskId` |
| `checkXiaohongshuLoginStatusTask` | 轮询异步登录状态检查任务 |
| `getXiaohongshuQrcode` | 获取小红书登录二维码（现由登录工具浏览器展示） |
| `publishXiaohongshu` | 小红书视频发布（异步） |
| `checkXiaohongshuTask` | 轮询小红书发布任务 |
| `getDouyinLoginStatus` | 查询抖音登录状态 |
| `getDouyinQrcode` | 获取抖音登录二维码 |
| `publishDouyin` | 抖音视频发布（异步） |
| `checkDouyinTask` | 轮询抖音发布任务 |
| `getKuaishouLoginStatus` | 查询快手登录状态 |
| `getKuaishouQrcode` | 获取快手登录二维码 |
| `publishKuaishou` | 快手视频发布（异步） |
| `checkKuaishouTask` | 轮询快手发布任务 |
| `getBackendBaseUrl` | 返回独立后端地址；默认 `http://127.0.0.1:18080`，可通过环境变量 `VOICEVIDEO_BACKEND_URL` 覆盖 |

**启动窗口（`runStartupWindow`，加载 `assets/StartUp.html`）**

| 名称 | 用途 |
|---|---|
| `startDrag` | 开始无边框窗口拖拽 |
| `close` | 关闭启动窗口（未就绪时直接退出应用） |
| `getBackendBaseUrl` | 返回后端地址 |
| `checkUpdate` | 读取 `version.txt` 并向后端检查更新 |
| `applyUpdate` | 下载 ZIP 并启动独立 updater，随后退出当前进程 |
| `openUrl` | 用默认浏览器打开 URL（激活码面板「购买激活码」使用） |
| `startupReady` | 通知 C++ 关闭启动窗口并创建主窗口 |
| `startupTrace` | JS 调试追踪，写入 `Voicevideo.log` |

**激活码管理后台（`runAdminWindow`，加载 `assets/Admin.html`，`--admin` 启动）**

| 名称 | 用途 |
|---|---|
| `startDrag` | 开始无边框窗口拖拽 |
| `close` | 关闭管理窗口 |
| `getBackendBaseUrl` | 返回后端地址 |
| `copyToClipboard` | 将文本写入系统剪贴板 |
| `saveCsvFile` | 弹出保存对话框并写入 CSV 内容 |

---

## 6. 原生 ↔ Python 通信协议

### 6.1 启动流程

1. C++ 的 `startPythonScript()` 选择解释器（优先级见第 7 节）。
2. 设置环境变量 `VOICEVIDEO_LOCALDEP` 指向 `localdep` 目录（开发阶段优先使用源码主目录，打包发布时可回退到 exe 同级目录）。
3. 创建 `temp/<workSubdir>/` 工作目录。
4. 将前端传入的参数加上 `work_dir` 字段后写入 `temp/<workSubdir>/args.json`。
5. 用 `CreateProcessW` 启动 Python 脚本，stdout/stderr 分别重定向到 `stdout.log` 和 `stderr.log`，工作目录结果写入 `output.json`。
6. 同步任务（`extractFromLink`）直接等待返回；异步任务生成 `taskId`，后台线程 `monitorRewriteTask` 等待进程结束后读取 `output.json`。

### 6.2 Python 脚本输出约定

- 成功：`print(json.dumps({...}), flush=True)` 到 stdout，并写入 `work_dir/output.json`
- 失败：`print(json.dumps({"error": "..."}), flush=True)`
- 所有脚本在 `if __name__ == "__main__"` 处都有 `try/except`，防止未捕获异常导致 C++ 无法读取结果
- 所有脚本调用 `_reconfigure_stdio()` 强制 stdout/stderr 为 UTF-8
- 库输出重定向：使用 `io.StringIO()` 和 `contextlib.redirect_stdout()` 避免污染最终 JSON

---

## 7. Python 解释器选择优先级

`src/Voicevideo.cpp` 的 `startPythonScript()` 按以下顺序选择解释器：

1. 项目根 `localdep/python/python.exe`
2. exe 同级 `localdep/python/python.exe`
3. 项目根 `.venv/Scripts/python.exe`
4. PATH 中的 `python.exe`

CMake 构建期同样优先使用 `localdep/python/python.exe`，其次 `.venv/Scripts/python.exe`，最后 `python`。

---

## 8. localdep 离线依赖仓库

### 8.1 `localdep/python`

- 嵌入式 Python 3.12.10
- 已安装 CUDA 12.1 版 `torch`/`torchaudio`
- 需要 CUDA 12.1+ 驱动才能调用 GPU；无 GPU 或老驱动自动回退 CPU

### 8.2 `localdep/modelscope` 模型缓存

| 模型 | 用途 | 大小 |
|---|---|---|
| `Qwen--Qwen3-TTS-12Hz-Tokenizer-12Hz` | TTS tokenizer | 651 MB |
| `Qwen--Qwen3-TTS-12Hz-1.7B-CustomVoice` | TTS 经典模型 | 4.3 GB |
| `Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice` | TTS 快速模型 | 2.4 GB |
| `qwen--Qwen2.5-0.5B-Instruct` | 文案改写 / 法务检查 | 954 MB |
| `iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch` | ASR 语音识别 | 953 MB |
| `iic--speech_fsmn_vad_zh-cn-16k-common-pytorch` | VAD | 3.9 MB |
| `iic--punc_ct-transformer_cn-en-common-vocab471067-large` | 标点恢复 | 1.2 GB |

### 8.3 脚本与依赖对应关系

| 脚本 | 依赖 |
|---|---|
| `tools/extract_link.py` | `yt-dlp`/`you-get` + `funasr` + ASR/VAD/标点三个 ModelScope 模型 |
| `tools/rewrite_text.py` | `transformers` + `Qwen2.5-0.5B-Instruct` |
| `tools/generate_voice.py` | `qwen-tts` + `torch`/`torchaudio` + 三个 Qwen3-TTS 模型 |
| `tools/generate_video.py` | `torch`/`torchaudio`/`facexlib`/`kornia` + `github/SadTalker` 模型 |
| `tools/video_cut.py` | `funasr` + `pydub` + ffmpeg + 本地音效库 |
| `tools/generate_banner.py` | `Pillow` + ffmpeg |
| `tools/publish_xiaohongshu.py` | `requests` + `xiaohongshu-mcp-windows-amd64.exe` |
| `tools/publish_douyin.py` | `requests` + `flyerhzm/douyin-mcp`（Node.js + Playwright） |
| `tools/publish_kuaishou.py` | `requests` + `social-auto-upload`（Python + patchright） |
| `tools/kuaishou_mcp_service.py` | FastAPI 封装 `social-auto-upload` 的快手登录/发布 |
| `tools/setup_xiaohongshu_mcp.ps1` | 一键下载/部署小红书 MCP 二进制 |
| `tools/setup_kuaishou_mcp.ps1` | 一键部署快手服务 |
| `tools/setup_douyin_mcp.ps1` | 一键部署抖音服务 |
| `tools/ensure_tts_model.py` | `modelscope` 下载/校验 TTS 模型 |
| `tools/ensure_rewrite_model.py` | `modelscope` 下载/校验改写模型 |
| `tools/ensure_video_model.py` | `modelscope` 下载/校验 SadTalker 模型 |
| `tools/ensure_dashscope_deps.py` | 构建期检查 `requests`/`pydub`/`Pillow` 已安装 |
| `tools/generate_video_cloud.py` | `requests` + `pydub` + DashScope `wan2.2-s2v` |
| `tools/generate_voice_cloud.py` | `requests` + `pydub` + DashScope CosyVoice |

### 8.4 SadTalker 视频生成

- **方案**：单张正面人像图 + 音频 → SadTalker → MP4（`github/SadTalker`）
- **模型清单**（位于 `github/SadTalker/`）：
  - `checkpoints/SadTalker_V0.0.2_256.safetensors`
  - `checkpoints/mapping_00109-model.pth.tar`
  - `checkpoints/mapping_00229-model.pth.tar`
  - `BFM_Fitting/*`
  - `gfpgan/weights/alignment_WFLW_4HG.pth`
  - `gfpgan/weights/detection_Resnet50_Final.pth`
- **运行配置**：
  - 默认 256px、无 face enhancer、batch_size=1，适配 8GB VRAM
  - `generate_video.py` 内置 NumPy 2.x / librosa 新版兼容性补丁，并 stub 掉 `gfpgan` 面部增强依赖
  - 数字人拼接优化：在 SadTalker 的 `paste_pic` 阶段 monkey-patch 为羽化椭圆 mask，替代原矩形硬 mask；可通过 `options.paste_feather_ratio`（默认 `0.25`）和 `options.paste_clone_mode`（`"normal"`/`"mixed"`，默认 `"normal"`）调参
- **输出目录**：`temp/video/<taskid>/output.mp4`
- **前端状态**：`sessionStorage.setItem('vv_generated_audio', audioPath)` 继承声音生成结果到视频生成页

### 8.4a 云端视频生成（阿里云百炼 DashScope wan2.2-s2v）

- **入口**：VideoGernerate 页面右上角「设置」齿轮 → 开启「默认使用云端算力加成」，填写阿里云百炼 API Key 与**业务空间 ID**。云端视频风格（`speech`/`singing`/`performance`）与分辨率（`480P`/`720P`）在 VideoGernerate 页面内选择。无需填写 API Host，固定使用 `dashscope.aliyuncs.com`。
- **官方文档**：https://bailian.console.aliyun.com/cn-beijing?tab=api#/api/?type=model&url=2978213
- **接口**：
  - 获取临时上传凭证：`GET https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen-vl-plus`
  - 图像检测：`POST https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/face-detect`，`model=wan2.2-s2v-detect`
  - 提交生成：`POST https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis/`，`model=wan2.2-s2v`，Header `X-DashScope-Async: enable`
  - 轮询结果：`GET https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}`
- **鉴权**：`Authorization: Bearer <DashScope API Key>`，Key 在 https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key 创建。
- **后端脚本**：`tools/generate_video_cloud.py`
- **流程**：
  1. 前端从 `localStorage` 读取 `vv_cloud_enabled`、`vv_cloud_dashscope_key`、`vv_cloud_workspace_id`；从页面读取 `wan_style`、`wan_resolution`。
  2. 调用 `generateVideo` 时，若开启云端且 key 存在，C++ 启动 `tools/generate_video_cloud.py` 并通过环境变量 `DASHSCOPE_API_KEY` 传入 key（不落盘）。
  3. Python 用 `qwen-vl-plus` 申请临时 OSS 凭证，上传图片和音频得到 `oss://` URL。
  4. 调用 `wan2.2-s2v-detect` 检测图片合规性（人脸/单人/正向等）。
  5. 由于 `wan2.2-s2v` 单次音频上限约 20 秒，脚本会按 20 秒/段自动切分音频，每段单独提交异步任务，最后把各段视频用 `ffmpeg -c copy` 拼接为完整视频。
  6. 轮询任务至 `SUCCEEDED`，下载输出视频到 `temp/video/<taskid>/output.mp4`。
- **输入限制**：
  - 图片 `.jpg/.jpeg/.png/.bmp/.webp`，建议清晰、单人、正面；脚本会自动把最小边不足 400 像素的图片等比放大，以满足检测接口要求。
  - 音频 `.wav/.mp3`（应用层自动转 MP3 后上传）。单次任务音频长度上限约 20 秒，超长音频会自动切片后分段生成再拼接。
- **失败策略**：云端失败后根据 `error_code` 弹窗提示（额度不足、鉴权失败、网络错误、内容审核、检测不通过等），并提供「重试」「前往充值」「打开设置」「改用本地生成」等操作；关闭云端开关后回退到本地 SadTalker。
- **依赖**：`requests`、`pydub`、`Pillow`、`ffmpeg`（由 `tools/ensure_dashscope_deps.py` 在构建期检查）。

### 8.4b 云端声音生成（阿里云百炼 DashScope CosyVoice）

- **入口**：VoiceGernerate 页面右上角「设置」齿轮 → 开启「默认使用云端算力加成」，填写阿里云百炼 API Key 与**业务空间 ID**。开启后页面音色预设切换为 CosyVoice 系统音色，并支持上传本地音频创建自定义复刻音色；关闭后回退到本地 Qwen3-TTS。
- **官方文档**：
  - 非实时语音合成：https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
  - 音色列表：https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list
  - 声音复刻：https://help.aliyun.com/zh/model-studio/voice-cloning-user-guide
- **固定模型**：`cosyvoice-v3-plus`（创建复刻音色时的 `target_model` 也必须一致）。
- **接口**：
  - 语音合成：`POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`
  - 创建复刻音色：`POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/customization`，`model=voice-enrollment`，`input.action=create_voice`
  - 临时上传凭证：复用 `qwen-vl-plus` 的 `getPolicy`（同 8.4a）。
- **系统音色预设**：`cosyvoice-v3-plus` 仅支持龙安欢（`longanhuan`）、龙安洋（`longanyang`）两个系统音色；其余音色（如 `longanlang`、`longxiaochun_v2` 等）属于 `cosyvoice-v2`，与该模型不匹配会返回 418。
- **后端脚本**：`tools/generate_voice_cloud.py`
- **流程**：
  1. 前端从 `localStorage` 读取 `vv_cloud_enabled`、`vv_cloud_dashscope_key`、`vv_cloud_workspace_id`。
  2. 点击「生成声音」时，若开启云端，C++ 启动 `tools/generate_voice_cloud.py` 并通过环境变量 `DASHSCOPE_API_KEY` 传入 key。
  3. 若用户选择「上传我的音色」，脚本先把样本上传到临时 OSS，再调用复刻接口创建 `voice_id`，最后用该 `voice_id` 合成。
  4. 若使用系统音色，直接把音色参数作为 `voice` 调用合成接口。
  5. 非流式返回 WAV 二进制，保存为 `temp/voice/<taskid>/output.wav`。
- **输入限制**：
  - 文案：支持普通文本。
  - 自定义音色样本：`wav/mp3/m4a`，推荐 10~20 秒、清晰朗读、无背景音，文件 ≤10 MB。
- **失败策略**：与 8.4a 一致（额度不足、鉴权失败、网络错误、输入不合规等）。
- **依赖**：`requests`、`pydub`（由 `tools/ensure_dashscope_deps.py` 在构建期检查）。

### 8.4c 云端文案改写 / 法务检查（阿里云百炼 DashScope deepseek-v4-flash）

- **入口**：ArticleRewrite 页面 → 开启「默认使用云端算力加成」并填写 API Key 与业务空间 ID。云端改写固定使用 `deepseek-v4-flash`，法务检查同样走该模型但使用最小化修改提示词。
- **接口**：`POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`，`model=deepseek-v4-flash`，`stream=false`。
- **后端脚本**：`tools/rewrite_text_cloud.py`
- **流程**：
  1. 前端从 `localStorage` 读取 `vv_cloud_enabled`、`vv_cloud_dashscope_key`、`vv_cloud_workspace_id`。
  2. 点击「改写文案」/「AI 法务检查」时，C++ 启动 `tools/rewrite_text_cloud.py`，通过环境变量 `DASHSCOPE_API_KEY` 传入 key，参数中携带 `workspace_id`、`mode`、`style`、`length`。
  3. 脚本复用本地 `STYLE_PROMPTS` 与 `LEGAL_SYSTEM_PROMPT`，调用 Chat Completions。
  4. 解析 `choices[0].message.content` 并按本地规则清理输出（移除 markdown、emoji、话题标签等）。
- **输出**：`temp/rewrite/<taskid>/output.json`，字段 `{"text": "..."}`。
- **失败策略**：返回 `error` 与 `error_code`（`AUTH_FAILED`、`INSUFFICIENT_BALANCE`、`INVALID_INPUT`、`NETWORK_ERROR`、`TASK_FAILED` 等），前端直接展示错误文案。
- **依赖**：`requests`（由 `tools/ensure_dashscope_deps.py` 在构建期检查）。

### 8.4d 云端链接提取文案（阿里云百炼 DashScope FunASR）

- **入口**：LinkVideoExtract 页面 → 粘贴视频链接或选择本地视频 → 开启「默认使用云端算力加成」并填写 API Key 与业务空间 ID。
- **后端脚本**：`tools/extract_link.py`（云端分支）
- **流程**：
  1. 本地流程不变：下载视频/读取本地文件 → `ffmpeg` 抽取 16kHz 单声道 WAV。
  2. 若开启云端，脚本调用 `dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen-vl-plus` 申请临时 OSS 凭证，上传 `audio.wav` 得到 `oss://...` URL。
  3. 提交 FunASR 异步任务：`POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/asr/transcription`，`model=fun-asr`，Header `X-DashScope-Async: enable`。
  4. 轮询 `GET https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/tasks/{task_id}` 至 `SUCCEEDED`。
  5. 从 `output.results[0].transcription_url` 下载识别结果 JSON，提取 `transcripts[*].text` 拼接为最终文案。
- **输出**：`temp/extract/<taskid>/output.json`，字段 `{"text": "..."}`。
- **失败策略**：与 8.4c 一致，错误码包括 `AUTH_FAILED`、`INSUFFICIENT_BALANCE`、`INVALID_INPUT`、`NETWORK_ERROR`、`TASK_FAILED`。
- **依赖**：`requests`、`ffmpeg`（由 `tools/ensure_dashscope_deps.py` 在构建期检查）。

### 8.5 抖音一键发布

- **主脚本**：`tools/publish_douyin.py`
- **服务实现**：`flyerhzm/douyin-mcp`（Node.js + Playwright），默认端口 `18062`
- **REST API**：
  - `GET  /api/v1/login/status` — 查询登录状态
  - `GET  /api/v1/login/qrcode` — 获取登录二维码（base64 PNG）
  - `POST /api/v1/publish` — 发布视频
- **部署步骤**：在 PowerShell 中运行（若提示执行策略限制，请加 `-ExecutionPolicy Bypass`）：
  ```powershell
  tools/setup_douyin_mcp.ps1
  # 或
  powershell -ExecutionPolicy Bypass -File tools/setup_douyin_mcp.ps1
  ```
  该脚本会自动：
  1. 克隆 `https://github.com/flyerhzm/douyin-mcp.git` 到 `localdep/douyin-mcp/`
  2. 应用 `tools/douyin-mcp-qrcode.patch`（让二维码接口返回 base64 图片）
  3. 运行 `npm install`
  4. 运行 `npx playwright install chromium`
- **前置条件**：
  - 系统已安装 **Node.js LTS** 和 **Git**，且 `node.exe` 在 PATH 中
  - 首次启动会自动下载 Playwright Chromium（约 150MB）
- **Cookie/日志**：`localdep/douyin-mcp/data/cookies.json` 与 `localdep/douyin-mcp/data/service.log`

### 8.6 小红书一键发布（多账号隔离）

- **主脚本**：`tools/publish_xiaohongshu.py`
- **服务实现**：
  - `xiaohongshu-mcp-windows-amd64.exe`（MCP 服务，headless 自动发布）
  - `xiaohongshu-login-windows-amd64.exe`（登录工具）
  - `xiaohongshu-draft-windows-amd64.exe`（草稿填充工具，可见浏览器）
- **通信协议**：MCP over HTTP（`http://localhost:<servicePort>/mcp`），调用 tool：`check_login_status`、`publish_with_video`
- **多账号隔离**：
  - 每个小红书账号拥有独立的 cookie 文件：`localdep/xiaohongshu-mcp/data/cookies.<accountId>.json`
  - 每个账号启动独立的 MCP 服务实例，监听独立端口 `18060 + index`
  - C++ 通过环境变量 `COOKIES_PATH` 指定当前账号的 cookie 文件，服务启动命令为 `xiaohongshu-mcp-windows-amd64.exe -port :<servicePort>`
- **部署步骤**：在 PowerShell 中运行（若提示执行策略限制，请加 `-ExecutionPolicy Bypass`）：
  ```powershell
  tools/setup_xiaohongshu_mcp.ps1
  # 或
  powershell -ExecutionPolicy Bypass -File tools/setup_xiaohongshu_mcp.ps1
  ```
  脚本会：
  1. 从 `xpzouying/xiaohongshu-mcp` GitHub Releases 下载 `xiaohongshu-mcp-windows-amd64.zip`
  2. 解压到 `localdep/xiaohongshu-mcp/`，得到两个 exe
  3. 自动备份/还原已有的 `cookies.json`
- **手动部署**：如果自动下载失败（常见于无法访问 GitHub 的网络环境），请：
  1. 浏览器访问 https://github.com/xpzouying/xiaohongshu-mcp/releases/latest
  2. 下载 `xiaohongshu-mcp-windows-amd64.zip`
  3. 解压到 `localdep/xiaohongshu-mcp/`
- **添加账号/登录流程**：
  1. 在 Publish 页点击「添加平台账号」→ 选择「小红书」→ 填写账号名称
  2. 确认添加后，前端立即保存账号信息（含 `cookiePath`、`servicePort`）并弹窗提示「已打开浏览器，请扫码…」
  3. C++ 调用 `startXiaohongshuLogin` 启动 `xiaohongshu-login-windows-amd64.exe`（通过 `COOKIES_PATH` 指向该账号的 cookie 文件）
  4. 用户在浏览器中用小红书 App 扫码登录
  5. 登录工具自动保存 cookie 到 `localdep/xiaohongshu-mcp/data/cookies.<accountId>.json`
  6. 弹窗提供「我已登录」和「关闭」两个按钮；点击任意一个都会关闭弹窗并异步刷新该账号状态，不会阻塞 UI
- **状态刷新**：
  - 进入 Publish 页时，前端优先使用账号对象中的 `lastLoggedIn` / `lastStatusAt` 缓存（30 分钟有效）
  - 缓存过期或没有缓存的账号才会启动 `getXiaohongshuLoginStatusAsync` + `checkXiaohongshuLoginStatusTask` 异步校验
  - 手动点击「刷新登录状态」、添加新账号后、或点击「立即发布」前会强制实时校验
  - 刷新过程中账号列表区域显示全屏「正在刷新登录状态...」遮罩动画，完成后自动消失
  - 每个账号卡片在检测中显示「检测中...」，刷新结束后显示「已登录」/「未登录」/「已过期」
  - 校验结果为未登录的账号卡片显示「已过期」状态与「刷新登录」按钮，点击后重新打开浏览器扫码
- **发布流程**：
  1. 选中已登录的小红书账号，填写标题/描述/标签/视频，可选上传封面
  2. 选择发布模式：「直接发布」（默认公开可见）或「存草稿」
  3. 点击右下角「立即发布」，前端立即显示不可关闭的进度弹框
  4. C++ 把 `title`/`content`/`video`/`cover`/`tags`/`mode`/`browser_path` 透传给 `tools/publish_xiaohongshu.py`
  5. **直接发布**：Python 启动 MCP 服务并调用 `publish_with_video`（`is_draft=false`），上游 headless 打开视频发布页，自动上传视频/封面、填内容、设置公开可见并点击发布
  6. **保存草稿**：Python 直接以 detached 方式启动 `xiaohongshu-draft-windows-amd64.exe`，以**可见浏览器**打开 `https://creator.xiaohongshu.com/publish/publish?from=menu&target=video`，自动上传视频/封面并填入标题/描述/标签，随后保持页面打开供用户继续编辑；前端提示「已打开小红书创作平台，请继续编辑并保存草稿」
  7. 发布/打开完成后弹框显示结果，点击「我知道了」关闭
- **发布前状态检查**：点击「立即发布」后，先实际调用 `getXiaohongshuLoginStatus` 检查当前选中账号；若已过期/未登录，直接提示用户「请先在账号列表中刷新登录状态」，不自动打开浏览器登录窗口
- **刷新期间禁用发布**：账号列表正在刷新登录状态时，右下角「立即发布」按钮置灰不可点击，刷新完成后恢复
- **登录弹窗行为**：仅在添加账号/点击账号卡片「刷新登录」时才会弹出扫码登录弹窗；「关闭」会取消登录并终止浏览器登录工具；「我已登录」会在状态校验通过后才会继续
- **Cookie/日志**：`localdep/xiaohongshu-mcp/data/cookies.<accountId>.json`、`localdep/xiaohongshu-mcp/data/service.<port>.log`

### 8.7 快手一键发布

- **主脚本**：`tools/publish_kuaishou.py`
- **服务实现**：`dreammis/social-auto-upload` 的 `uploader/ks_uploader/main.py`，通过 `tools/kuaishou_mcp_service.py` 封装为 FastAPI 服务，默认端口 `18063`
- **REST API**：
  - `GET  /api/v1/login/status` — 查询登录状态
  - `GET  /api/v1/login/qrcode` — 获取登录二维码（base64 PNG）
  - `POST /api/v1/publish` — 发布视频
  - `GET  /api/v1/publish/{task_id}` — 查询发布任务状态
- **部署步骤**：在 PowerShell 中运行（若提示执行策略限制，请加 `-ExecutionPolicy Bypass`）：
  ```powershell
  tools/setup_kuaishou_mcp.ps1
  # 或
  powershell -ExecutionPolicy Bypass -File tools/setup_kuaishou_mcp.ps1
  ```
  脚本会：
  1. 克隆 `https://github.com/dreammis/social-auto-upload.git` 到 `localdep/social-auto-upload/`
  2. 创建独立 Python venv（基于 `localdep/python/python.exe`）
  3. 安装 `social-auto-upload` 及其依赖（含 `patchright`）
  4. 安装 `patchright` Chromium（首次约 150MB，使用国内镜像）
  5. 复制 `tools/kuaishou_mcp_service.py` 并创建 `conf.py`
- **前置条件**：
  - 系统已安装 **Git**
  - 首次启动会自动下载 patchright Chromium（约 150MB）
- **Cookie/日志**：`localdep/social-auto-upload/cookies/kuaishou.json` 与 `localdep/social-auto-upload/data/service.log`

### 8.8 账号制发布（Publish 页）

- **状态存储**：`localStorage`
  - `vv_publish_accounts`：账号数组，字段 `{ id, platform, accountName, displayName, loggedIn }`；小红书账号额外保存 `cookiePath`（如 `localdep/xiaohongshu-mcp/data/cookies.<accountId>.json`）和 `servicePort`（如 `18060`/`18061`…）
  - `vv_publish_active_account`：当前选中账号 ID
- **流程**：
  1. 点击右侧“添加平台账号”/“去添加账号”/底部加号按钮 → 打开添加账号弹窗
  2. 选择平台（小红书/抖音/快手）并填写账号名称
  3. 确认后自动弹出二维码登录弹窗
  4. App 扫码成功后账号卡片标记为“已登录”
  5. 点击账号卡片选中，右下角按钮固定显示“立即发布”
  6. 点击发布按钮按选中账号平台调用对应服务（小红书会根据当前模式执行“直接发布”或“保存草稿”）
- **相关代码**：
  - `assets/js/app.js`：`renderAccountList()`、`setupAddAccountModal()`、`loginPlatform()`、`publishNow()`、`refreshXiaohongshuLoginStatus()`、`refreshSingleXiaohongshuLoginStatus()`、`loginXiaohongshuAccount()`、`ensureAccountRefreshButton()`
  - `assets/Publish.html`：右侧账号区 `.v23_739`、文件名标签 `.v23_705`
  - `assets/css/app.css`：`.pub-account-*`、`.pub-account-status.expired`、`.pub-account-refresh`、`.pub-account-refresh-all`、`.pub-xhs-login-footer`、`.pub-modal-*`、`.pub-qr-*`

---

## 9. VideoCut 网感剪辑

### 9.1 功能说明

VideoCut 是第六步“网感剪辑”的后端实现，全部离线运行：

- **音视频参数**：人声音量、BGM 音量、视频倍速、剪气口
- **字幕**：8 套 ASS 样式模板、关键词高亮
- **背景音乐**：用户上传音乐循环混音
- **AI 音效**：根据文案关键词自动匹配本地音效

### 9.2 依赖

- **ffmpeg / ffprobe**：必须放在 `localdep/tools/ffmpeg.exe` 与 `localdep/tools/ffprobe.exe`，或确保在 PATH 中。
- **pydub**：已包含在 `localdep/python` 中。
- **FunASR**：复用 `extract_link.py` 同款模型（paraformer-zh + fsmn-vad + ct-punc）。
- **本地音效库**：默认在 `localdep/sfx/`。当前仓库已放置 Kenney 音效包 + `sfx_index.json`；如需更新索引，运行：
  ```bash
  localdep/python/python.exe tools/build_sfx_index.py
  ```

### 9.3 后端脚本

- `tools/video_cut.py`：核心剪辑管线
- `tools/build_sfx_index.py`：扫描 `localdep/sfx/` 生成 `sfx_index.json`

### 9.4 前端约定

- 左侧四个导航项（音视频参数 / 字幕 / BGM / 音效）右上角有开关，通过 JS 动态注入。
- 从 VideoGernerate 进入 VideoCut 时，默认读取 `sessionStorage.getItem('vv_generated_video')` 作为视频源。
- 剪辑调用 `cutVideo`，轮询 `checkCutTask`。
- 剪辑完成预览：`video_cut.py` 生成 `poster.jpg` 并写入 `output.json["poster_path"]`；前端完成态将海报设为 `.v19_326` 背景图。

---

## 10. BannerGenerate 标题封面

### 10.1 功能说明

- **模板选择**：V0–V11 共 12 套默认封面排版模板，模板网格实时预览。
- **多标题文本编辑**：支持添加/删除多个标题单元，每个单元独立设置字体、字号、样式、对齐、颜色、不透明度、字/行间距、位置、旋转、背景框与阴影/描边。
- **标题编辑**：默认继承 `vv_voice_text` → `vv_extracted_text`，页面提供输入框可修改。
- **拖拽缩放**：标题可在预览区直接拖动位置和右下角缩放手柄调整大小。
- **封面来源**：
  - 默认读取上一步 `vv_generated_video`，自动从视频 0–3 秒随机抽帧。
  - 用户上传视频后同样自动抽帧。
  - “重新随机抽帧”可再次抽取。
  - “本地图片”支持上传自定义封面。
  - 无视频/无封面时预览区显示提示文案，并保留明显边框。
- **生成封面**：点击右下角“生成封面”调用 `generateBanner`，输出 1080×1920 JPG，路径保存到 `sessionStorage['vv_banner_output_path']`。

### 10.2 后端脚本

- `tools/generate_banner.py`：
  - `mode=extract_frame`：用 ffmpeg 随机抽取视频帧。
  - `mode=generate`：用 Pillow 合成最终封面。

### 10.3 Native Call

| 名称 | 用途 |
|---|---|
| `extractBannerFrame` | 从视频 0–3 秒随机抽帧 |
| `generateBanner` | 合成最终封面 |
| `checkBannerTask` | 轮询封面任务结果 |

### 10.4 状态键

- `vv_banner_title`：标题文本（与第一个文本单元保持同步，兼容旧流程）
- `vv_banner_template`：当前模板索引
- `vv_banner_cover_source`：`video` / `upload` / `none`
- `vv_banner_cover_path`：当前封面图路径
- `vv_banner_text_units`：多标题单元数组
- `vv_banner_selected_text_id`：当前选中的文本单元 ID
- `vv_banner_output_path`：最终生成封面路径

---

## 11. 代码风格与开发约定

### 11.1 C++

- C++20，MSVC（Windows）/ clang（macOS 预设）
- 标识符：类名 `CamelCase`，函数/变量 `camelCase` 或 `snake_case`
- 注释以中文为主
- 匿名命名空间用于组织文件级辅助函数
- 使用 `spdlog::info/warn/error` 记录日志，日志文件为 `Voicevideo.log`
  - 开发阶段日志生成在 exe 工作目录，通常位于 `build/Voicevideo.log`（与 `build/Voicevideo.exe` 同级），也可在项目根目录找到
- 字符串/路径处理注意 UTF-8：`sanitizeUtf8()` 用于替换非法 UTF-8 序列为 `U+FFFD`，防止 JSON 解析崩溃

### 11.2 Python

- 使用 4 空格缩进（与 `.vscode/settings.json` 一致）
- 每个工具脚本接受一个 JSON 参数文件：`python script.py <args.json>`
- 统一通过 `_setup_localdep()` 设置 `MODELSCOPE_CACHE`、`HF_HOME`、`HUGGINGFACE_HUB_CACHE`
- `extract_link.py` 额外强制离线：`TRANSFORMERS_OFFLINE=1`、`HF_HUB_OFFLINE=1`
- 库输出重定向：使用 `io.StringIO()` 和 `contextlib.redirect_stdout()` 避免污染最终 JSON
- 所有脚本导入时调用 `_reconfigure_stdio()` 强制 UTF-8

### 11.3 前端

- HTML 文件为 **UTF-8 with BOM**
- 页面级 CSS 类名为 `.v{数字}_{数字}`，不要直接修改 Figma 生成的 CSS，优先在 `app.css` 中覆盖
- `app.css` 使用大量 `!important` 和 `pointer-events: none` 处理事件穿透
- 页面切换通过 `navigateTo()`，fetch 替换 body 后需要重新加载 `app.js`
- 修改 CSS/JS 后**不需要重新编译 C++**，直接重启 `Voicevideo.exe`

### 11.4 VS Code 设置

`.vscode/settings.json`：
- `editor.tabSize`: 4
- `editor.detectIndentation`: false
- `editor.formatOnSave`: true
- `editor.formatOnPaste`: true

---

## 12. 测试策略

### 12.1 现状

- **没有单元测试框架**，没有 `test/`、`tests/`、`*_test.cpp`、`*_test.py`
- `build/Testing/` 是 CMake 默认 CTest 目录，无实际用例
- 项目当前依赖手动测试

### 12.2 手动测试方式

各功能手动测试参数位于 `temp/testdata/` 和对应功能目录：

```bash
# 文案改写
localdep/python/python.exe tools/rewrite_text.py temp/testdata/args.json

# 声音生成
localdep/python/python.exe tools/generate_voice.py temp/voice_test_args.json

# 视频生成（需先准备 source_image + audio）
localdep/python/python.exe tools/generate_video.py temp/video_test_args.json

# 视频提取
localdep/python/python.exe tools/extract_link.py temp/testdata/args_url.json

# 网感剪辑
localdep/python/python.exe tools/video_cut.py temp/testdata/video_cut_args.json
```

### 12.3 语法检查

```bash
localdep/python/python.exe -m py_compile tools/generate_voice.py
localdep/python/python.exe -m py_compile tools/generate_video.py
localdep/python/python.exe -m py_compile tools/video_cut.py
localdep/python/python.exe -m py_compile tools/generate_banner.py
```

### 12.4 建议

新增功能时应同步在 `temp/testdata/` 中添加示例 `args.json`，便于回归验证。

---

## 13. 安全注意事项

- **外部进程执行**：C++ 通过 `CreateProcessW` 直接启动 Python 脚本，参数来自前端 `window.native_call`。所有参数在写入 `args.json` 前仅做 JSON 序列化，**没有严格的输入校验和沙箱**，不要传入未经验证的用户输入。
- **本地文件路径**：`extract_link.py` 接受 `file:///` 和本地绝对路径，会调用 `ffmpeg` 处理。确保传入路径可信，避免路径遍历。
- **网络下载**：`extract_link.py` 使用 `yt-dlp` 和抖音移动端解析，会从互联网下载视频。Cookie 文件搜索路径为 `localdep/cookies.txt`、`tools/cookies.txt`，可提前放置以支持需要登录的平台。
- **发布服务**：小红书/抖音/快手发布服务各自以独立进程运行并监听本地端口（18060/18062/18063），这些服务会操作浏览器和平台账号 Cookie，请确保运行环境可信。
- **日志文件**：`Voicevideo.log`、各 Python 脚本的 `stdout.log`/`stderr.log` 可能包含文件路径、错误堆栈等信息，发布打包时注意清理或妥善处理。

---

## 14. 已知限制与注意事项

- **TTS 经典模型（1.7B）已在 RTX 2080 Super 8GB 上验证可运行**，显存不足时（如 4GB）会回退到 CPU 推理
- **Qwen3-TTS 在 fp16 下会触发 CUDA assert**，当前强制使用 `float32`
- **声音生成不再使用 `device_map="auto"`**，CUDA 可用时显式使用 `device_map="cuda"`，避免 `accelerate` 将部分层放到 meta device 导致 `Tensor.item() cannot be called on meta tensors`
- **0.6B 快速模型会忽略 `instruct`**，因此选择 fast 模型时情绪控制无效
- **语速通过 `librosa.effects.time_stretch` 后处理实现**，不是模型原生参数
- 运行时控制台可能有 SoX 未找到警告（来自 torchaudio），不影响生成
- macOS 预设存在但 `largui` 对应实现为桩，实际仅 Windows 可用
- `src/Voicevideo.h` 当前为占位头文件，核心逻辑集中在 `src/Voicevideo.cpp`

---

## 15. 构建输出与 localdep 解析规则

### 15.1 构建输出目录

- `CMakeLists.txt` 通过 `CMAKE_RUNTIME_OUTPUT_DIRECTORY` 强制把所有配置（Debug / Release 等）的可执行文件输出到 **源码主目录下的 `build/`**。
- 无论是命令行 `cmake --build build` 还是 Visual Studio 的 CMake 目标，最终产物都应是 `build/Voicevideo.exe`。
- POST_BUILD 阶段会：
  1. 先删除 `build/assets` 和 `build/tools`；
  2. 再把源码主目录的 `assets/`、`tools/` 复制到 `build/`。
- 这样可以保证前端资源或 Python 脚本修改后，重新构建即可生效，不会残留旧文件。

### 15.2 localdep 解析优先级

`src/Voicevideo.cpp` 中的 `startPythonScript()` 按以下优先级定位 `localdep`：

1. 先调用 `findProjectRoot()` 向上查找包含 `CMakeLists.txt` 且存在 `tools/` 与 `localdep/`（或 `.venv/`）的目录，即**源码主目录**。
2. 若源码主目录下存在 `localdep/`，则优先使用它，并通过环境变量 `VOICEVIDEO_LOCALDEP` 传给 Python 子进程。
3. 若源码主目录找不到 `localdep/`（通常是发行版本将 `localdep` 与 exe 一起打包），则回退到 **exe 同级目录下的 `localdep/`**。

因此开发阶段无需把 `localdep/` 复制到 `build/`，修改 `localdep/` 后直接重启 `build/Voicevideo.exe` 即可生效；发布打包时再把 `localdep/` 复制到 exe 同级目录。

---

## 16. 关键文件速查

| 用途 | 路径 |
|---|---|
| 主入口 | `src/Voicevideo.cpp` |
| WebView2 实现 | `src/largui/CLarWebview.cpp` |
| 前端主脚本 | `assets/js/app.js` |
| 全局样式覆盖 | `assets/css/app.css` |
| 构建配置 | `CMakeLists.txt` |
| vcpkg 清单 | `vcpkg.json` |
| CMake 预设 | `CMakePresets.json`、`CMakeUserPresets.json` |
| 离线依赖 | `localdep/` |
| 运行时临时 | `temp/` |
| 数字人源码 | `github/SadTalker/` |
| 构建产物 | `build/Voicevideo.exe` |
| 独立后端 | `server/` |

---

## 17. 独立后端服务（Standalone Backend）

项目包含一个与 C++ 客户端分离的 FastAPI 后端，用于承载未来需要服务端支持的接口。

- **目录**：`server/`
- **框架**：FastAPI + Uvicorn
- **默认监听**：`0.0.0.0:18080`
- **启动方式**（开发/本地测试，必须使用项目内置 Python，因为它已安装 `fastapi`/`uvicorn`）：
  ```bash
  localdep/python/python.exe server/run.py
  ```
  或在 `server/` 目录下直接运行：
  ```bash
  start.bat
  # 或
  powershell -ExecutionPolicy Bypass -File start.ps1
  ```
- **环境变量**：
  - `VOICEVIDEO_BACKEND_HOST`：覆盖监听地址（默认 `0.0.0.0`）
  - `VOICEVIDEO_BACKEND_PORT`：覆盖监听端口（默认 `18080`）
  - `VOICEVIDEO_BACKEND_URL`：客户端侧覆盖后端地址（默认 `http://127.0.0.1:18080`）
- **前端握手**：页面加载后调用 `nativeCall('getBackendBaseUrl')` 取得地址，再 `fetch(url + '/api/health')` 验证连通性。
- **当前接口**：
  - `GET /api/health` — 返回服务状态、版本、时间戳
  - `GET /api/update/check?version=YYYYMMDDHHMM` — 检查客户端是否有更新包
  - `GET /api/update/download/<version>` — 下载 `server/updatezip/<version>/VideoVoice.zip`
  - `POST /api/auth/register` — 用户名/密码注册，成功后返回 JWT
  - `POST /api/auth/login` — 用户名/密码登录，成功后返回 JWT
  - `POST /api/auth/activate` — `Authorization: Bearer <token>`，校验激活码并激活账号
  - `GET /api/auth/me` — `Authorization: Bearer <token>`，返回当前用户信息及激活状态
  - `POST /api/admin/codes` — `X-Admin-Key`，生成激活码
  - `GET /api/admin/codes` — `X-Admin-Key`，查询最近生成的激活码
- **启动异常排查**：若出现 `404 Not Found` 且 `docs` 中看不到 `/api/auth/*`，通常是 18080 端口被旧进程占用或加载了过期 `__pycache__`。解决：结束占用 18080 的 `python.exe`/`uvicorn`，删除 `server/app/**/__pycache__` 后重新启动。
- **认证方式**：JWT only，算法 `HS256`，有效期默认 30 天（`VOICEVIDEO_JWT_EXPIRE_DAYS`），密钥必须通过 `VOICEVIDEO_JWT_SECRET` 在生产环境覆盖。
- **用户数据库**：SQLite 单文件 `server/data/users.db`，SQLAlchemy 管理；`User` 表含 `id/username/password_hash/is_activated/activation_code_id/activated_at/activation_expires_at/created_at/updated_at`。
- **激活码表**：`activation_codes` 用于存储付费/试用激活码（`code/code_type/trial_days/max_uses/used_count/expires_at/is_active/remark`）。
- **密码**：使用 `bcrypt` 对 SHA256 预摘要后的密码进行哈希，避开 bcrypt 72 字节限制；登录和注册失败均返回统一的 `用户名或密码错误`。
- **管理脚本**：`tools/manage_activation_codes.py` 用于生成、列出、禁用激活码，也可直接 grant 某用户激活状态用于开发测试。

### 17.1 热更新（Hot Update）

客户端每次启动时先展示启动窗口（480×320，无边框 WebView2，加载 `assets/StartUp.html`），在该窗口中完成更新检查、用户登录、激活码校验与主窗口初始化。

- **客户端版本文件**：`<exeDir>/version.txt`，由开发者手动维护，格式为 `YYYYMMDDHHMM`。
- **服务端更新包目录**：`server/updatezip/<YYYYMMDDHHMM>/VideoVoice.zip`。
- **更新判断**：后端比较 `updatezip` 中最新的日期目录与客户端 `version.txt`；若服务端更新，则返回下载地址。
- **自更新**：客户端把 ZIP 下载到 `temp/update/<version>/VideoVoice.zip`，生成 `temp/update/apply_update.ps1`，启动独立 PowerShell updater 后退出当前进程；updater 等待原进程结束，解压覆盖 exe 目录，重新启动 `Voicevideo.exe`。
- **登录门控**：
  1. 更新检查完成后，前端读取 `localStorage.getItem('vv_access_token')`。
  2. 携带 token 请求 `GET /api/auth/me`；若通过且 `is_activated=true` 则直接 `startupReady`。
  3. 无 token 或 token 失效时，在启动窗口显示登录/注册表单。
  4. 登录或注册成功后，若账号未激活则切换到激活码面板；已激活则把 token 写入 `localStorage` 并通知 C++ 进入主窗口。
  5. 在激活码面板输入有效激活码后调用 `POST /api/auth/activate`；成功后刷新 token 并 `startupReady`。
  6. 购买激活码链接通过 `nativeCall('openUrl')` 打开外部浏览器；该调用在启动窗口也已绑定。
  7. 主窗口只有在 `startupReady` 被调用后才会创建，因此登录/激活是强制门槛。
  8. 若用户在未登录/未就绪前关闭启动窗口，`runStartupWindow()` 会返回 `Failed`，C++ 直接退出，不会创建主窗口。
- **日志**：新增启动/更新/认证相关日志均使用英文，避免编码问题。
- **注意**：当前仅实现启动门控的登录/注册；主窗口内的用户头像、退出登录等功能尚未接入，后续如需请在 `assets/js/app.js` 与 `src/Voicevideo.cpp` 中补充。

### 18. 激活码变现门控（Activation Code）

为了支持付费/试用变现，启动流程在登录成功后增加了激活码校验。

- **数据模型**（`server/app/models.py`）：
  - `User` 增加 `is_activated`、`activation_code_id`、`activated_at`、`activation_expires_at`。
  - `ActivationCode` 记录激活码、类型（`permanent`/`trial`）、试用天数、最大使用次数、已用次数、有效期、启用状态。
- **接口**（`server/app/api/auth.py`）：
  - `POST /api/auth/activate`：校验激活码并标记用户激活（JWT 保护）。
  - `GET /api/auth/me`：返回用户激活状态，若试用已过期会自动重置 `is_activated`。
- **迁移**（`server/app/db_migrate.py`）：
  - 项目未使用 Alembic，启动时自动检测并 `ALTER TABLE` 添加缺失字段。
- **管理工具**：
  - `tools/manage_activation_codes.py generate --count N --type permanent|trial [--days D]`
  - `tools/manage_activation_codes.py list`
  - `tools/manage_activation_codes.py disable <code>`
  - `tools/manage_activation_codes.py grant <username>`（开发便利）
- **前端**（`assets/StartUp.html/css/js`）：
  - 登录成功后若未激活，显示「激活账号」面板。
  - 激活码格式为 `PPPP-BBBB-BBBB-BBBB`（4 位随机前缀 + 12 位随机主体），输入框自动分段。
  - 错误时输入框抖动并显示中文错误详情。
  - 「购买激活码」调用 `nativeCall('openUrl')`。
- **C++**（`src/Voicevideo.cpp`）：
  - `runStartupWindow()` 中新增 `openUrl` native call 绑定，供购买链接使用。
  - 主窗口仍只有收到 `startupReady` 后才会创建，未激活无法绕过。
- **测试流程**：
  1. 启动后端，生成测试激活码：`localdep/python/python.exe tools/manage_activation_codes.py generate --count 1 --type permanent`
  2. 登录未激活账号，应弹出激活面板。
  3. 输入有效激活码后进入主窗口。
  4. 重新启动程序，登录后应直接进主窗口。

### 19. 激活码管理后台（Admin Tool）

用于运营人员生成试用/永久激活码并手动发给客户。

- **启动方式**：命令行带 `--admin` 参数
  ```bash
  ./build/Voicevideo.exe --admin
  ```
  该窗口独立运行，不会进入普通登录/主窗口流程。
- **窗口规格**：680×520 无边框 WebView2，加载 `assets/Admin.html`。
- **管理密钥**：
  - 后端读取环境变量 `VOICEVIDEO_ADMIN_SECRET`（默认开发密钥见 `server/app/config.py`）。
  - Admin 窗口首次打开要求输入该密钥，校验通过后存入 `sessionStorage`。
  - 生产环境务必修改默认密钥。
- **Admin 接口**（`server/app/api/admin.py`）：
  - `POST /api/admin/codes` — 生成激活码（字段：`count/code_type/trial_days/remark`）。
  - `GET /api/admin/codes` — 查询激活码，支持 `search`（搜索码/备注/激活账号）、`used`（`all`/`used`/`unused` 过滤）、`limit`/`offset` 分页；返回每个码的使用状态、激活账号、激活时间、剩余天数（试用码）。
  - 请求头必须携带 `X-Admin-Key`。
- **前端功能**（`assets/js/admin.js`）：
  - 选择永久或试用码，填写数量与备注（订单号/客户信息）。
  - 生成结果单条复制、全部复制。
  - 导出 CSV（UTF-8 with BOM，方便 Excel 打开）。
  - 查询记录支持按订单号/客户信息/兑换码搜索、按使用状态筛选、分页翻页。
- **C++ native calls**：
  - `copyToClipboard` — 将文本写入系统剪贴板。
  - `saveCsvFile` — 弹出保存对话框并写入 CSV。
- **命令行脚本（可选）**：
  - `tools/manage_activation_codes.py` 仍可用于批量生成或脚本化场景。
- **典型 workflow**：
  1. 电商平台收到订单。
  2. 运营人员启动 `Voicevideo.exe --admin`。
  3. 选择码类型、数量、填写订单备注，点击生成。
  4. 复制生成的码，粘贴到电商平台聊天窗口发给客户。
