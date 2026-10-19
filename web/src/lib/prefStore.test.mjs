// Tests for prefStore.ts — per-browser display prefs shared by every control
// that shows them (issue #1228). Run from web/:
//   node --experimental-strip-types --no-warnings src/lib/prefStore.test.mjs

let failed = 0;
let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    passed++;
  }
}

// Node has no window/localStorage: stub both before the store is loaded.
const backing = new Map();
let throwOnSet = false;
globalThis.localStorage = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => {
    if (throwOnSet) throw new Error("QuotaExceededError");
    backing.set(k, String(v));
  },
  removeItem: (k) => backing.delete(k),
};
const storageHandlers = [];
globalThis.window = {
  addEventListener: (type, fn) => {
    if (type === "storage") storageHandlers.push(fn);
  },
};
const fireStorage = (key, newValue) => storageHandlers.forEach((fn) => fn({ key, newValue }));

const { readPref, writePref, subscribePref, parseBoolPref, PREF_COLUMNS_EMPHASIZE_ACTIVE } = await import(
  "./prefStore.ts"
);

// ── parseBoolPref ───────────────────────────────────────────────────────────
assert(parseBoolPref(null, true) === true, "missing value → default true");
assert(parseBoolPref(null, false) === false, "missing value → default false");
assert(parseBoolPref("0", true) === false, '"0" is off');
assert(parseBoolPref("1", false) === true, '"1" is on');
assert(parseBoolPref("garbage", true) === true, "unknown value → default");

// The key is the one PR #1226 already wrote, so saved choices carry over.
assert(PREF_COLUMNS_EMPHASIZE_ACTIVE === "be:columnsEmphasizeActive", "key unchanged from #1226");

// ── read existing value ─────────────────────────────────────────────────────
backing.set("be:a", "0");
assert(readPref("be:a") === "0", "reads a value already in localStorage");
assert(readPref("be:missing") === null, "absent key reads null");
assert(storageHandlers.length === 0, "no window listener installed until something subscribes");

// ── same-tab write notifies subscribers of that key only ────────────────────
let aCalls = 0;
let bCalls = 0;
const unsubA = subscribePref("be:a", () => aCalls++);
subscribePref("be:b", () => bCalls++);
assert(storageHandlers.length === 1, "subscribing installs one storage listener");
subscribePref("be:a", () => {});
assert(storageHandlers.length === 1, "a second subscriber does not add another listener");

writePref("be:a", "1");
assert(aCalls === 1, "write notifies the key's subscriber in the same tab");
assert(bCalls === 0, "write does not notify other keys");
assert(readPref("be:a") === "1", "read returns the new value after write");
assert(backing.get("be:a") === "1", "write persists to localStorage");

// ── another tab's write arrives as a storage event ──────────────────────────
backing.set("be:a", "0"); // the other tab already wrote it
fireStorage("be:a", "0");
assert(aCalls === 2, "storage event notifies the key's subscriber");
assert(readPref("be:a") === "0", "read returns the other tab's value");
fireStorage("be:other", "1");
assert(aCalls === 2 && bCalls === 0, "storage event for an unrelated key notifies nobody here");
// localStorage.clear() in another tab arrives with key === null.
backing.clear();
fireStorage(null, null);
assert(aCalls === 3 && bCalls === 1, "clear() notifies every key");
assert(readPref("be:a") === null, "after clear() the value reads as absent");

// ── unsubscribe ─────────────────────────────────────────────────────────────
unsubA();
writePref("be:a", "1");
assert(aCalls === 3, "unsubscribed listener is not called");

// ── storage that refuses writes (private mode / quota) ──────────────────────
throwOnSet = true;
let cCalls = 0;
subscribePref("be:c", () => cCalls++);
writePref("be:c", "0");
assert(cCalls === 1, "write still notifies when localStorage throws");
assert(readPref("be:c") === "0", "write still takes effect in this tab when localStorage throws");
throwOnSet = false;

console.log(`prefStore: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
