#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only check: is the verification instance worth driving?
#>
param(
  [string]$SkillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
$runFile = Join-Path $SkillRoot 'run\current.json'
if (-not (Test-Path $runFile)) {
  Write-Error 'doctor: run/current.json missing — launch first'
  exit 1
}

$state = Get-Content $runFile -Raw | ConvertFrom-Json
$base = $state.baseUrl
$failures = @()

function Test-PidAlive([int]$ProcessId) {
  try { $null = Get-Process -Id $ProcessId -ErrorAction Stop; return $true } catch { return $false }
}

if (-not (Test-PidAlive ([int]$state.apiPid))) { $failures += "apiPid $($state.apiPid) not alive" }
if (-not (Test-PidAlive ([int]$state.webPid))) { $failures += "webPid $($state.webPid) not alive" }

try {
  $health = Invoke-WebRequest -Uri "$base/api/health" -UseBasicParsing -TimeoutSec 5
  $body = $health.Content
  if ($health.StatusCode -ne 200) { $failures += "health status $($health.StatusCode)" }
  if ($body -notmatch '"ok"\s*:\s*true') { $failures += 'health ok!=true' }
  if ($body -notmatch 'bible-editor-api') { $failures += 'health service name mismatch' }
  Write-Host "[doctor] health=$body"
} catch {
  $failures += "health request failed: $($_.Exception.Message)"
}

$session = $null
try {
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $mint = Invoke-WebRequest -Uri "$base/api/auth/dev" -Method POST `
    -WebSession $session -ContentType 'application/json' `
    -Body '{"username":"verify"}' -UseBasicParsing -TimeoutSec 10
  if ($mint.StatusCode -ne 200) { $failures += "auth/dev status $($mint.StatusCode)" }
  Write-Host "[doctor] auth/dev=$($mint.StatusCode) $($mint.Content.Substring(0, [Math]::Min(120, $mint.Content.Length)))..."
} catch {
  $failures += "auth/dev failed: $($_.Exception.Message)"
}

try {
  $chap = Invoke-WebRequest -Uri "$base/api/chapters/ZEC/1" -WebSession $session `
    -UseBasicParsing -TimeoutSec 15
  if ($chap.StatusCode -ne 200) { $failures += "chapters/ZEC/1 status $($chap.StatusCode)" }
  $json = $chap.Content | ConvertFrom-Json
  $tnCount = @($json.tn).Count
  if ($tnCount -lt 1) { $failures += 'ZEC/1 has no tn rows — seed missing?' }
  Write-Host "[doctor] ZEC/1 tn_rows=$tnCount"
} catch {
  $failures += "chapters/ZEC/1 failed: $($_.Exception.Message)"
}

if ($failures.Count -gt 0) {
  Write-Host '[doctor] FAIL'
  $failures | ForEach-Object { Write-Host " - $_" }
  exit 1
}

Write-Host "[doctor] OK baseUrl=$base runId=$($state.runId)"
exit 0
