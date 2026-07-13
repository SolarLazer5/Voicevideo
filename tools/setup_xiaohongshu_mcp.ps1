
# 部署小红书 MCP 发布服务
# 从 xpzouying/xiaohongshu-mcp GitHub Releases 下载 Windows 预编译二进制
# 前置要求：能访问 GitHub（如网络不畅请手动下载后放到目标目录）

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path (Join-Path $projectRoot "localdep") "xiaohongshu-mcp"
$zipFile = Join-Path $targetDir "xiaohongshu-mcp-windows-amd64.zip"
$assetName = "xiaohongshu-mcp-windows-amd64.zip"

# 多个下载源：直接 GitHub + 常见代理镜像（顺序尝试）
$urls = @(
    "https://github.com/xpzouying/xiaohongshu-mcp/releases/latest/download/$assetName",
    "https://gh.api.99988866.xyz/https://github.com/xpzouying/xiaohongshu-mcp/releases/latest/download/$assetName",
    "https://gh.h233.eu.org/https://github.com/xpzouying/xiaohongshu-mcp/releases/latest/download/$assetName",
    "https://ghproxy.net/https://github.com/xpzouying/xiaohongshu-mcp/releases/latest/download/$assetName"
)

Write-Host "目标目录: $targetDir"

# 创建目标目录
if (-not (Test-Path $targetDir)) {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
}

# 如果两个 exe 都已存在，跳过下载
$expectedBinary = Join-Path $targetDir "xiaohongshu-mcp-windows-amd64.exe"
$loginTool = Join-Path $targetDir "xiaohongshu-login-windows-amd64.exe"
if ((Test-Path $expectedBinary) -and (Test-Path $loginTool)) {
    Write-Host "发现已存在的小红书 MCP 二进制，跳过下载。"
    # 确保 data 目录存在
    $dataDir = Join-Path $targetDir "data"
    if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    Write-Host "服务二进制: $expectedBinary"
    Write-Host "登录工具: $loginTool"
    Write-Host "`n首次使用请运行登录工具扫码："
    Write-Host "   $loginTool"
    return
}

# 备份已有的 cookie（如果存在）
$cookieBackup = Join-Path ([System.IO.Path]::GetTempPath()) "xiaohongshu-mcp-cookies-backup.json"
$existingCookie = Join-Path $targetDir "cookies.json"
if (Test-Path $existingCookie) {
    try {
        Copy-Item $existingCookie $cookieBackup -Force
        Write-Host "已备份现有 cookies.json"
    } catch {
        Write-Warning "备份 cookie 失败: $_"
    }
}

function Download-File($url, $outPath) {
    Write-Host "尝试下载: $url"
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & curl.exe -L --max-time 120 -o $outPath $url 2>&1
        return ($LASTEXITCODE -eq 0)
    } else {
        try {
            $client = New-Object System.Net.WebClient
            $client.DownloadFile($url, $outPath)
            return $true
        } catch {
            Write-Warning $_.Exception.Message
            return $false
        }
    }
}

# 顺序尝试下载
$downloaded = $false
foreach ($url in $urls) {
    if (Download-File $url $zipFile) {
        if ((Test-Path $zipFile) -and (Get-Item $zipFile).Length -gt 1000) {
            $downloaded = $true
            Write-Host "下载成功"
            break
        }
    }
    Write-Warning "该镜像下载失败，尝试下一个..."
}

if (-not $downloaded) {
    $manualUrls = ($urls | ForEach-Object { "  $_" }) -join "`n"
    throw @"
自动下载小红书 MCP 二进制失败，通常是因为当前网络无法访问 GitHub。
请按以下任一手动方式解决：

方式 1：浏览器手动下载
1. 访问 https://github.com/xpzouying/xiaohongshu-mcp/releases/latest
2. 下载 $assetName
3. 解压到目录：$targetDir
4. 确认存在文件：$targetDir\xiaohongshu-mcp-windows-amd64.exe

方式 2：使用代理/VPN 后重新运行本脚本
powershell -ExecutionPolicy Bypass -File tools\setup_xiaohongshu_mcp.ps1

方式 3：尝试以下镜像链接（复制到浏览器或下载工具）：
$manualUrls
"@
}

# 解压
Write-Host "正在解压..."
Expand-Archive -Path $zipFile -DestinationPath $targetDir -Force

# 还原 cookie
if (Test-Path $cookieBackup) {
    try {
        Copy-Item $cookieBackup $existingCookie -Force
        Remove-Item $cookieBackup -Force
        Write-Host "已还原 cookies.json"
    } catch {
        Write-Warning "还原 cookie 失败: $_"
    }
}

# 清理 zip
Remove-Item $zipFile -Force -ErrorAction SilentlyContinue

# 检查二进制
$expectedBinary = Join-Path $targetDir "xiaohongshu-mcp-windows-amd64.exe"
$loginTool = Join-Path $targetDir "xiaohongshu-login-windows-amd64.exe"
if (Test-Path $expectedBinary) {
    Write-Host "部署成功: $expectedBinary"
} else {
    Write-Warning "未找到预期文件 $expectedBinary，请检查解压结果"
}
if (Test-Path $loginTool) {
    Write-Host "登录工具: $loginTool"
}

Write-Host "`n使用说明："
Write-Host "1. 首次使用请运行登录工具扫码获取 cookie："
Write-Host "   $loginTool"
Write-Host "2. 然后启动 MCP 服务："
Write-Host "   $expectedBinary -port :18060"
Write-Host "3. Voicevideo 会自动检测并启动该服务，无需手动长期保持窗口。"
