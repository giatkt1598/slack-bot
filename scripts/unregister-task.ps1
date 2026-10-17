# Removes the Task Scheduler task created by register-task.ps1 and stops the bot it started.
# Usage: npm run unregister [-- -TaskName <name>]
param(
  [string]$TaskName = 'SlackCommandRunner'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Đã gỡ task '$TaskName'."
} else {
  Write-Host "Task '$TaskName' chưa được đăng ký."
}

# Stopping the task ends the PowerShell wrapper, but its node child can survive: stop the bot that holds the lock,
# together with any commands it is running. Only a node process running src/index.ts is touched.
$lock = Join-Path $root 'data\slack-bot.lock'
if (Test-Path $lock) {
  $botPid = [int](Get-Content $lock -Raw)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $botPid" -ErrorAction SilentlyContinue
  if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine -match 'src[\\/]index\.ts') {
    taskkill /PID $botPid /T /F | Out-Null
    Write-Host "Đã dừng bot đang chạy (PID $botPid)."
  }
}
