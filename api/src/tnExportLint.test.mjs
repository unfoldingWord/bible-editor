// Unit tests for the non-blocking TN export lint alert (issue #1015).
// Run: node --experimental-strip-types --no-warnings src/tnExportLint.test.mjs

import assert from "node:assert/strict";
import {
  tnExportHardErrors,
  reconcileTnExportInvalidAlert,
  tnExportInvalidAlertSource,
} from "./tnExportLint.ts";

let passed = 0;
async function t(name, fn) {
  await fn();
  passed++;
  console.log(`  ok - ${name}`);
}

const TN_H = ["Reference", "ID", "Tags", "SupportReference", "Quote", "Occurrence", "Note"].join("\t");
const tnTsv = (...rows) => `${TN_H}\n${rows.map((r) => r.join("\t")).join("\n")}\n`;

// The measured JER 17:4 shape: the second `[` is never closed.
const UNCLOSED = tnTsv(
  ["17:3", "ab12", "", "", "", "", "Alternate translation: [fine]"],
  ["17:4", "ny7v", "", "", "", "", "Alternate translation: [...] or [And you shall lose your own control of the inheritance"],
);
const CLEAN = tnTsv(
  ["17:3", "ab12", "", "", "", "", "Alternate translation: [fine]"],
  ["17:4", "ny7v", "", "", "", "", "Alternate translation: [...] or [And you shall lose control]"],
);

// In-memory stand-in for system_alerts (undismissed rows keyed by source).
function fakeOps() {
  const open = new Map();
  return {
    open,
    ops: {
      async write(source, message) { open.set(source, message); },
      async clear(source) { open.delete(source); },
    },
  };
}

console.log("[tnExportHardErrors]");
await t("unclosed [ is found with its ref and row id", () => {
  const f = tnExportHardErrors(UNCLOSED);
  assert.equal(f.length, 1);
  assert.equal(f[0].ref, "17:4");
  assert.equal(f[0].rowId, "ny7v");
  assert.match(f[0].message, /does not have a matching closing bracket|has no matching/);
});
await t("clean render has no findings", () => {
  assert.deepEqual(tnExportHardErrors(CLEAN), []);
});
await t("unrecognized header / empty input is silent", () => {
  assert.deepEqual(tnExportHardErrors(""), []);
  assert.deepEqual(tnExportHardErrors("A\tB\n1\t[\n"), []);
});

console.log("[reconcileTnExportInvalidAlert]");
await t("unclosed [ raises one alert naming the row id, ref and Door43 rejection", async () => {
  const { open, ops } = fakeOps();
  await reconcileTnExportInvalidAlert("JER", UNCLOSED, ops);
  const src = tnExportInvalidAlertSource("JER");
  assert.equal(src, "export_tn_invalid:JER:tn");
  const msg = open.get(src);
  assert.ok(msg, "alert written");
  assert.match(msg, /ny7v/);
  assert.match(msg, /JER 17:4/);
  assert.match(msg, /Door43 will reject/);
  assert.equal(open.size, 1);
});
await t("a clean render resolves the previously open alert", async () => {
  const { open, ops } = fakeOps();
  await reconcileTnExportInvalidAlert("JER", UNCLOSED, ops);
  assert.equal(open.size, 1);
  const f = await reconcileTnExportInvalidAlert("JER", CLEAN, ops);
  assert.deepEqual(f, []);
  assert.equal(open.size, 0);
});
await t("clearing one book leaves another book's alert alone", async () => {
  const { open, ops } = fakeOps();
  await reconcileTnExportInvalidAlert("JER", UNCLOSED, ops);
  await reconcileTnExportInvalidAlert("ZEC", CLEAN, ops);
  assert.ok(open.has("export_tn_invalid:JER:tn"));
});

console.log(`tnExportLint: ${passed} passed`);
