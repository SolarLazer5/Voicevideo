# 部署抖音 MCP 发布服务（Node.js + Playwright 版）
# 前置要求：已安装 Node.js LTS（https://nodejs.org）和 Git

$ErrorActionPreference = "Stop"

$repoUrl = "https://github.com/flyerhzm/douyin-mcp.git"
$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path (Join-Path $projectRoot "localdep") "douyin-mcp"
$patchFile = Join-Path $PSScriptRoot "douyin-mcp-qrcode.patch"

# 备份已有的 cookies.json，避免重新部署后需要重新扫码
$cookieBackup = $null
try {
    $tempDir = [System.IO.Path]::GetTempPath()
    if ($tempDir) {
        $cookieBackup = Join-Path $tempDir "douyin-mcp-cookies-backup.json"
    }
} catch { }

$existingCookie = Join-Path $targetDir "cookies.json"
if ($cookieBackup -and (Test-Path $existingCookie)) {
    try {
        Copy-Item $existingCookie $cookieBackup -Force
        Write-Host "已备份现有 cookies.json"
    } catch {
        Write-Warning "备份 cookies.json 失败: $_"
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

# 还原 cookies.json
if ($cookieBackup -and (Test-Path $cookieBackup)) {
    try {
        Copy-Item $cookieBackup (Join-Path $targetDir "cookies.json") -Force
        Remove-Item $cookieBackup -Force
        Write-Host "已还原 cookies.json"
    } catch {
        Write-Warning "还原 cookies.json 失败: $_"
    }
}

# 应用 QR 接口补丁，使二维码以 base64 图片返回
if (Test-Path $patchFile) {
    Write-Host "正在应用 QR 补丁..."
    git -C $targetDir apply $patchFile
    if ($LASTEXITCODE -ne 0) {
        throw "补丁应用失败，请检查仓库版本是否与补丁匹配"
    }
}

# 安装 npm 依赖
Set-Location $targetDir
Write-Host "正在安装 npm 依赖..."
npm install

# 安装 Playwright Chromium
Write-Host "正在安装 Playwright Chromium（首次约 150MB）..."
npx playwright install chromium

Write-Host ""
Write-Host "抖音 MCP 服务已部署到: $targetDir" -ForegroundColor Green
Write-Host "启动命令: cd '$targetDir'; npm start" -ForegroundColor Green
Write-Host "服务默认监听: http://localhost:18062" -ForegroundColor Green
