param([switch] $NoBrowser)
$ErrorActionPreference = 'Stop'
$petRoot = Split-Path -Parent $PSScriptRoot
$petData = Join-Path $env:APPDATA 'chibi-desktop-pet/remote-chat'
$petTool = Join-Path $PSScriptRoot 'tools/cloudflared.exe'
$petState = Join-Path $petData 'tunnel.json'
$petLog = Join-Path $petData 'tunnel.log'
New-Item -ItemType Directory -Path $petData -Force | Out-Null
if (-not (Test-Path -LiteralPath $petTool)) { throw 'Missing remote-chat/tools/cloudflared.exe' }
function Wait-PetPublicUrl([string] $Url) {
    for ($petCheck = 0; $petCheck -lt 12; $petCheck++) {
        try {
            $petPublicResponse = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
            if ($petPublicResponse.StatusCode -eq 200) { return $true }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    return $false
}
if (-not (Get-Process -Name 'Chibi Desktop Pet' -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath (Join-Path $petRoot 'Chibi Desktop Pet.exe') -WorkingDirectory $petRoot -WindowStyle Hidden
}
$petReady = $false
for ($petAttempt = 0; $petAttempt -lt 30; $petAttempt++) {
    try { $petResponse = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:17861/' -TimeoutSec 2; $petReady = $petResponse.StatusCode -eq 200; if ($petReady) { break } } catch {}
    Start-Sleep -Milliseconds 500
}
if (-not $petReady) { throw 'Remote chat is not running. Restart the patched desktop pet first.' }
$petExisting = $null
if (Test-Path -LiteralPath $petState) {
    $petExisting = Get-Content -LiteralPath $petState -Raw | ConvertFrom-Json
    $petProcess = Get-Process -Id $petExisting.pid -ErrorAction SilentlyContinue
    if ($petProcess -and $petProcess.Path -eq $petTool -and $petProcess.StartTime.ToUniversalTime().ToString('o') -eq $petExisting.started) {
        Write-Output ('Remote chat is already running: ' + $petExisting.url)
        if (Wait-PetPublicUrl $petExisting.url) { if (-not $NoBrowser) { Start-Process -FilePath $petExisting.url } }
        else { Write-Warning 'Public URL is not reachable yet. Check the network and retry shortly.' }
        exit 0
    }
}
ConvertTo-Json -InputObject @() -Compress | Set-Content -LiteralPath (Join-Path $petData 'origins.json') -Encoding utf8
if (Test-Path -LiteralPath $petLog) { Move-Item -LiteralPath $petLog -Destination (Join-Path $petData ('tunnel-' + (Get-Date -Format yyyyMMdd-HHmmss) + '.log')) }
$petTunnel = Start-Process -FilePath $petTool -ArgumentList @('tunnel','--no-autoupdate','--protocol','http2','--url','http://127.0.0.1:17861','--logfile',$petLog) -WorkingDirectory $petRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $petData 'tunnel-stdout.log') -RedirectStandardError (Join-Path $petData 'tunnel-stderr.log')
$petUrl = $null
for ($petAttempt = 0; $petAttempt -lt 90; $petAttempt++) {
    if ($petTunnel.HasExited) { throw ('Tunnel exited. Check logs in ' + $petData) }
    if (Test-Path -LiteralPath $petLog) {
        $petMatch = [regex]::Match((Get-Content -LiteralPath $petLog -Raw), 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($petMatch.Success) { $petUrl = $petMatch.Value; break }
    }
    Start-Sleep -Milliseconds 500
}
if (-not $petUrl) { Stop-Process -Id $petTunnel.Id; throw ('Tunnel startup timed out. Check logs in ' + $petData) }
ConvertTo-Json -InputObject @($petUrl) -Compress | Set-Content -LiteralPath (Join-Path $petData 'origins.json') -Encoding utf8
@{pid=$petTunnel.Id;started=$petTunnel.StartTime.ToUniversalTime().ToString('o');url=$petUrl} | ConvertTo-Json | Set-Content -LiteralPath $petState -Encoding utf8
$petAccess = Join-Path $petRoot '远程聊天地址.txt'
@"
桌宠远程聊天

网页地址：$petUrl
访问口令文件：$petData\访问口令.txt

手机打开网页，输入口令即可聊天。口令请保密。
电脑必须保持开机、联网，桌宠必须运行。
这是临时外网地址；重新启动隧道后地址会变化。
关闭远程访问：双击“关闭远程聊天.bat”。
"@ | Set-Content -LiteralPath $petAccess -Encoding utf8
Write-Output ('Remote chat ready: ' + $petUrl)
Write-Output ('Access instructions: ' + $petAccess)
if (Wait-PetPublicUrl $petUrl) { if (-not $NoBrowser) { Start-Process -FilePath $petUrl } }
else { Write-Warning 'Public URL is not reachable yet. Check the network and retry shortly.' }
