$ErrorActionPreference = 'Stop'
$petData = Join-Path $env:APPDATA 'chibi-desktop-pet/remote-chat'
$petTool = Join-Path $PSScriptRoot 'tools/cloudflared.exe'
$petState = Join-Path $petData 'tunnel.json'
if (Test-Path -LiteralPath $petState) {
    $petExisting = Get-Content -LiteralPath $petState -Raw | ConvertFrom-Json
    $petProcess = Get-Process -Id $petExisting.pid -ErrorAction SilentlyContinue
    if ($petProcess -and $petProcess.Path -eq $petTool -and $petProcess.StartTime.ToUniversalTime().ToString('o') -eq $petExisting.started) { Stop-Process -Id $petProcess.Id }
    Remove-Item -LiteralPath $petState
}
ConvertTo-Json -InputObject @() -Compress | Set-Content -LiteralPath (Join-Path $petData 'origins.json') -Encoding utf8
Write-Output 'Remote access is disabled. Local desktop pet remains running.'
