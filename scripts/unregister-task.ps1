# Removes the Task Scheduler task created by register-task.ps1 (and its folder once empty) and stops the bot it started.
# Usage: npm run unregister
param(
  [string]$TaskPath = '\SlackBot\',
  [string]$TaskName = 'SlackCommandRunner'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$removed = $false
# Also clean up the library-root task created by earlier versions.
foreach ($path in @($TaskPath, '\')) {
  if (Get-ScheduledTask -TaskPath $path -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskPath $path -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskPath $path -TaskName $TaskName -Confirm:$false
    Write-Host "Đã gỡ task '$path$TaskName'."
    $removed = $true
  }
}
if (-not $removed) { Write-Host "Task '$TaskPath$TaskName' chưa được đăng ký." }

# Task Scheduler keeps empty folders; delete ours when nothing else is in it.
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folderName = $TaskPath.Trim('\')
try {
  $folder = $service.GetFolder($TaskPath.TrimEnd('\'))
  if ($folder.GetTasks(1).Count -eq 0 -and $folder.GetFolders(0).Count -eq 0) {
    $service.GetFolder('\').DeleteFolder($folderName, 0)
    Write-Host "Đã xoá folder '$folderName' trong Task Scheduler Library."
  }
} catch {
  # Folder does not exist.
}

# Stopping the task ends the wscript launcher, but its node child can survive: stop the bot that holds the lock,
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
