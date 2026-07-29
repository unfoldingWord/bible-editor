<#
.SYNOPSIS
  Read-only: show what each worktree of this repo actually CONTAINS.

.WHY
  Worktree directory names lie. Both the folder name and the branch name are
  minted by the Claude Code harness, independently and at different moments, so
  neither is reliably the honest one:

    - folder signout-button-placement-2e2751 held branch
      claude/bible-editor-internal-notes-0d50c2 (PR #374) -- the folder was
      named after the session's FIRST task and never updated.
    - the inverse also happens: folder d1-incomplete-load-a1ac62 (accurate) on
      branch claude/dreamy-jemison-d2eb50 (a random word-pair, meaningless).

  The folder cannot be named correctly at birth: it exists before the branch is
  created. Renaming it later is off the table -- it would break any running dev
  server, editor window, or sibling agent session pinned to that path.

  So instead of trying to make the NAME truthful, this makes the LISTING
  truthful. Each worktree leads with a description of its actual contents,
  sourced in this order:

    1. the H1 of its .claude/state/<name>.md   (a human's own summary)
    2. the title of its open/merged PR         (via gh, optional)
    3. its last commit subject                 (always available)

  Use this instead of `git worktree list` when you want to know which worktree
  is which. For teardown, see worktree-cleanup.ps1 -- this script never writes.

.MODES
  (default)  Human-readable table.
  -Json      Emit JSON (same data) for scripting.
  -NoPr      Skip the `gh` call (faster, or when offline / gh unauthenticated).
#>
[CmdletBinding()]
param(
  [switch]$Json,
  [switch]$NoPr
)

$ErrorActionPreference = 'Stop'
# Never let a native command's nonzero exit throw: `git rev-list` and
# `gh` legitimately exit nonzero here (no upstream ref, no PR, not
# authenticated) and a single bad worktree must not abort the whole listing.
# Same lesson as worktree-cleanup.ps1.
$PSNativeCommandUseErrorActionPreference = $false

# --- locate the main checkout from git (correct from any worktree) ---
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$gitCommon = (& git -C $scriptDir rev-parse --git-common-dir 2>&1)
if ($LASTEXITCODE -ne 0 -or -not "$gitCommon".Trim()) {
  throw ("Could not resolve the git repository from '$scriptDir'. git said:`n$gitCommon`n" +
         "If this is a 'dubious ownership' error, mark the main checkout trusted, e.g.:`n" +
         "  git config --global --add safe.directory '<path to main checkout>'")
}
$gitCommon = "$gitCommon".Trim()
if (-not [IO.Path]::IsPathRooted($gitCommon)) { $gitCommon = Join-Path $scriptDir $gitCommon }
$mainRoot = (Resolve-Path (Join-Path $gitCommon '..')).Path

function Norm([string]$p) { if (-not $p) { return '' }; return $p.TrimEnd('\','/').Replace('/','\').ToLower() }

# --- registered worktrees, via porcelain ---
function Get-RegisteredWorktrees {
  $out = & git -C $mainRoot worktree list --porcelain 2>$null
  $items = @(); $cur = $null
  foreach ($line in $out) {
    if ($line -like 'worktree *') {
      if ($cur) { $items += $cur }
      $cur = [ordered]@{ path=($line -replace '^worktree ',''); head=$null; branch=$null; detached=$false; locked=$false }
    } elseif ($line -like 'HEAD *')   { $cur.head = ($line -replace '^HEAD ','') }
      elseif ($line -like 'branch *') { $cur.branch = (($line -replace '^branch ','') -replace '^refs/heads/','') }
      elseif ($line -eq 'detached')   { $cur.detached = $true }
      elseif ($line -like 'locked*')  { $cur.locked = $true }
  }
  if ($cur) { $items += $cur }
  return $items
}

# --- PRs keyed by head branch (one gh call for the whole listing; optional) ---
function Get-PrsByBranch {
  if ($NoPr) { return @{} }
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { return $null }
  $raw = & gh -R (& git -C $mainRoot remote get-url origin 2>$null) pr list `
           --state all --limit 100 --json number,title,headRefName,state 2>$null
  if ($LASTEXITCODE -ne 0 -or -not "$raw".Trim()) { return $null }
  try { $prs = "$raw" | ConvertFrom-Json } catch { return $null }
  $map = @{}
  foreach ($p in $prs) {
    # First match wins: gh returns newest first, so an open PR outranks an
    # older merged one on the same branch (branches do get reused).
    if (-not $map.ContainsKey($p.headRefName)) { $map[$p.headRefName] = $p }
  }
  return $map
}

# --- the human's own one-line summary, if they wrote one ---
# .claude/state files are named for the worktree, conventionally WITHOUT the
# harness hash suffix (worktree dreamy-leakey-b72e01 -> dreamy-leakey.md), so
# try the full leaf name and the leaf minus a trailing -<hex> segment.
function Get-StateHeadline([string]$leaf) {
  $names = @($leaf)
  if ($leaf -match '^(.*)-[0-9a-f]{6,}$') { $names += $Matches[1] }
  foreach ($n in $names) {
    $f = Join-Path $mainRoot ".claude\state\$n.md"
    if (Test-Path -LiteralPath $f -PathType Leaf) {
      $h1 = (Get-Content -LiteralPath $f -TotalCount 20 -ErrorAction SilentlyContinue |
             Where-Object { $_ -match '^\s*#\s+\S' } | Select-Object -First 1)
      if ($h1) {
        $t = ($h1 -replace '^\s*#\s+','').Trim()
        # Entries are conventionally "# <worktree> - <what it is>"; keep the
        # descriptive half so we don't just echo the folder name back.
        if ($t -match '^\S+\s+[-—]\s+(.+)$') { $t = $Matches[1].Trim() }
        return $t
      }
    }
  }
  return $null
}

$prMap = Get-PrsByBranch
$prLookupFailed = ($null -eq $prMap)
if ($prLookupFailed) { $prMap = @{} }

$rows = @()
foreach ($w in (Get-RegisteredWorktrees)) {
  $path   = $w.path
  $isMain = ((Norm $path) -eq (Norm $mainRoot))
  $leaf   = Split-Path -Leaf $path
  $onDisk = Test-Path -LiteralPath $path

  $subject = $null; $age = $null; $dirty = 0; $ahead = 0; $sha = $null
  # Any failure inspecting ONE worktree degrades that row, never the listing.
  try {
    if ($onDisk) {
      $log = (& git -c safe.directory=* -C $path log -1 --format='%h%x1f%s%x1f%cr' 2>$null)
      if ($log) { $parts = "$log" -split "`u{1f}"; $sha = $parts[0]; $subject = $parts[1]; $age = $parts[2] }
      $dirty = @(& git -c safe.directory=* -C $path status --porcelain 2>$null).Count
    }
    if ($w.head -and -not $isMain) {
      $n = (& git -C $mainRoot rev-list --count $w.head --not origin/main main 2>$null)
      if ($LASTEXITCODE -eq 0 -and "$n".Trim()) { $ahead = [int]"$n".Trim() }
    }
  } catch { }

  $pr = if ($w.branch -and $prMap.ContainsKey($w.branch)) { $prMap[$w.branch] } else { $null }
  $note = Get-StateHeadline $leaf

  # The honest description, best source first.
  #
  # The last-commit fallback is only legitimate when the worktree HAS commits of
  # its own. A worktree sitting at main inherits main's tip, and printing that
  # as its description implies it did work it never did (e.g. three worktrees
  # all claiming "Merge pull request #374"). Nothing to describe is a real
  # answer, and a better one than a confident wrong one.
  $ownWork = ($ahead -gt 0)
  $what = if ($note) { $note }
          elseif ($pr) { $pr.title }
          elseif ($ownWork -and $subject) { $subject }
          elseif ($dirty -gt 0) { '(uncommitted work in progress -- nothing committed yet)' }
          else { '(nothing of its own -- sitting at main)' }
  $whatFrom = if ($note) { 'state' }
              elseif ($pr) { 'pr' }
              elseif ($ownWork -and $subject) { 'commit' }
              else { 'none' }

  $rows += [ordered]@{
    folder=$leaf; path=$path; isMain=$isMain; onDisk=$onDisk; locked=$w.locked
    detached=$w.detached; branch=$w.branch; head=$w.head; sha=$sha
    what=$what; whatFrom=$whatFrom
    prNumber=$(if ($pr) { $pr.number } else { $null })
    prState=$(if ($pr) { $pr.state } else { $null })
    prTitle=$(if ($pr) { $pr.title } else { $null })
    lastCommit=$subject; lastCommitAge=$age; dirtyFiles=$dirty; aheadOfMain=$ahead
  }
}

if ($Json) {
  $rows | ConvertTo-Json -Depth 4
  return
}

# --- human-readable: main first, then worktrees, open PRs before the rest ---
$main  = @($rows | Where-Object { $_.isMain })
$other = @($rows | Where-Object { -not $_.isMain })
$rank  = { if ($_.prState -eq 'OPEN') { 0 } elseif ($_.aheadOfMain -gt 0) { 1 } else { 2 } }

Write-Host ""
Write-Host "Worktrees of $mainRoot"
if ($prLookupFailed) {
  Write-Host "  (PR titles unavailable -- gh missing, unauthenticated, or offline. Falling back to commit subjects.)"
}
Write-Host ("-" * 100)

foreach ($r in $main) {
  $state = if ($r.dirtyFiles -gt 0) { "$($r.dirtyFiles) file(s) uncommitted" } else { 'clean' }
  Write-Host ("MAIN   {0}  [{1}]  {2}" -f $r.folder, $r.branch, $state)
}
if ($main.Count -and $other.Count) { Write-Host "" }

foreach ($r in ($other | Sort-Object $rank, folder)) {
  $tag = if ($r.prNumber) { "#{0} {1}" -f $r.prNumber, $r.prState } else { 'no PR' }
  Write-Host ("{0,-13} {1}" -f $tag, $r.what)
  Write-Host ("              folder  {0}" -f $r.folder)
  Write-Host ("              branch  {0}" -f $(if ($r.branch) { $r.branch } else { "(detached at $($r.sha))" }))

  $bits = @()
  $bits += if ($r.aheadOfMain -gt 0) { "$($r.aheadOfMain) commit(s) ahead of main" } else { 'nothing ahead of main' }
  $bits += if ($r.dirtyFiles -gt 0)  { "$($r.dirtyFiles) file(s) uncommitted" } else { 'clean' }
  if ($r.lastCommitAge) { $bits += "last commit $($r.lastCommitAge)" }
  if ($r.locked)        { $bits += 'LOCKED' }
  if (-not $r.onDisk)   { $bits += 'DIRECTORY MISSING' }
  Write-Host ("              {0}" -f ($bits -join ' | '))

  # Name the source, so a folder/branch mismatch is visibly explained rather
  # than mysterious -- this is the confusion the script exists to remove.
  if ($r.whatFrom -eq 'commit') {
    Write-Host "              (described by its last commit -- no .claude/state entry, no PR)"
  } elseif ($r.whatFrom -eq 'state') {
    Write-Host "              (described by .claude/state)"
  } elseif ($r.whatFrom -eq 'none' -and $r.dirtyFiles -eq 0) {
    # Only when genuinely empty. A dirty worktree is someone's live session.
    Write-Host "              (nothing to describe it -- candidate for cleanup, or a fresh worktree)"
  }
  Write-Host ""
}

Write-Host ("-" * 100)
$open = @($other | Where-Object { $_.prState -eq 'OPEN' }).Count
Write-Host ("{0} worktree(s) besides main; {1} with an open PR." -f $other.Count, $open)
Write-Host "Folder names are historical and often wrong -- trust the branch and description above, not the folder."
Write-Host "Teardown: scripts/worktree-cleanup.ps1            (classify + safely remove)"
Write-Host ""
