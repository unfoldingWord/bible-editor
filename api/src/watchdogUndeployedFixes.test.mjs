// Tests for scripts/watchdog/undeployedFixes.mjs (issue #1405): the sync
// watchdog's "merged data-loss fix not yet deployed" check. No network: the
// deployed commit, the merged PR list and the ancestry answers are injected.
// Run alone from api/:
//   node --experimental-strip-types --no-warnings src/watchdogUndeployedFixes.test.mjs

import {
  collectUndeployedFixes,
  fetchDeployedVersion,
  findUndeployedFixes,
  formatAge,
  mergeShaInDeploy,
  PR_LIMIT,
  undeployedLines,
} from "../../scripts/watchdog/undeployedFixes.mjs";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const NOW = Date.parse("2026-11-17T12:00:00Z");
const pr1384 = { number: 1384, title: "Preserve blocks only the AI note writer", url: "https://x/pull/1384", mergedAt: "2026-11-13T22:55:45Z", mergeSha: "38d5a70" };
const older = { number: 1100, title: "An older fix", url: null, mergedAt: "2026-11-01T10:00:00Z", mergeSha: "aaaaaaa" };

// Ancestry fixture: the set of merge shas the deployed commit contains.
const ancestry = (shipped) => (sha) => shipped.includes(sha);

{
  // The #1384 scenario: merged after the deployed commit, so it is reported.
  const r = findUndeployedFixes({ deployedCommit: "4b47dbf", prs: [older, pr1384], isAncestor: ancestry(["aaaaaaa"]), nowMs: NOW });
  assert(r.undeployed.length === 1 && r.undeployed[0].number === 1384, "a data-loss PR merged after the deployed commit is reported");
  assert(r.unchecked.length === 0, "the shipped older PR is not unchecked");
  assert(r.undeployed[0].waitingMs === NOW - Date.parse("2026-11-13T22:55:45Z"), "waiting time runs from merge to now");
  const lines = undeployedLines(r, { deployedCommit: "4b47dbf" }).join("\n");
  assert(lines.includes("#1384") && lines.includes("Preserve blocks only the AI note writer") && lines.includes("3d 13h") && lines.includes("UNDEPLOYED"), "the report names the PR, its title and how long it has waited");
  assert(!lines.includes("#1100"), "the shipped PR is not named");
}

{
  // After the deploy that includes it, the line goes away.
  const r = findUndeployedFixes({ deployedCommit: "f3b9b75", prs: [older, pr1384], isAncestor: ancestry(["aaaaaaa", "38d5a70"]), nowMs: NOW });
  assert(r.undeployed.length === 0 && r.unchecked.length === 0, "a PR included in the deploy is not reported");
  const lines = undeployedLines(r, { deployedCommit: "f3b9b75" });
  assert(lines.length === 1 && lines[0].startsWith("- None") && !lines[0].includes("UNDEPLOYED"), "the report says none when everything shipped");
}

{
  // Several waiting: oldest first. Unknown answers are surfaced, never counted as shipped.
  const second = { number: 1500, title: "Second", mergedAt: "2026-11-16T00:00:00Z", mergeSha: "bbbbbbb" };
  const r = findUndeployedFixes({ deployedCommit: "4b47dbf", prs: [second, pr1384], isAncestor: () => false, nowMs: NOW });
  assert(r.undeployed.map((u) => u.number).join() === "1384,1500", "waiting fixes are listed oldest first");
  const unknown = findUndeployedFixes({ deployedCommit: "4b47dbf", prs: [pr1384], isAncestor: () => null, nowMs: NOW });
  assert(unknown.undeployed.length === 0 && unknown.unchecked.length === 1, "an undeterminable answer is unchecked, not deployed");
  assert(undeployedLines(unknown, { deployedCommit: "4b47dbf" })[0].startsWith("- UNCHECKED: #1384"), "unchecked PRs are reported");
  const thrown = findUndeployedFixes({ deployedCommit: "zzz", prs: [pr1384], isAncestor: () => { throw new Error("HTTP 404"); }, nowMs: NOW });
  assert(thrown.unchecked.length === 1 && thrown.unchecked[0].reason === "HTTP 404", "a failing ancestry lookup is unchecked with its reason");
  const noSha = findUndeployedFixes({ deployedCommit: "4b47dbf", prs: [{ ...pr1384, mergeSha: null }], isAncestor: () => true, nowMs: NOW });
  assert(noSha.unchecked.length === 1, "a PR with no merge commit is unchecked");
  assert(undeployedLines(null)[0].includes("CHECK FAILED"), "a failed check is reported as failed, not as none");
}

