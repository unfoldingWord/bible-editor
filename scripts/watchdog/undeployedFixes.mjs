// Merged-but-undeployed data-loss fixes (issue #1405). Read-only.
//
// PR #1384 (a data-loss fix) merged to main at 22:55 UTC on 2026-11-13, 1h45m
// after the last production deploy, and sat undeployed for four days while the
// bug it fixed reverted a translator's work. Nothing said it was waiting. This
// module is the sync watchdog's answer: label such PRs `data-loss`, compare
// each one's merge commit with the commit production is running, and name any
// that is not in the deploy.
//
// The deployed commit comes from /version.json, which `npm run build` stamps
// (web/vite.config.ts: `git rev-parse --short HEAD`) and the prod Worker serves
// from [assets]. "Is the merge commit in the deploy" is asked of GitHub's
// compare API, not of a local clone, so the check needs no fetched refs.
//
// Pure decision logic (findUndeployedFixes, undeployedLines) takes every input
// as an argument so the test needs no network. The gh/curl wrappers take an
// injectable runner for the same reason.
import { execFileSync } from "node:child_process";

export const DATA_LOSS_LABEL = "data-loss";
export const REPO_SLUG = "unfoldingWord/bible-editor";
export const VERSION_URL = "https://bible-editor-api.unfoldingword.workers.dev/version.json";
// Every labelled PR costs one compare call. If the list ever fills this, the
// oldest PRs may be missing, which collectUndeployedFixes reports (never silent).
export const PR_LIMIT = 200;

// "3d 1h", "1h 45m", "12m": how long a fix has been waiting.
export function formatAge(ms) {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// prs: [{ number, title, url?, mergedAt (ISO), mergeSha }]
// isAncestor(mergeSha, deployedCommit) -> true | false | null (null = could not tell)
// Returns { undeployed: [...oldest first], unchecked: [...] }. A PR the check
// could not answer for is "unchecked", never silently counted as deployed.
export function findUndeployedFixes({ deployedCommit, prs, isAncestor, nowMs }) {
  const undeployed = [];
  const unchecked = [];
  for (const pr of prs) {
    const mergedMs = Date.parse(pr.mergedAt);
    if (!pr.mergeSha || Number.isNaN(mergedMs)) {
      unchecked.push({ number: pr.number, title: pr.title, reason: "no merge commit or merge time" });
      continue;
    }
    let verdict = null;
    try {
      verdict = isAncestor(pr.mergeSha, deployedCommit);
    } catch (e) {
      unchecked.push({ number: pr.number, title: pr.title, reason: String(e?.message ?? e).slice(0, 200) });
      continue;
    }
    if (verdict === true) continue;
    if (verdict == null) {
      unchecked.push({ number: pr.number, title: pr.title, reason: "ancestry could not be determined" });
      continue;
    }
    undeployed.push({
      number: pr.number,
      title: pr.title,
      url: pr.url ?? null,
      mergedAt: pr.mergedAt,
      mergeSha: pr.mergeSha,
      waitingMs: Math.max(0, nowMs - mergedMs),
    });
  }
  undeployed.sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  return { undeployed, unchecked };
}

// Markdown lines for summary.md. `result` is null when the check itself failed
// (the reason is in bundle.errors); that is reported, never read as "none".
export function undeployedLines(result, { deployedCommit } = {}) {
  if (result == null) {
    return [`- **CHECK FAILED**: could not tell whether any \`${DATA_LOSS_LABEL}\` fix is waiting for a deploy (see errors, step "undeployed data-loss fixes").`];
  }
  const lines = [];
  for (const u of result.undeployed) {
    lines.push(
      `- **UNDEPLOYED**: #${u.number} "${u.title}" merged ${u.mergedAt} (${formatAge(u.waitingMs)} ago), not in deployed ${deployedCommit ?? "unknown"}${u.url ? ` ${u.url}` : ""}`,
    );
  }
  for (const u of result.unchecked) lines.push(`- UNCHECKED: #${u.number} "${u.title}": ${u.reason}`);
  if (lines.length === 0) lines.push(`- None: every merged \`${DATA_LOSS_LABEL}\` PR is in deployed ${deployedCommit ?? "unknown"}.`);
  return lines;
}

// timeout: a hung gh must not hang the whole watchdog run.
const defaultRun = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });

// "unknown" (a build with no git) and anything else that is not a sha cannot be
// compared, and must not read as "nothing is undeployed".
export function assertDeployedVersion(v) {
  if (typeof v?.commit !== "string" || !/^[0-9a-f]{7,40}$/.test(v.commit)) {
    throw new Error(`version.json has no usable commit: ${JSON.stringify(v).slice(0, 200)}`);
  }
  return v;
}

// The commit production runs. The query string is a cache-buster: without it
// the edge served the previous commit right after a deploy.
export function fetchDeployedVersion(run = defaultRun, now = Date.now()) {
  return assertDeployedVersion(JSON.parse(run("curl", ["-s", "-m", "20", `${VERSION_URL}?x=${now}`])));
}

// Merged, labelled PRs into main. Never writes.
export function listMergedDataLossPrs(run = defaultRun) {
  const raw = run("gh", [
    "pr", "list", "--repo", REPO_SLUG, "--state", "merged", "--label", DATA_LOSS_LABEL, "--base", "main",
    "--limit", String(PR_LIMIT), "--json", "number,title,url,mergedAt,mergeCommit",
  ]);
  return JSON.parse(raw).map((p) => ({
    number: p.number,
    title: p.title,
    url: p.url,
    mergedAt: p.mergedAt,
    mergeSha: p.mergeCommit?.oid ?? null,
  }));
}

// Is `mergeSha` part of `deployedCommit`'s history? compare/<base>...<head>
// with base = mergeSha, head = deployed. GitHub's status is the head's: "ahead"
// or "identical" means the deployed commit contains the merge commit, so it
// shipped; "behind" or "diverged" means the deployed build lacks it. A commit
// GitHub does not know (404, e.g. a deploy from an unpushed branch) throws,
// which findUndeployedFixes reports as unchecked.
export function mergeShaInDeploy(mergeSha, deployedCommit, run = defaultRun) {
  const status = run("gh", [
    "api", `repos/${REPO_SLUG}/compare/${mergeSha}...${deployedCommit}`, "--jq", ".status",
  ]).trim();
  if (status === "ahead" || status === "identical") return true;
  if (status === "behind" || status === "diverged") return false;
  return null;
}

// `deployed` lets the caller reuse the version.json it already fetched, so the
// report's "Deployed:" line and this check cannot name different commits.
export function collectUndeployedFixes({ run = defaultRun, nowMs = Date.now(), deployed: given = null } = {}) {
  const deployed = given ? assertDeployedVersion(given) : fetchDeployedVersion(run, nowMs);
  const prs = listMergedDataLossPrs(run);
  const result = findUndeployedFixes({
    deployedCommit: deployed.commit,
    prs,
    isAncestor: (sha, deployedCommit) => mergeShaInDeploy(sha, deployedCommit, run),
    nowMs,
  });
  if (prs.length >= PR_LIMIT) {
    result.unchecked.push({ number: "?", title: `PR list reached its ${PR_LIMIT} limit`, reason: "older merged data-loss PRs were not checked" });
  }
  return { deployed, ...result };
}
