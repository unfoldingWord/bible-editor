<#
.SYNOPSIS
  Forwarder. The real worktree-cleanup.ps1 lives in the dotfiles repo.

.WHY
  This used to be a full copy, and BEM had its own. The copies drifted: BEM's was
  frozen before the hardening that added dubious-ownership handling, per-worktree
  try/catch, and the orphan-directory ownership guard -- and BEM's copy was the one
  a nightly cleanup was pointed at. A script that deletes worktrees is the last
  place you want two versions of the truth.

  That drift hid a real bug for who knows how long: a FAILED `git status` was read
  as a clean working tree, so a worktree holding uncommitted work could classify
  SAFE and be deleted. Fixed once, centrally, rather than in each copy.

  The canonical implementation now lives in dotfiles and takes -RepoPath, so one
  copy serves every repo on the machine. This file stays only so existing call
  sites and the instructions in CLAUDE.md keep working unchanged.

  Prefer calling the canonical script directly in new work -- or better,
  windows/Sweep-Worktrees.ps1, which classifies every repo at once.
#>
#requires -Version 7
[CmdletBinding()]
param(
  [switch]$Report,
  [string]$Remove,
  [switch]$WhatIf,
  [int]$GraceHours = 72
)

$ErrorActionPreference = 'Stop'

$canonical = 'C:\GH\dotfiles\windows\worktree-cleanup.ps1'
if (-not (Test-Path -LiteralPath $canonical)) {
  # Fail loudly rather than silently doing nothing. The usual causes are the
  # dotfiles repo not being cloned on this machine, or its checkout sitting on a
  # branch that predates windows/. Never fall back to a stale bundled copy --
  # the entire point is that exactly one implementation deletes worktrees.
  throw @"
Canonical worktree-cleanup.ps1 not found at:
  $canonical

This repo's copy is now a thin forwarder. Make sure the dotfiles repo is cloned at
C:\GH\dotfiles and its checkout includes windows/ (added 2026-07):
  git -C C:\GH\dotfiles status
"@
}

# $PSScriptRoot is inside this repo -- or inside whichever worktree this was
# invoked from -- which is all `git -C` needs to resolve the right repository.
& $canonical -RepoPath $PSScriptRoot @PSBoundParameters
exit $LASTEXITCODE
