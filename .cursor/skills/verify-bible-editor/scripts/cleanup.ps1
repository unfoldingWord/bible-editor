#Requires -Version 5.1
<#
.SYNOPSIS
  Stop only the verification processes recorded in run/current.json.
  Leaves artifacts/ untouched.
#>
param(
  [string]$SkillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Continue'
$runFile = Join-Path $SkillRoot 'run\current.json'
if (-not (Test-Path $runFile)) {
  Write-Host '[cleanup] no run/current.json — nothing to stop'
  exit 0
}

$state = Get-Content $runFile -Raw | ConvertFrom-Json
foreach ($processId in @([int]$state.webPid, [int]$state.apiPid)) {
  if ($processId -le 0) { continue }
  try {
    $p = Get-Process -Id $processId -ErrorAction Stop
    Write-Host "[cleanup] stopping pid=$processId ($($p.ProcessName))"
    # Kill process tree (cmd → npx → node)
    & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
  } catch {
    Write-Host "[cleanup] pid=$processId already gone"
  }
}

Remove-Item -Force $runFile -ErrorAction SilentlyContinue
Write-Host '[cleanup] removed run/current.json; artifacts preserved'
exit 0
