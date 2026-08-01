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
// Exit codes: 0 pass, 1 a genuinely dead id, 2 "could not get a trustworthy
// answer" (network failure, bad response, truncated listing). GitHub Actions
// treats every non-zero the same, so the code is for humans and for anything
// that later wraps this script — the point is that an outage must never read
// as "your ids are wrong" and get a valid id deleted from the picker.
//
// Two passes on purpose. The cheap pass lists the `translate/` tree once, so a
// slow or rate-limited Door43 can't turn a clean run into 94 round-trips. But a
// *partially* truncated listing would then report valid ids as dead — and the
// script's own advice is to delete them, which would silently strip legitimate
// TA references from every translator's dropdown. So anything the first pass
// flags is re-probed individually against the actual `01.md`, and only a real
// 404 is reported.

import { TA_SUPPORT_REFERENCE_IDS } from "./taSupportReferences.ts";

const REPO = "https://git.door43.org/api/v1/repos/unfoldingWord/en_ta/contents";
const TIMEOUT_MS = 30_000;

/** Fetch JSON, or exit 2 — a transport failure is never an id verdict. */
async function getJson(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`FETCH FAILED: ${url} -> ${err?.message ?? err}`);
    process.exit(2);
  }
  if (!res.ok) {
    console.error(`FETCH FAILED: ${url} -> HTTP ${res.status}`);
    process.exit(2);
  }
  try {
    return await res.json();
  } catch (err) {
    // A captive portal or HTML error page served with 200 lands here.
    console.error(`BAD RESPONSE: ${url} -> not JSON (${err?.message ?? err})`);
    process.exit(2);
  }
}

// Free check, no network: a duplicate id doubles the dropdown entry.
const dupes = TA_SUPPORT_REFERENCE_IDS.filter(
  (id, i) => TA_SUPPORT_REFERENCE_IDS.indexOf(id) !== i,
);
if (dupes.length > 0) {
  console.error(`duplicate support-reference id(s): ${[...new Set(dupes)].join(", ")}`);
  process.exit(1);
}

// Pass 1 — one request for the whole tree.
const entries = await getJson(`${REPO}/translate`);
if (!Array.isArray(entries)) {
  console.error("BAD RESPONSE: en_ta translate/ listing is not an array");
  process.exit(2);
}
const articles = new Set(entries.filter((e) => e.type === "dir").map((e) => e.name));

// Gross truncation: don't even try to draw conclusions from it.
if (articles.size < 100) {
  console.error(
    `UNTRUSTWORTHY LISTING: en_ta translate/ returned only ${articles.size} dirs — refusing to validate against it`,
  );
  process.exit(2);
}

const suspects = TA_SUPPORT_REFERENCE_IDS.filter((id) => !articles.has(id));

// Pass 2 — confirm each suspect individually against the article itself, so a
// partially truncated listing can't condemn a valid id. This is also what makes
// the check an *article* check rather than a directory check: a retired article
// whose dir lingers without 01.md is still caught.
const dead = [];
for (const id of suspects) {
  const url = `${REPO}/translate/${id}/01.md`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    console.error(`FETCH FAILED: ${url} -> ${err?.message ?? err}`);
    process.exit(2);
  }
  if (res.status === 404) dead.push(id);
  else if (!res.ok) {
    console.error(`FETCH FAILED: ${url} -> HTTP ${res.status}`);
    process.exit(2);
  } else {
    console.warn(`  note - ${id} missing from the tree listing but 01.md exists; listing may be incomplete`);
  }
}

if (dead.length > 0) {
  console.error(
    `\n${dead.length} support-reference id(s) do not exist in unfoldingWord/en_ta translate/:\n`,
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
