# Voicevideo — Agent Guide

本文件面向 AI 编程助手。阅读者应当被假设为对该项目一无所知。以下内容均基于项目当前实际文件与配置整理而成，不添加推测。

## 项目概述

- **项目名称**：Voicevideo
- **语言**：C++（CMake 中显式指定 `CXX_STANDARD 20`）
- **构建系统**：CMake（最低版本 3.16，因 `webview` 依赖需要）
- **包管理器**：vcpkg（manifest 模式，通过 `vcpkg.json` 声明依赖）
- **目标平台**：Windows / macOS（跨平台桌面应用，WebView 使用 `webview/webview`）
- **生成器**：Ninja（由 `CMakePresets.json` 指定，并配置 `architecture`/`toolset` 自动定位 MSVC）
- **项目类型**：单可执行文件控制台/桌面应用
- **入口文件**：`src/Voicevideo.cpp`
- **主头文件**：`src/Voicevideo.h`

当前代码处于非常早期的“骨架/Hello World”阶段：`main()` 依次初始化并打印 fmt、libcurl、nlohmann-json、spdlog、libsodium 的状态，并弹出一个最小 webview 窗口用于验证跨平台 WebView 库可用。

## 项目结构

```text
Voicevideo/
├── CMakeLists.txt            # CMake 主配置
├── CMakePresets.json         # 共享 CMake preset（vcpkg）
├── CMakeUserPresets.json     # 用户本地 preset（default / default-macos）
├── vcpkg.json                # vcpkg 依赖清单
├── vcpkg-configuration.json  # vcpkg 注册表配置
├── src/                      # C++ 源码
│   ├── Voicevideo.cpp        # 主程序入口
│   ├── Voicevideo.h          # 项目头文件
│   └── Voicevideo.exe.manifest  # Windows DPI 感知清单
├── assets/                   # 前端资源（HTML/CSS/JS/图片）
│   ├── LinkVideoExtract.html # 第一步：链接/视频提取文案
│   ├── ArticleRewrite.html   # 第二步：改写文案
│   ├── css/
│   │   ├── LinkVideoExtract.css
│   │   └── ArticleRewrite.css
│   ├── js/
│   │   └── app.js            # 交互逻辑与页面导航
│   └── images/               # 设计图片素材
├── .vscode/settings.json     # VS Code 编辑器设置
├── build/                    # Windows 构建目录
├── build-macos/              # macOS 构建目录
└── AGENTS.md                 # 本文件
```

## 技术栈与依赖

`vcpkg.json` 中声明的第三方库：

| 包名 | 用途 |
|------|------|
| `curl` | HTTP/网络请求（libcurl） |
| `fmt` | 格式化输出 |
| `libsodium` | 现代密码学库 |
| `minizip` | ZIP 压缩/解压 |
| `nlohmann-json` | JSON 解析与生成 |
| `zlib` | 数据压缩 |
| `spdlog` | 日志库 |
| `webview` (via FetchContent) | 跨平台 WebView（Windows WebView2 / macOS WKWebView） |

CMake 中通过 `find_package` 引入这些包，并在 `target_link_libraries` 中链接。

## 构建与运行

### 前置条件

1. 已安装 CMake（≥3.16）与 Ninja。`CMakePresets.json` 使用 version 3，需要支持该版本的 CMake。
2. 已安装并初始化 vcpkg，且环境变量 `VCPKG_ROOT` 指向其根目录。
   - 项目中的 `CMakeUserPresets.json` 将 `VCPKG_ROOT` 硬编码为 `C:\Users\86187\vcpkg`，若路径不同请修改该文件或改用环境变量。
3. Windows 平台 + MSVC 编译器，或 macOS + Xcode Command Line Tools（Apple Clang）。
4. 由于使用 Ninja + MSVC，Windows 构建建议从 **Visual Studio 开发人员命令提示符/ PowerShell** 中执行，或确保 `INCLUDE`/`LIB` 等 MSVC 环境变量已设置。

### 使用 CMake Preset 构建（推荐）

#### Windows

在 **Visual Studio 2026 开发人员 PowerShell/命令提示符** 中执行：

```powershell
# 配置（使用 default preset）
cmake --preset default

# 构建
cmake --build build

# 运行
.\build\Voicevideo.exe
```

若未打开开发人员提示符，也可手动初始化环境后构建：

```powershell
& "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
cmake --preset default
cmake --build build
```

#### macOS

```bash
# 配置（使用 default-macos preset）
cmake --preset default-macos

# 构建
cmake --build build-macos

# 运行
./build-macos/Voicevideo
```

### 前端资源与 UI 开发

项目使用 **HTML / CSS / JS** 作为界面层，C++ 仅负责启动 webview 窗口并加载前端页面。

当前界面流程：
1. 程序启动后加载 `assets/LinkVideoExtract.html`（链接/视频提取文案）。
2. 点击右下角“下一步”进入 `assets/ArticleRewrite.html`（改写文案）。
3. 点击 ArticleRewrite 页面左下角“上一步”可返回 LinkVideoExtract。

