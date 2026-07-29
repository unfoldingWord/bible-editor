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
  (default)  Human-readable table, plus a trailing list of unregistered
             (on-disk-only) worktree directories.
  -Json      Emit the registered worktrees as JSON, for scripting. Does NOT
             include the unregistered-directories section.
  -NoPr      Skip the `gh` call (faster, or when offline / gh unauthenticated).
             Rows then read "PR ?" rather than asserting "no PR".
#>
#requires -Version 7
# pwsh 7+ only, and NOT a formality: under Windows PowerShell 5.1 the
# $PSNativeCommandUseErrorActionPreference assignment below is a silent no-op
# (so every expected nonzero git/gh exit starts throwing) and this file's
# non-ASCII characters mis-decode. Fail loudly instead of misbehaving quietly.
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
  # Limit must exceed the repo's total PR count or old branches silently render
  # as "no PR": at --limit 100 the window bottomed out at #268 of 367.
  $raw = & gh -R (& git -C $mainRoot remote get-url origin 2>$null) pr list `
           --state all --limit 600 --json number,title,headRefName,state 2>$null
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
# .claude/ is git-ignored, so each worktree carries its OWN copy of
# .claude/state/ and an agent following .claude/state/README.md from inside its
# worktree writes there, not into main. Search the worktree FIRST and main
# second -- looking only in main made this (the highest-priority description
# source) dead in the common case.
#
# Files are named for the worktree, conventionally WITHOUT the harness hash
# suffix (worktree dreamy-leakey-b72e01 -> dreamy-leakey.md), so try the full
# leaf name and the leaf minus a trailing -<hex> segment.
function Get-StateHeadline([string]$leaf, [string]$worktreePath) {
  $names = @($leaf)
  if ($leaf -match '^(.*)-[0-9a-f]{6,}$') { $names += $Matches[1] }
  $roots = @()
  if ($worktreePath) { $roots += $worktreePath }
  $roots += $mainRoot
  foreach ($root in $roots) {
    foreach ($n in $names) {
      $f = Join-Path $root ".claude\state\$n.md"
      if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { continue }
      $h1 = (Get-Content -LiteralPath $f -TotalCount 20 -ErrorAction SilentlyContinue |
             Where-Object { $_ -match '^\s*#\s+\S' } | Select-Object -First 1)
      if (-not $h1) { continue }
      $t = ($h1 -replace '^\s*#\s+','').Trim()
      # Entries are conventionally "# <worktree> - <what it is>"; keep the
      # descriptive half so we don't just echo the folder name back. Only strip
      # when the first token really IS one of this worktree's names -- a plain
      # title like "Bug - alignment lost" must keep its first word.
      if ($t -match '^(\S+)\s+[-—]\s+(.+)$' -and ($names -contains $Matches[1])) {
        $t = $Matches[2].Trim()
      }
      return $t
    }
  }
  return $null
}

$prMap = Get-PrsByBranch
$prLookupFailed = ($null -eq $prMap)
if ($prLookupFailed) { $prMap = @{} }
# Did we actually learn anything about PRs? False for -NoPr and for any failure,
# so the renderer can say "unknown" instead of asserting "no PR".
$prKnown = (-not $prLookupFailed) -and (-not $NoPr)

$rows = @()
foreach ($w in (Get-RegisteredWorktrees)) {
  $path   = $w.path
  $isMain = ((Norm $path) -eq (Norm $mainRoot))
  $leaf   = Split-Path -Leaf $path
  $onDisk = Test-Path -LiteralPath $path

  # $dirty stays $null when we could not determine it. "Unknown" must never
  # render as "clean": a sibling agent mid-`git add` holds index.lock, our
  # status call fails, and a worktree with 20 uncommitted files would otherwise
  # print "clean / candidate for cleanup" -- advice that precedes a deletion.
  $subject = $null; $age = $null; $dirty = $null; $ahead = 0; $sha = $null
  # Any failure inspecting ONE worktree degrades that row, never the listing.
  try {
    if ($onDisk) {
      $log = (& git -c safe.directory=* -C $path log -1 --format='%h%x1f%s%x1f%cr' 2>$null)
      if ($log) { $parts = "$log" -split "`u{1f}"; $sha = $parts[0]; $subject = $parts[1]; $age = $parts[2] }
      $st = @(& git -c safe.directory=* -C $path status --porcelain 2>$null)
      if ($LASTEXITCODE -eq 0) { $dirty = $st.Count }
    }
    if ($w.head -and -not $isMain) {
      $n = (& git -C $mainRoot rev-list --count $w.head --not origin/main main 2>$null)
      if ($LASTEXITCODE -eq 0 -and "$n".Trim()) { $ahead = [int]"$n".Trim() }
    }
  } catch { }

  $pr = if ($w.branch -and $prMap.ContainsKey($w.branch)) { $prMap[$w.branch] } else { $null }
  $note = if ($isMain) { $null } else { Get-StateHeadline $leaf $path }

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
          elseif ($null -eq $dirty) { '(could not inspect this worktree -- look before assuming it is idle)' }
          elseif ($dirty -gt 0) { '(uncommitted work in progress -- nothing committed yet)' }
          else { '(nothing of its own -- sitting at main)' }
  $whatFrom = if ($note) { 'state' }
              elseif ($pr) { 'pr' }
              elseif ($ownWork -and $subject) { 'commit' }
              else { 'none' }
  # main is rendered by its own one-liner and never shows a description; leaving
  # a computed one in -Json output would just be a nonsense field.
  if ($isMain) { $what = $null; $whatFrom = $null }

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