assert(formatAge(45 * 60_000) === "45m" && formatAge(105 * 60_000) === "1h 45m" && formatAge(-5) === "0m", "formatAge");

{
  // The gh/curl wrappers, with a fake runner.
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "curl") return JSON.stringify({ commit: "4b47dbf", builtAt: "2026-11-13T21:10:29.899Z" });
    if (args[0] === "pr") return JSON.stringify([{ number: 1384, title: "T", url: "https://x", mergedAt: "2026-11-13T22:55:45Z", mergeCommit: { oid: "38d5a700" } }]);
    if (args[0] === "api") return args[1].endsWith("...4b47dbf") ? "behind\n" : "ahead\n";
    throw new Error("unexpected " + cmd);
  };
  const out = collectUndeployedFixes({ run, nowMs: NOW });
  assert(out.deployed.commit === "4b47dbf" && out.undeployed.length === 1 && out.undeployed[0].number === 1384, "collect: 'behind' from the compare API means undeployed");
  assert(calls.some((c) => c.startsWith("curl") && c.includes("version.json?x=")), "collect: version.json is read with a cache-buster");
  assert(calls.some((c) => c.includes("--label data-loss") && c.includes("--state merged")), "collect: lists merged data-loss PRs");
  assert(calls.every((c) => !/\b(POST|PUT|PATCH|DELETE)\b|--method|-X /.test(c)), "collect: read-only calls only");
  const shipped = collectUndeployedFixes({ run: (cmd, args) => (args[0] === "api" ? "ahead\n" : run(cmd, args)), nowMs: NOW });
  assert(shipped.undeployed.length === 0, "collect: 'ahead' (deployed contains the merge commit) means shipped");
  assert(mergeShaInDeploy("a", "b", () => "identical\n") === true && mergeShaInDeploy("a", "b", () => "diverged\n") === false && mergeShaInDeploy("a", "b", () => "weird") === null, "mergeShaInDeploy maps compare statuses");
  const reused = collectUndeployedFixes({ run: (cmd, args) => { if (cmd === "curl") throw new Error("must not refetch"); return run(cmd, args); }, nowMs: NOW, deployed: { commit: "4b47dbf" } });
  assert(reused.undeployed.length === 1, "collect: a deployed version the caller already fetched is reused, not refetched");
  const full = collectUndeployedFixes({
    run: (cmd, args) => (args[0] === "pr" ? JSON.stringify(Array.from({ length: PR_LIMIT }, (_, i) => ({ number: i + 1, title: "t", url: "u", mergedAt: "2026-11-01T00:00:00Z", mergeCommit: { oid: "c" + i } }))) : args[0] === "api" ? "ahead\n" : run(cmd, args)),
    nowMs: NOW,
    deployed: { commit: "4b47dbf" },
  });
  assert(full.undeployed.length === 0 && full.unchecked.some((u) => /limit/.test(u.title)), "collect: a PR list that hit its limit is flagged, not silently truncated");
  let threw = false;
  try { fetchDeployedVersion(() => "{\"commit\":\"unknown\"}"); } catch { threw = true; }
  assert(threw, "an unusable deployed commit (unknown) is an error, not 'nothing undeployed'");
}

console.log("watchdogUndeployedFixes: all passed");
