// Network check: every id in TA_SUPPORT_REFERENCE_IDS must resolve to a real
// article in unfoldingWord/en_ta. A dead id here is invisible otherwise — the
// export lint (SUPPORT_REFERENCE_RE in lint.ts) only validates rc:// *shape*,
// never membership, so a wrong slug is offered to translators, saved into
// tn_rows.support_reference, and exported to Door43 without a single warning.
// That is exactly how `grammar-connect-logic-reason` survived: no such article
// exists (the one article `grammar-connect-logic-result` covers both the reason
// and the result side of the relationship).
//
// This hits git.door43.org, so it is deliberately NOT in `npm test` — the unit
// suites in this repo are all offline and deterministic. It runs nightly via
// .github/workflows/ta-refs.yml, and on demand:
//
//   npm --workspace api run check:ta-refs
//
// It reads the repo's git tree recursively in ONE request and checks for the
// article file itself, `translate/<id>/01.md`. Two earlier shapes were worse:
// per-id requests cost 94 round-trips, and listing `translate/` and comparing
// directory names passes a retired article whose directory lingers without its
// 01.md. The tree gives exact file paths, so neither trade-off is needed.
//
// Exit codes: 0 pass, 1 a genuinely dead id, 2 "could not get a trustworthy
// answer" (network failure, bad response, truncated tree). GitHub Actions
// treats every non-zero the same, so the code is for humans and for anything
// that later wraps this script — the point is that an outage must never read as
// "your ids are wrong". That matters because the failure message tells you to
// remove the id, and removing a *valid* one silently strips a legitimate TA
// reference from every translator's dropdown.

import { TA_SUPPORT_REFERENCE_IDS } from "./taSupportReferences.ts";

const TREE_URL =
  "https://git.door43.org/api/v1/repos/unfoldingWord/en_ta/git/trees/master?recursive=1&per_page=100000";
const TIMEOUT_MS = 30_000;

/** Exit 2 rather than let a transport problem masquerade as an id verdict. */
function bail(message) {
  console.error(message);
  process.exit(2);
}

// Free check, no network: a duplicate id doubles the dropdown entry.
const dupes = TA_SUPPORT_REFERENCE_IDS.filter(
  (id, i) => TA_SUPPORT_REFERENCE_IDS.indexOf(id) !== i,
);
if (dupes.length > 0) {
  console.error(`duplicate support-reference id(s): ${[...new Set(dupes)].join(", ")}`);
  process.exit(1);
}

let res;
try {
  res = await fetch(TREE_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
} catch (err) {
  bail(`FETCH FAILED: ${TREE_URL} -> ${err?.message ?? err}`);
}
if (!res.ok) bail(`FETCH FAILED: ${TREE_URL} -> HTTP ${res.status}`);

let tree;
try {
  // A captive portal or HTML error page served with 200 lands in the catch.
  tree = await res.json();
} catch (err) {
  bail(`BAD RESPONSE: not JSON (${err?.message ?? err})`);
}

if (!Array.isArray(tree?.tree)) bail("BAD RESPONSE: en_ta tree has no `tree` array");
// Gitea sets `truncated` when the tree exceeded what it will return, and
// `total_count` when it paginated. Either means we are looking at part of the
// repo, and a partial tree would condemn valid ids.
if (tree.truncated === true) bail("UNTRUSTWORTHY TREE: en_ta tree came back truncated");
if (typeof tree.total_count === "number" && tree.total_count !== tree.tree.length) {
  bail(
    `UNTRUSTWORTHY TREE: got ${tree.tree.length} of ${tree.total_count} entries — refusing to validate against a partial tree`,
  );
}

const ARTICLE_RE = /^translate\/([^/]+)\/01\.md$/;
const articles = new Set();
for (const entry of tree.tree) {
  if (entry.type !== "blob") continue;
  const m = ARTICLE_RE.exec(entry.path);
  if (m) articles.add(m[1]);
}

// Last backstop: a shape change that matched nothing would report every id dead.
if (articles.size < 100) {
  bail(
    `UNTRUSTWORTHY TREE: only ${articles.size} translate/*/01.md articles found — refusing to validate against it`,
  );
}

const dead = TA_SUPPORT_REFERENCE_IDS.filter((id) => !articles.has(id));

if (dead.length > 0) {
  console.error(
    `\n${dead.length} support-reference id(s) have no translate/<id>/01.md in unfoldingWord/en_ta:\n`,
  );
  for (const id of dead) console.error(`  - ${id}`);
  console.error(
    "\nRemove or correct them in api/src/taSupportReferences.ts. Do not guess a\n" +
      "near-miss replacement: a wrong id changes the meaning of every note that\n" +
      "carries it.\n",
  );
  process.exit(1);
}

console.log(
  `  ok - all ${TA_SUPPORT_REFERENCE_IDS.length} support-reference ids resolve in en_ta (${articles.size} articles available)`,
);