- 用户提供 HTML/CSS/图片素材，放入 `assets/` 目录。
- AI 编写 `assets/js/app.js`，负责交互逻辑、页面导航、动效与业务逻辑。
- 构建时 CMake 会自动把 `assets/` 复制到输出目录（`build/assets/` 或 `build-macos/assets/`）。
- 所有 HTML/JS/C++ 源文件统一使用 **UTF-8 with BOM** 编码。

### DPI 缩放

Windows 上已嵌入 `Voicevideo.exe.manifest`，声明 `PerMonitorV2` DPI 感知，避免系统在 125%/150%/200% 缩放时强制拉伸导致模糊。

前端 CSS 已做基础适配：
- 使用 `rem` 等相对单位。
- 通过 `window.devicePixelRatio` 在 JS 中动态设置 `--scale-factor`。

建议你在设计前端时：
- 以 100% 缩放为基准设计尺寸。
- 避免大量固定 `px` 布局，优先使用 flex/grid/rem/vw/vh。
- 高清图片提供 2x/3x 版本，或通过 `srcset` 按 `devicePixelRatio` 加载。

### 使用 Visual Studio 打开

项目根目录包含 CMake 配置，Visual Studio 可直接识别 `CMakeLists.txt` 并选择 `vcpkg` preset 进行构建。当前 VS 工作区输出目录为 `build/`。

### 已知问题

- `vcpkg.json` 当前缺少 `builtin-baseline`。运行 vcpkg 时可能会提示“Your vcpkg instance needs to have a baseline specified...”。
- 若出现该错误，请在 `vcpkg.json` 中加入 `builtin-baseline` 字段，或在 `vcpkg-configuration.json` 中配置默认注册表 baseline。
- 若从普通终端运行 `cmake --preset default` 时报错 `CMAKE_C_COMPILER not set` / `CMAKE_CXX_COMPILER not set`：
  - 请确认使用的是本项目的 `default` preset（它会正确设置 `VCPKG_ROOT`）。
  - 请从 Visual Studio 开发人员命令提示符/PowerShell 中执行，或先调用 `vcvarsall.bat x64` 初始化 MSVC 环境。
  - `CMakePresets.json` 已添加 `architecture`/`toolset` 字段以辅助 CMake 自动定位 MSVC，但仍需 Ninja 和 MSVC 环境可用。

## 测试

- 当前项目**没有**测试框架、测试目录或测试脚本。
- 若后续添加测试，建议：
  - 引入 GoogleTest 或 Catch2（通过 vcpkg）。
  - 在 `CMakeLists.txt` 中启用 `enable_testing()` 并通过 `add_test()` 注册用例。
  - 将测试源码放在 `tests/` 目录下。

## 代码风格指南

### 缩进与格式

根据 `.vscode/settings.json`：

- 使用 **4 个空格** 缩进（`editor.tabSize: 4`）。
- 关闭自动检测文件缩进（`editor.detectIndentation: false`）。
- 粘贴与保存时自动格式化（`editor.formatOnPaste: true`，`editor.formatOnSave: true`）。

### 源文件编码

- 现有源文件（`Voicevideo.cpp`、`Voicevideo.h`）采用 **UTF-8 with BOM** 编码，注释为中文。
- 新增文件建议保持相同编码与注释语言，以保持一致性。

### 命名与组织

- 当前项目规模极小，所有逻辑集中在 `Voicevideo.cpp`。
- 随着功能增加，建议将不同模块拆分到独立 `.cpp/.h` 文件，并在 `CMakeLists.txt` 的 `add_executable` 中追加源文件。
- 保持头文件使用 `#pragma once` 的习惯（现有 `Voicevideo.h` 已使用）。

## 部署

- 当前项目**没有**安装脚本、打包脚本、CI/CD 配置或容器化文件。
- 发布时需要注意：
  - vcpkg 依赖的 DLL（如 `libcurl`、`zlib`、`sodium` 等）需要随可执行文件一起分发，或静态链接。
  - Windows 目标系统需存在 WebView2 运行时（现代 Windows 11 通常已内置，旧版可安装 Microsoft Edge WebView2 Runtime）。
- macOS 目标系统需存在 WebKit 框架（系统自带）。

## 安全注意事项

- `libsodium` 与 `sodium_init()` 是加密相关代码的基础；任何加密逻辑都应在使用前调用 `sodium_init()` 并检查返回值。
- `curl` 用于网络通信时，生产环境应验证 TLS 证书，避免禁用 SSL 验证。
- 避免在源码或配置中硬编码密钥、密码或令牌。
- `CMakeUserPresets.json` 包含硬编码的本地路径（`C:\Users\86187\vcpkg`），通常不应提交到公共仓库；本项目已存在该文件，修改时请注意不要泄露敏感路径。

## 给 AI 助手的快速检查清单

- 修改 CMake 配置后，重新运行 `cmake --preset default`。
- 新增 vcpkg 依赖后，更新 `vcpkg.json` 并重新配置构建。
- 不要删除 `CMakeUserPresets.json` 中的 `VCPKG_ROOT` 除非用户明确使用环境变量替代。
- 新增源文件时记得同时更新 `add_executable`。
- 当前无测试，编写新逻辑后建议通过运行 `Voicevideo.exe` 进行手动验证。
