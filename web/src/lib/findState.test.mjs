// Tests for the Find-overlay persistence helpers. These are what let a Find
// session survive the ScriptureColumn remount a chapter change forces (see the
// module header in findState.ts): the open flag and the typed query are
// reseeded from sessionStorage, per-book, and a deliberate close wipes them.

import assert from "node:assert/strict";
import {
  loadFindDraft,
  saveFindDraft,
  loadFindOpen,
  saveFindOpen,
  clearFindState,
} from "./findState.ts";

// Minimal in-memory sessionStorage — the module accesses it only inside its
// functions, so installing the global after import is fine.
function installStorage() {
  const map = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
  return map;
}

let passed = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ok: ${msg}`);
  passed++;
};

const DRAFT = {
  find: "grace",
  replace: "favor",
  regex: true,
  caseSensitive: true,
  strongs: true,
};

// --- Draft round-trips for the same book (the retype fix) ---
installStorage();
saveFindDraft("ZEC", DRAFT);
check(
  JSON.stringify(loadFindDraft("ZEC")) === JSON.stringify(DRAFT),
  "a saved draft reloads intact for the same book",
);

// --- Draft is scoped to its book (switching books starts fresh) ---
check(
  loadFindDraft("MAT").find === "" && loadFindDraft("MAT").regex === false,
  "a draft saved under ZEC does not leak into MAT",
);

// --- Open flag round-trips and is per-book ---
installStorage();
saveFindOpen("ZEC", true);
check(loadFindOpen("ZEC") === true, "open flag reloads true for the same book");
check(loadFindOpen("MAT") === false, "open flag is false for a different book");
saveFindOpen("ZEC", false);
check(loadFindOpen("ZEC") === false, "clearing the open flag reloads false");

// --- Deliberate close wipes both (next Ctrl+F starts blank) ---
installStorage();
saveFindOpen("ZEC", true);
saveFindDraft("ZEC", DRAFT);
clearFindState();
check(loadFindOpen("ZEC") === false, "clearFindState clears the open flag");
check(loadFindDraft("ZEC").find === "", "clearFindState clears the draft");

// --- No storage available: no throw, safe empty defaults ---
delete globalThis.sessionStorage;
check(loadFindOpen("ZEC") === false, "loadFindOpen tolerates missing sessionStorage");
check(loadFindDraft("ZEC").find === "", "loadFindDraft tolerates missing sessionStorage");
saveFindOpen("ZEC", true); // must not throw
saveFindDraft("ZEC", DRAFT); // must not throw
clearFindState(); // must not throw
check(true, "save/clear tolerate missing sessionStorage");

// --- Corrupt stored JSON degrades to empty, not a throw ---
const map = installStorage();
map.set("be:find-draft", "{not json");
check(loadFindDraft("ZEC").find === "", "corrupt draft JSON degrades to empty");

console.log(`findState: all ${passed} checks passed.`);
