' Launcher used by the Task Scheduler task (see register-task.ps1).
' Runs the bot hidden (no console window) from the repo root and appends its output to data\bot.log.
' Usage: wscript.exe run-bot.vbs "<path to node.exe>"
Option Explicit

Dim shell, fso, nodePath, root, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

nodePath = WScript.Arguments(0)
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.CurrentDirectory = root
If Not fso.FolderExists(root & "\data") Then fso.CreateFolder root & "\data"

' cmd's redirection keeps node's UTF-8 output byte-for-byte.
command = "cmd /c """ & Quote(nodePath) & " src\index.ts >> data\bot.log 2>&1"""

' WindowStyle 0 hides the window; True waits, so the task stays "Running" while the bot runs.
WScript.Quit shell.Run(command, 0, True)

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
