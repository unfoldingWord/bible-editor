#Requires -Version 5.1
<#
.SYNOPSIS
  Start an isolated bible-editor Vite+Wrangler pair for verification.
.PARAMETER WebPort
  Vite port (default 5174 — avoids Windows svchost on 5173).
.PARAMETER ApiPort
  Wrangler port (default 8788).
#>
param(
  [int]$WebPort = 5174,
  [int]$ApiPort = 8788,
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
)

$ErrorActionPreference = 'Stop'
$skillRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$runDir = Join-Path $skillRoot 'run'
$artifactsRoot = Join-Path $skillRoot 'artifacts'
New-Item -ItemType Directory -Force -Path $runDir, $artifactsRoot | Out-Null

$existing = Join-Path $runDir 'current.json'
if (Test-Path $existing) {
  throw "run/current.json already exists. Run cleanup.ps1 before launching again."
}

function Test-PortFree([int]$Port) {
  -not [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

if (-not (Test-PortFree $WebPort)) {
  throw "WebPort $WebPort is already listening. Choose another -WebPort or free it."
}
if (-not (Test-PortFree $ApiPort)) {
  throw "ApiPort $ApiPort is already listening. Choose another -ApiPort or free it."
}

if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
  Write-Host '[launch] npm install (repo root)...'
  Push-Location $RepoRoot
  try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

Write-Host '[launch] local D1 migrations...'
Push-Location (Join-Path $RepoRoot 'api')
try {
  npx wrangler d1 migrations apply bible_editor_dev --local
  if ($LASTEXITCODE -ne 0) { throw "migrations apply failed ($LASTEXITCODE)" }
} finally {
  Pop-Location
}

& (Join-Path $PSScriptRoot 'seed-zec.ps1') -RepoRoot $RepoRoot

$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$baseUrl = "http://127.0.0.1:$WebPort"
$apiLog = Join-Path $runDir "api-$runId.log"
$webLog = Join-Path $runDir "web-$runId.log"

$apiErr = Join-Path $runDir "api-$runId.err.log"
$webErr = Join-Path $runDir "web-$runId.err.log"

Write-Host "[launch] starting wrangler on port $ApiPort"
$apiCmd = "npx wrangler dev --port $ApiPort --ip 127.0.0.1"
$api = Start-Process -FilePath 'cmd.exe' `
  -ArgumentList @('/c', $apiCmd) `
  -WorkingDirectory (Join-Path $RepoRoot 'api') `
  -RedirectStandardOutput $apiLog `
  -RedirectStandardError $apiErr `
  -PassThru `
  -NoNewWindow

# Give wrangler a head start before Vite proxies to it.
Start-Sleep -Seconds 3

Write-Host "[launch] starting vite on $WebPort (proxy -> 127.0.0.1:$ApiPort)"
$webCmd = "set VITE_API_PROXY=http://127.0.0.1:$ApiPort&& npx vite --port $WebPort --strictPort --host 127.0.0.1"
$web = Start-Process -FilePath 'cmd.exe' `
  -ArgumentList @('/c', $webCmd) `
  -WorkingDirectory (Join-Path $RepoRoot 'web') `
  -RedirectStandardOutput $webLog `
  -RedirectStandardError $webErr `
  -PassThru `
  -NoNewWindow

$state = [ordered]@{
  runId     = $runId
  baseUrl   = $baseUrl
  webPort   = $WebPort
  apiPort   = $ApiPort
  apiPid    = $api.Id
  webPid    = $web.Id
  repoRoot  = $RepoRoot
  startedAt = (Get-Date).ToString('o')
  apiLog    = $apiLog
  webLog    = $webLog
  apiErrLog = $apiErr
  webErrLog = $webErr
}
$state | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $runDir 'current.json')

$deadline = (Get-Date).AddMinutes(3)
$ready = $false
while ((Get-Date) -lt $deadline) {
  if ($api.HasExited) { throw "wrangler exited early. See $apiLog" }
  if ($web.HasExited) { throw "vite exited early. See $webLog" }
  try {
    $r = Invoke-WebRequest -Uri "$baseUrl/api/health" -UseBasicParsing -TimeoutSec 2
    if ($r.StatusCode -eq 200 -and $r.Content -match 'bible-editor-api') {
      $ready = $true
      break
    }
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

if (-not $ready) {
  & (Join-Path $PSScriptRoot 'cleanup.ps1')
  throw "Timed out waiting for $baseUrl/api/health. See $apiLog and $webLog"
}

Write-Host "[launch] ready BASE_URL=$baseUrl RUN_ID=$runId"
Write-Host "BASE_URL=$baseUrl"
Write-Host "RUN_ID=$runId"