function Format-Dirty($d) {
  if ($null -eq $d) { return 'working tree state UNKNOWN' }
  if ($d -gt 0)     { return "$d file(s) uncommitted" }
  return 'clean'
}

foreach ($r in $main) {
  Write-Host ("MAIN   {0}  [{1}]  {2}" -f $r.folder, $r.branch, (Format-Dirty $r.dirtyFiles))
}
if ($main.Count -and $other.Count) { Write-Host "" }

foreach ($r in ($other | Sort-Object $rank, folder)) {
  # "PR ?" when we never successfully asked -- asserting "no PR" from a lookup
  # that did not happen is a claim we have not earned.
  $tag = if ($r.prNumber)   { "#{0} {1}" -f $r.prNumber, $r.prState }
         elseif ($prKnown)  { 'no PR' }
         else               { 'PR ?' }
  Write-Host ("{0,-13} {1}" -f $tag, $r.what)
  Write-Host ("              folder  {0}" -f $r.folder)
  Write-Host ("              branch  {0}" -f $(if ($r.branch) { $r.branch } else { "(detached at $($r.sha))" }))

  $bits = @()
  $bits += if ($r.aheadOfMain -gt 0) { "$($r.aheadOfMain) commit(s) ahead of main" } else { 'nothing ahead of main' }
  $bits += (Format-Dirty $r.dirtyFiles)
  if ($r.lastCommitAge) { $bits += "last commit $($r.lastCommitAge)" }
  if ($r.locked)        { $bits += 'LOCKED' }
  if (-not $r.onDisk)   { $bits += 'DIRECTORY MISSING' }
  Write-Host ("              {0}" -f ($bits -join ' | '))

  # Name the source, so a folder/branch mismatch is visibly explained rather
  # than mysterious -- this is the confusion the script exists to remove.
  if ($r.whatFrom -eq 'commit') {
    # NOT named $noPr: PowerShell variable names are case-insensitive, so that
    # would collide with the -NoPr [switch] parameter and fail to assign.
    $prBit = if ($prKnown) { 'no PR' } else { 'PR lookup skipped' }
    Write-Host ("              (described by its last commit -- no .claude/state entry, {0})" -f $prBit)
  } elseif ($r.whatFrom -eq 'state') {
    Write-Host "              (described by .claude/state)"
  } elseif ($r.whatFrom -eq 'none' -and $r.dirtyFiles -eq 0) {
    # Only when genuinely empty AND we could actually read the tree. A dirty or
    # uninspectable worktree may be someone's live session.
    Write-Host "              (nothing to describe it -- candidate for cleanup, or a fresh worktree)"
  }
  Write-Host ""
}

# Orphans: on disk under .claude/worktrees but no longer registered with git.
# Someone standing in one of these asking "which worktree is this?" would
# otherwise get no row at all. Enumeration is a single non-recursive listing --
# it never descends, so it cannot traverse a node_modules junction.
$wtDir = Join-Path $mainRoot '.claude\worktrees'
if (Test-Path -LiteralPath $wtDir) {
  $regNorm = @($rows | ForEach-Object { Norm $_.path })
  $orphans = @(Get-ChildItem -LiteralPath $wtDir -Directory -ErrorAction SilentlyContinue |
               Where-Object { $regNorm -notcontains (Norm $_.FullName) })
  if ($orphans.Count) {
    Write-Host "Not registered with git (on disk only) -- stale leftovers, or a worktree removed mid-session:"
    foreach ($o in $orphans) { Write-Host ("  {0}" -f $o.Name) }
    Write-Host "  -> classify these with scripts/worktree-cleanup.ps1 (it verifies each is really ours before removing)."
    Write-Host ""
  }
}

Write-Host ("-" * 100)
$open = @($other | Where-Object { $_.prState -eq 'OPEN' }).Count
Write-Host ("{0} worktree(s) besides main; {1} with an open PR." -f $other.Count, $open)
Write-Host "Folder names are historical and often wrong -- trust the branch and description above, not the folder."
Write-Host "Teardown: scripts/worktree-cleanup.ps1            (classify + safely remove)"
Write-Host ""
