import assert from "node:assert/strict";
import { storageFailureReason } from "./storageFailure.ts";

assert.match(storageFailureReason(new DOMException("x", "QuotaExceededError")), /storage is full/);
assert.match(storageFailureReason(new DOMException("x", "DataCloneError")), /report this verse/);
assert.match(storageFailureReason(new DOMException("closing", "InvalidStateError")), /refreshing the page/);
assert.equal(storageFailureReason(new DOMException("x", "NotFoundError")), "browser error: NotFoundError");
assert.equal(storageFailureReason("boom"), "unknown browser error");
assert.equal(storageFailureReason(undefined), "unknown browser error");
console.log("storageFailure: ok");
