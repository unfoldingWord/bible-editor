# Junction node_modules from the main checkout into this worktree so a fresh
# worktree skips a full `npm install`. Run from the worktree root after
# `git worktree add`. Idempotent.
#
# Trade-off: junctions point at main's node_modules. If this branch bumps a
# dependency, delete the junction(s) and run `npm install` in the worktree so
# changes don't leak back into main.

$ErrorActionPreference = "Stop"

$gitCommon = (git rev-parse --git-common-dir).Trim()
$mainRoot = (Resolve-Path (Join-Path $gitCommon "..")).Path
$worktreeRoot = (Get-Location).Path

if ($mainRoot -eq $worktreeRoot) {
    Write-Host "Already in the main checkout - nothing to junction."
    exit 0
}

$targets = @("node_modules", "web\node_modules", "api\node_modules")

foreach ($t in $targets) {
    $src = Join-Path $mainRoot $t
    $dst = Join-Path $worktreeRoot $t

    if (-not (Test-Path $src)) {
        Write-Host "skip $t -- main has none (run 'npm install' in main first)"
        continue
    }
    if (Test-Path $dst) {
        Write-Host "skip $t -- already present"
        continue
    }
    New-Item -ItemType Junction -Path $dst -Target $src | Out-Null
    Write-Host "junction: $t -> $src"
}
