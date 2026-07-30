<#
.SYNOPSIS
  Forwarder. The real worktrees.ps1 lives in the dotfiles repo.

.WHY
  Same reason as worktree-cleanup.ps1: one implementation, in dotfiles, taking
  -RepoPath so a single copy serves every repo on the machine. This repo had the
  only copy and BEM had none, which meant "which worktree is this?" was a question
  you could only answer from inside one repo.

  This file stays so existing call sites and CLAUDE.md's instructions keep working.
  In new work prefer windows/Sweep-Worktrees.ps1, which answers the same question
  for every repo under C:\GH at once.
#>
#requires -Version 7
[CmdletBinding()]
param(
  [switch]$Json,
  [switch]$NoPr
)

$ErrorActionPreference = 'Stop'

$canonical = 'C:\GH\dotfiles\windows\worktrees.ps1'
if (-not (Test-Path -LiteralPath $canonical)) {
  throw @"
Canonical worktrees.ps1 not found at:
  $canonical

This repo's copy is now a thin forwarder. Make sure the dotfiles repo is cloned at
C:\GH\dotfiles and its checkout includes windows/ (added 2026-07):
  git -C C:\GH\dotfiles status
"@
}

# $PSScriptRoot is inside this repo -- or inside whichever worktree this was
# invoked from -- which is all `git -C` needs to resolve the right repository.
# No `exit $LASTEXITCODE` here. $LASTEXITCODE is set only by NATIVE commands, and
# the canonical script is PowerShell -- so after this call it holds the result of
# whichever `git` subcommand happened to run last anywhere in the call graph, not
# whether the operation succeeded. Exiting on that would make the exit code
# meaningless (and reorderings inside the canonical script could flip it).
# Letting the script end naturally yields 0, and a genuine failure still
# propagates: the canonical script runs with $ErrorActionPreference = 'Stop' and
# throws, which surfaces as a nonzero process exit on its own.
& $canonical -RepoPath $PSScriptRoot @PSBoundParameters
