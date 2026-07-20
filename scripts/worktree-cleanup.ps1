<#
.SYNOPSIS
  Classify and safely remove git worktrees for this repo, without ever
  deleting main's files through a node_modules junction.

.WHY
  Worktrees created by the OLD worktree-init.ps1 junction their node_modules
  back into the main checkout. A recursive delete (rm -rf / Remove-Item
  -Recurse / git worktree remove --force) FOLLOWS those junctions and wipes
  main's real files -- including, transitively via node_modules/@bible-editor,
  main's web/ and api/ SOURCE. This script always unlinks junctions FIRST
  (removing only the link, never the target -- see Remove-JunctionsSafely),
  then removes the worktree. New worktrees get their own real node_modules
  (see worktree-init.ps1) so they carry no junction to main at all.

.MODES
  (default)          Human-readable dry-run table. No changes.
  -Report           Emit JSON classification (used by the overnight task). No changes.
  -Remove <path>    Safely remove ONE worktree (unlink junctions, then remove).
                    Add -WhatIf to preview without deleting.
  -GraceHours <n>   How long a merged worktree must be idle before it counts as
                    auto-removable (SAFE). Default 72.

.CLASSES
  SAFE   registered, branch merged into (origin/)main, no uncommitted changes,
         idle longer than GraceHours -> auto-removable.
  GRAY   needs a human/Claude glance: uncommitted changes, unpushed/unmerged
         commits, merged-but-recent (within grace), detached HEAD, or an
         orphaned on-disk dir. NEVER auto-removed.
  KEEP   main itself, locked worktrees, or active unmerged branches.
#>
[CmdletBinding()]
param(
  [switch]$Report,
  [string]$Remove,
  [switch]$WhatIf,
  [int]$GraceHours = 72
)

$ErrorActionPreference = 'Stop'
# Keep cmdlet errors terminating (above) BUT never let a native command's
# nonzero exit throw: git merge-base --is-ancestor returns exit 1 as a NORMAL
# "not an ancestor" result, and rev-parse/rev-list exit nonzero for orphan
# dirs. Under pwsh configs where $PSNativeCommandUseErrorActionPreference is
# $true (the 7.3+ default), those would abort the whole classification.
$PSNativeCommandUseErrorActionPreference = $false

# --- locate the main checkout from git (correct from any worktree) ---
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$gitCommon  = (& git -C $scriptDir rev-parse --git-common-dir 2>&1)
if ($LASTEXITCODE -ne 0 -or -not "$gitCommon".Trim()) {
  # Fail closed with an actionable message: without a resolved main root we
  # cannot identify which worktrees are safe, so we must not touch anything.
  # The usual culprit is git's 'detected dubious ownership' guard when the
  # main checkout is owned by a different account than the caller.
  throw ("Could not resolve the git repository from '$scriptDir'. git said:`n$gitCommon`n" +
         "If this is a 'dubious ownership' error, mark the main checkout trusted, e.g.:`n" +
         "  git config --global --add safe.directory '<path to main checkout>'")
}
$gitCommon  = "$gitCommon".Trim()
if (-not [IO.Path]::IsPathRooted($gitCommon)) { $gitCommon = Join-Path $scriptDir $gitCommon }
$mainRoot   = (Resolve-Path (Join-Path $gitCommon '..')).Path

# Normalize a path for case/slash-insensitive equality comparison.
function Norm([string]$p) { if (-not $p) { return '' }; return $p.TrimEnd('\','/').Replace('/','\').ToLower() }

function Test-Reparse([string]$p) {
  try {
    $i = Get-Item -LiteralPath $p -Force -ErrorAction Stop
    return [bool]($i.Attributes -band [IO.FileAttributes]::ReparsePoint)
  } catch { return $false }
}

# Walk a tree collecting reparse points (junctions/symlinks) WITHOUT ever
# descending into one. This is what makes discovery safe: we never enumerate
# through a junction into main.
function Find-Junctions([string]$root) {
  $found = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path -LiteralPath $root)) { return ,$found }
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    $subs = @()
    try { $subs = [IO.Directory]::GetDirectories($d) } catch { continue }
    foreach ($c in $subs) {
      if (Test-Reparse $c) { $found.Add($c) }   # record; do NOT descend
      else { $stack.Push($c) }
    }
  }
  return ,$found
}

