Option Explicit
Dim shell, fso, folder, command, result
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & folder & "\windows-shortcut.ps1" & Chr(34)
result = shell.Run(command, 0, True)
If result <> 0 Then
  MsgBox "Codex could not start. See: " & folder & "\launch-error.log", 16, "Codex Blue"
End If
WScript.Quit result
