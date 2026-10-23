// Plain-language reason for a failed IndexedDB write (#1196 follow-up), so a
// "could not be stored on this device" toast says why instead of leaving the
// translator to guess. Errors arrive as DOMExceptions; match on `name`.
export function storageFailureReason(e: unknown): string {
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
  switch (name) {
    case "QuotaExceededError":
      return "this browser's storage is full";
    case "DataCloneError":
      return "the alignment holds data the browser can't store; please report this verse";
    case "InvalidStateError":
    case "TransactionInactiveError":
    case "AbortError":
    case "UnknownError":
      return "the browser's local save store stopped responding; refreshing the page usually fixes this, but copy down any changes first";
    default:
      return name ? `browser error: ${name}` : "unknown browser error";
  }
}
