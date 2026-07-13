
# 部署快手 MCP 发布服务（基于 social-auto-upload + FastAPI）
# 前置要求：已安装 Git

$ErrorActionPreference = "Stop"

$repoUrl = "https://github.com/dreammis/social-auto-upload.git"
$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path (Join-Path $projectRoot "localdep") "social-auto-upload"
$serviceSource = Join-Path $PSScriptRoot "kuaishou_mcp_service.py"

# 查找 embedded Python
$embeddedPython = Join-Path (Join-Path (Join-Path $projectRoot "localdep") "python") "python.exe"
if (-not (Test-Path $embeddedPython)) {
    throw "未找到 embedded Python: $embeddedPython，请先完成 localdep/python 部署"
}

# 备份已有的 cookie，避免重新部署后需要重新扫码
$cookieBackup = Join-Path ([System.IO.Path]::GetTempPath()) "kuaishou-mcp-cookies-backup.json"
$existingCookie = Join-Path (Join-Path $targetDir "cookies") "kuaishou.json"
if (Test-Path $existingCookie) {
    try {
        Copy-Item $existingCookie $cookieBackup -Force
        Write-Host "已备份现有 cookies/kuaishou.json"
    } catch {
        Write-Warning "备份 cookie 失败: $_"
    }
}

# 清理旧目录（若存在）
if (Test-Path $targetDir) {
    Write-Host "发现旧目录，正在清理: $targetDir"
    Remove-Item $targetDir -Recurse -Force
}

# 克隆仓库
Write-Host "正在克隆 $repoUrl ..."
git clone $repoUrl $targetDir
if ($LASTEXITCODE -ne 0) {
    throw "git clone 失败，请检查网络和 Git 安装"
}

# 还原 cookie
if (Test-Path $cookieBackup) {
    try {
        $cookieDir = Join-Path $targetDir "cookies"
        if (-not (Test-Path $cookieDir)) { New-Item -ItemType Directory -Path $cookieDir -Force | Out-Null }
        Copy-Item $cookieBackup (Join-Path $cookieDir "kuaishou.json") -Force
        Remove-Item $cookieBackup -Force
        Write-Host "已还原 cookies/kuaishou.json"
    } catch {
        Write-Warning "还原 cookie 失败: $_"
    }
}

# 创建 Python 虚拟环境
$venvDir = Join-Path $targetDir ".venv"
Write-Host "正在创建 Python 虚拟环境..."
& $embeddedPython -m venv $venvDir
if ($LASTEXITCODE -ne 0) {
    throw "创建 venv 失败"
}

$venvPython = Join-Path (Join-Path $venvDir "Scripts") "python.exe"
$venvPip = Join-Path (Join-Path $venvDir "Scripts") "pip.exe"

# 升级 pip
Write-Host "正在升级 pip..."
& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) {
    Write-Warning "升级 pip 失败，继续尝试安装"
}

# 安装 social-auto-upload 及其依赖
Write-Host "正在安装 social-auto-upload 依赖..."
& $venvPip install -e $targetDir
if ($LASTEXITCODE -ne 0) {
    throw "安装 social-auto-upload 失败"
}

# 安装 FastAPI / uvicorn
Write-Host "正在安装 FastAPI / uvicorn..."
& $venvPip install fastapi uvicorn
if ($LASTEXITCODE -ne 0) {
    throw "安装 FastAPI 失败"
}

# 安装 patchright Chromium（国内镜像）
Write-Host "正在安装 patchright Chromium（首次约 150MB）..."
$env:PLAYWRIGHT_DOWNLOAD_HOST = "https://npmmirror.com/mirrors/playwright"
& $venvPython -m patchright install chromium
if ($LASTEXITCODE -ne 0) {
    throw "安装 patchright Chromium 失败"
}

# 复制服务脚本
if (Test-Path $serviceSource) {
    Copy-Item $serviceSource (Join-Path $targetDir "kuaishou_mcp_service.py") -Force
    Write-Host "已复制 kuaishou_mcp_service.py"
} else {
    Write-Warning "未找到服务脚本模板: $serviceSource"
}

# 创建 conf.py
$confPath = Join-Path $targetDir "conf.py"
$confContent = @"
from pathlib import Path

# social-auto-upload 配置文件（由 Voicevideo 自动生成）
BASE_DIR = Path(__file__).parent.resolve()
XHS_SERVER = "http://127.0.0.1:11901"
# 如需指定本地 Chrome 路径，请取消下一行注释并修改
# LOCAL_CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
LOCAL_CHROME_PATH = ""
LOCAL_CHROME_HEADLESS = True
DEBUG_MODE = False
YT_PROXY = None
"@
Set-Content -Path $confPath -Value $confContent -Encoding UTF8
Write-Host "已创建 conf.py"

# 创建 cookies 目录
$cookieDir = Join-Path $targetDir "cookies"
New-Item -ItemType Directory -Path $cookieDir -Force | Out-Null

Write-Host ""
Write-Host "快手 MCP 服务已部署到: $targetDir" -ForegroundColor Green
Write-Host "启动命令: cd '$targetDir'; .\.venv\Scripts\python.exe kuaishou_mcp_service.py" -ForegroundColor Green
Write-Host "服务默认监听: http://localhost:18063" -ForegroundColor Green