# Remove only the link, never the target's contents. Verified: on a Windows
# junction, Directory.Delete(path,$false) unlinks and leaves the target intact.
function Remove-JunctionsSafely([string]$worktreePath) {
  $junctions = Find-Junctions $worktreePath
  foreach ($j in $junctions) {
    [System.IO.Directory]::Delete($j, $false)
  }
  return $junctions.Count
}

function Git-Main { param([Parameter(ValueFromRemainingArguments=$true)]$rest)
  & git -C $mainRoot @rest 2>$null
}

# --- gather registered worktrees via porcelain ---
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

# --- find on-disk worktree dirs that git no longer tracks (orphans) ---
function Get-OrphanDirs([string[]]$registeredPaths) {
  $regNorm = $registeredPaths | ForEach-Object { Norm $_ }
  $candidates = @()
  $wtDir = Join-Path $mainRoot '.claude\worktrees'
  if (Test-Path $wtDir) { $candidates += Get-ChildItem $wtDir -Directory -ErrorAction SilentlyContinue }
  $parent = Split-Path -Parent $mainRoot
  $candidates += Get-ChildItem $parent -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'be-*' -or $_.Name -like 'BibleEditor-*' }
  $orphans = @()
  foreach ($c in $candidates) {
    if ((Norm $c.FullName) -eq (Norm $mainRoot)) { continue }
    if ($regNorm -notcontains (Norm $c.FullName)) { $orphans += $c.FullName }
  }
  return $orphans
}

function Test-Merged([string]$head) {
  if (-not $head) { return $false }
  foreach ($ref in @('origin/main','main')) {
    & git -C $mainRoot merge-base --is-ancestor $head $ref 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
  }
  return $false
}

function Get-Classification {
  $reg = Get-RegisteredWorktrees
  $regPaths = $reg | ForEach-Object { $_.path }
  $orphans = Get-OrphanDirs $regPaths
  $now = Get-Date
  $results = @()

  foreach ($w in $reg) {
    $path = $w.path
    $isMain = ((Norm $path) -eq (Norm $mainRoot))
    $onDisk = Test-Path -LiteralPath $path
    $reasons = @()
    $class = 'GRAY'

    if ($isMain)      { $class='KEEP'; $reasons+='main checkout' }
    elseif ($w.locked){ $class='KEEP'; $reasons+='locked' }
    elseif (-not $onDisk) { $class='SAFE'; $reasons+='registered but directory missing (prune)' }
    else {
      $uncommitted = @(& git -C $path status --porcelain 2>$null).Count -gt 0
      $merged = if ($w.detached) { $false } else { Test-Merged $w.head }
      $aheadOfMain = 0
      if (-not $merged -and $w.head) {
        $aheadOfMain = [int](& git -C $mainRoot rev-list --count $w.head --not origin/main main 2>$null)
      }
      $idleHours = [math]::Round(($now - (Get-Item -LiteralPath $path).LastWriteTime).TotalHours, 1)

      if ($w.detached)       { $class='GRAY'; $reasons+='detached HEAD' }
      elseif ($uncommitted)  { $class='GRAY'; $reasons+='uncommitted changes' }
      elseif (-not $merged) {
        if ($aheadOfMain -gt 0) { $class='KEEP'; $reasons+="active: $aheadOfMain commit(s) ahead of main" }
        else { $class='GRAY'; $reasons+='not merged, nothing ahead of main (why does it exist?)' }
      }
      else {
        # merged + clean
        if ($idleHours -ge $GraceHours) { $class='SAFE'; $reasons+="merged, clean, idle ${idleHours}h (>= ${GraceHours}h grace)" }
        else { $class='GRAY'; $reasons+="merged & clean but idle only ${idleHours}h (< ${GraceHours}h grace)" }
      }
    }

    $results += [ordered]@{
      path=$path; branch=$w.branch; head=$w.head; registered=$true
      onDisk=$onDisk; locked=$w.locked; detached=$w.detached
      class=$class; reasons=($reasons -join '; ')
    }
  }

  foreach ($o in $orphans) {
    $reasons = @('orphan: on disk but not a registered worktree')
    $branch = (& git -C $o rev-parse --abbrev-ref HEAD 2>$null)
    $results += [ordered]@{
      path=$o; branch=$branch; head=$null; registered=$false
      onDisk=$true; locked=$false; detached=$false
      class='GRAY'; reasons=($reasons -join '; ')
    }
  }

  return $results
}

