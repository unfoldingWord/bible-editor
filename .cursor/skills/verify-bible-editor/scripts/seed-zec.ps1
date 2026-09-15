#Requires -Version 5.1
<#
.SYNOPSIS
  Generate import-ZEC.sql if needed and apply it to local bible_editor_dev D1.
#>
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
)

$ErrorActionPreference = 'Stop'
$sqlPath = Join-Path $RepoRoot 'scripts\out\import-ZEC.sql'

if (-not (Test-Path $sqlPath)) {
  Write-Host '[seed-zec] generating scripts/out/import-ZEC.sql...'
  Push-Location $RepoRoot
  try {
    node scripts/import-book.mjs ZEC
    if ($LASTEXITCODE -ne 0) { throw "import-book.mjs ZEC failed ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}

Write-Host '[seed-zec] applying to local bible_editor_dev...'
Push-Location (Join-Path $RepoRoot 'api')
try {
  npx wrangler d1 execute bible_editor_dev --local --file=$sqlPath
  if ($LASTEXITCODE -ne 0) {
    throw "wrangler d1 execute failed ($LASTEXITCODE). Try: npm --workspace api run db:migrate:local"
  }
} finally {
  Pop-Location
}

Write-Host '[seed-zec] done'
