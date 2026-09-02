# Install dependencies for a fresh worktree so it is fully self-contained.
# Run from the worktree root after `git worktree add`. Idempotent.
#
# WHY A REAL INSTALL (not junctions): earlier versions junctioned node_modules
# from the main checkout to skip `npm install`. That was a Windows footgun --
# a recursive delete of a worktree (rm -rf / Remove-Item -Recurse / git
# worktree remove --force) FOLLOWS the junction and wipes MAIN's node_modules,
# and via npm's node_modules/@bible-editor workspace links, MAIN's web/ and
# api/ SOURCE too. That wiped the main checkout repeatedly. A real per-worktree
# install carries no path back into main, so a worktree delete can only ever
# touch its own files. Cost is ~314 MB/worktree; the shared npm cache makes the
# install a fast local unpack, not a network download.
#
# Teardown: use scripts/worktree-cleanup.ps1 (it unlinks any leftover junctions
# before deleting). Never `rm -rf` / `Remove-Item -Recurse` a worktree by hand.

$ErrorActionPreference = "Stop"

$gitCommon = (git rev-parse --git-common-dir).Trim()
$mainRoot  = (Resolve-Path (Join-Path $gitCommon "..")).Path
$worktreeRoot = (Get-Location).Path

if ($mainRoot -eq $worktreeRoot) {
    Write-Host "Already in the main checkout - nothing to init."
    exit 0
}

# If a previous (junction-based) init left node_modules junctions pointing at
# main, unlink them (link only, never the target) before installing real deps.
$legacy = @("node_modules", "web\node_modules", "api\node_modules")
foreach ($t in $legacy) {
    $p = Join-Path $worktreeRoot $t
    if (Test-Path $p) {
        $item = Get-Item $p -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            [System.IO.Directory]::Delete($p, $false)   # unlink only
            Write-Host "unlinked legacy junction: $t"
        }
    }
}

# api/.dev.vars (JWT_SIGNING_KEY, etc.) is gitignored, so a fresh worktree has
# none and every e2e spec fails jwt_signing_key_not_configured until one
# exists. Copy the main checkout's real file when there is one -- same signing
# key means a token minted against one checkout still verifies in the other.
# Falls back to the committed .example (a dev-only placeholder key, fine for
# local wrangler dev / test:e2e) so a cold worktree still boots even when main
# hasn't been provisioned either. Runs on every invocation (idempotent - never
# overwrites an existing api\.dev.vars), not just on a fresh install, so it
# still fires when node_modules already exists below.
$devVarsRel = "api\.dev.vars"
$devVarsDest = Join-Path $worktreeRoot $devVarsRel
if (-not (Test-Path $devVarsDest)) {
    $devVarsSrc = Join-Path $mainRoot $devVarsRel
    if (Test-Path $devVarsSrc) {
        Copy-Item $devVarsSrc $devVarsDest
        Write-Host "copied api\.dev.vars from main checkout"
    } else {
        $exampleSrc = Join-Path $worktreeRoot "api\.dev.vars.example"
        if (Test-Path $exampleSrc) {
            Copy-Item $exampleSrc $devVarsDest
            Write-Host "main checkout has no api\.dev.vars either - seeded from api\.dev.vars.example (dev-only placeholder key)"
        }
    }
}

if (Test-Path (Join-Path $worktreeRoot "node_modules")) {
    Write-Host "node_modules already present (real install) - skipping. Delete it to force a reinstall."
    exit 0
}

Write-Host "Installing dependencies (npm install) in $worktreeRoot ..."
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
Write-Host "Worktree ready - self-contained node_modules, no junction to main."
