# Registers the bot in Windows Task Scheduler, in its own folder (Task Scheduler Library\SlackBot), so it starts
# (plain node, no hot reload) when the current user logs on. Runs hidden through scripts\run-bot.vbs as the current
# user (no admin needed); output is appended to data\bot.log.
# Usage: npm run register [-- -StartNow]
param(
  [string]$TaskPath = '\SlackBot\',
  [string]$TaskName = 'SlackCommandRunner',
  [switch]$StartNow
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe was not found in PATH. Install Node.js >= 24 first.' }
$launcher = Join-Path $PSScriptRoot 'run-bot.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

# Earlier versions registered the task in the library root; move it into the folder.
if (Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskPath '\' -TaskName $TaskName -Confirm:$false
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $wscript -Argument "`"$launcher`" `"$node`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

# Register-ScheduledTask creates the folder when it does not exist yet.
Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName `
  -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description "Slack Command Runner bot ($root). Managed by npm run register / unregister." -Force | Out-Null

Write-Host "Registered task '$TaskPath$TaskName' (Task Scheduler Library > $($TaskPath.Trim('\'))): starts the bot when $user signs in to Windows."
Write-Host "  Folder: $root"
Write-Host "  Log:     $(Join-Path $root 'data\bot.log')"
if ($StartNow) {
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
  Write-Host 'Task started now.'
} else {
  Write-Host 'Start now: npm run register -- -StartNow'
}
Write-Host 'Remove:    npm run unregister'
