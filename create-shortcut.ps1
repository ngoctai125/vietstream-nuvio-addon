$ws = New-Object -ComObject WScript.Shell
$p = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\VietStream Addon.lnk'
$s = $ws.CreateShortcut($p)
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"E:\AI\5_TAM\_scratch\vietstream\start-addon-hidden.vbs"'
$s.WorkingDirectory = 'E:\AI\5_TAM\_scratch\vietstream'
$s.Save()
Write-Output $p
Test-Path $p
