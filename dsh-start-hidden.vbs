' 无窗口运行 dsh-start.bat，供「登录时自启」的计划任务调用。
' 如果直接在计划任务里调 .bat，会弹出控制台窗口；用 WScript 包一层可以完全静默，
' 而 dsh-start.bat 自己会用 start 开出它需要的两个可见窗口（SnowLuma / qq-bridge）。
Option Explicit

Dim shell, fso, root, target
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
target = root & "\dsh-start.bat"

If Not fso.FileExists(target) Then
  ' 静默失败：自启场景没有交互界面，弹窗只会打扰用户
  WScript.Quit 1
End If

' 0 = 隐藏本包装脚本自己的窗口；False = 不等待返回
shell.Run """" & target & """", 0, False
