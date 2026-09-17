# Start StudioCall. Run from a normal (non-elevated) PowerShell 7.
#
#   ./start.ps1        the shareable shape: build the UI once, serve it from the server on :4019
#   ./start.ps1 -Dev   hot reload: tsx watch + the Vite dev server on :5220
#
# An online process is left alone: restarting studiocall-audio drops the room's audio.
param([switch]$Dev)

# Electron must not inherit ELECTRON_RUN_AS_NODE (VS Code sets it) or it boots as
# plain Node and dies with `app` undefined.
$env:ELECTRON_RUN_AS_NODE = $null
$env:STUDIOCALL_DEV = if ($Dev) { '1' } else { '0' }

Set-Location $PSScriptRoot

foreach ($dir in @('.', 'server', 'client')) {
    if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
        Write-Host "[studiocall] npm install in $dir ..."
        Push-Location $dir; npm install --no-audit --no-fund; Pop-Location
    }
}

# First run: a .env with a fresh encryption key for the stored Clubhouse session.
if (-not (Test-Path '.env')) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $key = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    (Get-Content '.env.example') -replace '^KMS_MASTER_KEY=.*$', "KMS_MASTER_KEY=$key" | Set-Content '.env'
    Write-Host "[studiocall] wrote .env with a new KMS_MASTER_KEY"
}

if (-not $Dev -and -not (Test-Path 'client/dist/index.html')) {
    Write-Host "[studiocall] building the UI ..."
    Push-Location client; npm run build; Pop-Location
}

$apps = @('studiocall-audio', 'studiocall-server')
if ($Dev) { $apps += 'studiocall-client' }

foreach ($name in $apps) {
    $status = (npx --yes pm2 describe $name 2>$null | Select-String "│ status" | Select-Object -First 1)
    if ($status -match 'online') {
        Write-Host "[$name] online"
    } elseif ($status) {
        Write-Host "[$name] registered but not online — restarting"
        npx pm2 restart $name --update-env
    } else {
        Write-Host "[$name] starting"
        npx pm2 start ecosystem.config.cjs --only $name
    }
}

$ui = if ($Dev) { 'https://localhost:5220/studiocall/' } else { 'http://127.0.0.1:4019/studiocall/' }
Write-Host "`nStudioCall: $ui"
