// Per-book T4T loader: caches parsed books for the session (the text is
// static) and shares one fetch between concurrent callers. A failed load is
// neither cached nor left in flight, so calling again retries (#1262).
export function createT4tLoader<T>(
  fetchText: (book: string) => Promise<string>,
  parse: (book: string, text: string) => T,
): (book: string) => Promise<T> {
  const cache = new Map<string, T>();
  const inflight = new Map<string, Promise<T>>();
  return (book) => {
    const hit = cache.get(book);
    if (hit) return Promise.resolve(hit);
    let p = inflight.get(book);
    if (!p) {
      p = fetchText(book)
        .then((text) => {
          const parsed = parse(book, text);
          cache.set(book, parsed);
          return parsed;
        })
        .finally(() => inflight.delete(book));
      inflight.set(book, p);
    }
    return p;
  };
}