# ============================ -Remove one worktree ============================
if ($Remove) {
  $target = (Resolve-Path -LiteralPath $Remove).Path
  if ((Norm $target) -eq (Norm $mainRoot)) {
    throw "Refusing to remove the MAIN checkout: $target"
  }
  # Only ever remove a KNOWN worktree: a registered worktree (not main) or a
  # discovered orphan worktree directory. This refuses arbitrary paths -- e.g.
  # '..' or the parent folder that CONTAINS main and all siblings -- so a stray
  # -Remove argument can never recursively delete outside the worktree set.
  $regForGuard = Get-RegisteredWorktrees
  $orphForGuard = Get-OrphanDirs ($regForGuard | ForEach-Object { $_.path })
  $known = @()
  $known += ($regForGuard | Where-Object { (Norm $_.path) -ne (Norm $mainRoot) } | ForEach-Object { Norm $_.path })
  $known += ($orphForGuard | ForEach-Object { Norm $_ })
  if ($known -notcontains (Norm $target)) {
    throw "Refusing: '$target' is not a registered worktree or a known orphan worktree directory. Run the script with no arguments to see the eligible list."
  }
  $isRegistered = ($regForGuard | ForEach-Object { Norm $_.path }) -contains (Norm $target)
  $junctions = Find-Junctions $target
  Write-Host "Worktree: $target"
  Write-Host "Junctions to unlink first ($($junctions.Count)):"
  $junctions | ForEach-Object { Write-Host "  - $_" }

  if ($WhatIf) {
    Write-Host "[WhatIf] Would unlink the above junctions (link only), then 'git worktree remove --force' (or rm+prune for orphans)."
    return
  }

  # 1) unlink junctions (link only, target untouched)
  $n = Remove-JunctionsSafely $target
  Write-Host "Unlinked $n junction(s)."

  # 2) remove the worktree. Junctions are gone, so recursive delete is now safe.
  if ($isRegistered) {
    & git -C $mainRoot worktree remove --force $target
    Write-Host "git worktree remove: done."
  } else {
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host "Removed orphan directory."
  }
  & git -C $mainRoot worktree prune
  Write-Host "git worktree prune: done."
  return
}

# ============================ report modes ============================
$rows = Get-Classification

if ($Report) {
  $rows | ConvertTo-Json -Depth 4
  return
}

# default: human-readable dry-run
$order = @{ 'GRAY'=0; 'SAFE'=1; 'KEEP'=2 }
Write-Host ""
Write-Host "Worktree cleanup (dry-run) -- grace ${GraceHours}h -- main: $mainRoot"
Write-Host ("-" * 90)
foreach ($r in ($rows | Sort-Object { $order[$_.class] }, path)) {
  $tag = switch ($r.class) { 'SAFE' {'[SAFE ]'} 'GRAY' {'[GRAY ]'} default {'[KEEP ]'} }
  $name = Split-Path -Leaf $r.path
  Write-Host ("{0} {1,-42} {2}" -f $tag, $name, ("({0})" -f $r.branch))
  Write-Host ("         {0}" -f $r.reasons)
}
Write-Host ("-" * 90)
$safe = @($rows | Where-Object { $_.class -eq 'SAFE' })
$gray = @($rows | Where-Object { $_.class -eq 'GRAY' })
Write-Host ("SAFE to auto-remove: {0}   GRAY (needs review): {1}   KEEP: {2}" -f $safe.Count, $gray.Count, @($rows | Where-Object { $_.class -eq 'KEEP' }).Count)
Write-Host ""
Write-Host "To remove one:  scripts/worktree-cleanup.ps1 -Remove '<path>'   (add -WhatIf to preview)"
