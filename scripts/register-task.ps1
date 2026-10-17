# Registers a Windows Task Scheduler task that starts the bot (plain node, no hot reload) when the current user logs on.
# Runs hidden as the current user (no admin needed); output is appended to data/bot.log.
# Usage: npm run register [-- -StartNow] [-- -TaskName <name>]
param(
  [string]$TaskName = 'SlackCommandRunner',
  [switch]$StartNow
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Không tìm thấy node.exe trong PATH. Cài Node.js >= 24 trước.' }
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data') | Out-Null

$user = "$env:USERDOMAIN\$env:USERNAME"
# Hidden PowerShell wrapper: run from the repo root (so .env and ./data resolve) with this node first on PATH.
# cmd's redirection appends node's output byte-for-byte (UTF-8); PowerShell 5.1's *>> would re-encode it as UTF-16.
$nodeDir = Split-Path -Parent $node
$command = "`$env:Path = '$nodeDir;' + `$env:Path; Set-Location -LiteralPath '$root'; cmd /c 'node src/index.ts >> data\bot.log 2>&1'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -Command `"$command`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Slack Command Runner bot (slack-bot repo). Managed by npm run register / unregister.' -Force | Out-Null

Write-Host "Đã đăng ký task '$TaskName': chạy bot khi $user đăng nhập Windows."
Write-Host "  Thư mục: $root"
Write-Host "  Log:     $(Join-Path $root 'data\bot.log')"
if ($StartNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Đã khởi động task ngay bây giờ."
} else {
  Write-Host "Chạy ngay: npm run register -- -StartNow  (hoặc Start-ScheduledTask -TaskName $TaskName)"
}
Write-Host "Gỡ bỏ:   npm run unregister"
