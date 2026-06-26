// Translation Words (TW) article helpers — id parsing, Door43 URLs, and a
// session-cached raw-markdown fetch for the in-app article viewer.
//
// Accepts both the short form ("kt/god") the catalog/matcher use and the long
// rc:// link form ("rc://*/tw/dict/bible/kt/god") stored on TWL rows.

const TW_BASE = "https://git.door43.org/unfoldingWord/en_tw";

export interface TwArticleRef {
  cat: string; // "kt" | "names" | "other"
  art: string; // "god", "moab", …
}

export function parseTwId(idOrLink: string | null | undefined): TwArticleRef | null {
  if (!idOrLink) return null;
  const m =
    idOrLink.match(/\/bible\/([^/]+)\/([^/]+?)(?:\.md)?$/) ??
    idOrLink.match(/^([^/]+)\/([^/]+?)(?:\.md)?$/);
  return m ? { cat: m[1], art: m[2] } : null;
}

// rc://*/tw/dict/bible/names/moab → names/moab; bare id passes through.
export function twShort(idOrLink: string | null | undefined): string {
  const ref = parseTwId(idOrLink);
  return ref ? `${ref.cat}/${ref.art}` : idOrLink || "";
}

// Rendered Gitea preview page — the "View on DCS" link target (human-facing).
export function twArticleDcsUrl(idOrLink: string | null | undefined): string {
  const ref = parseTwId(idOrLink);
  return ref ? `${TW_BASE}/src/branch/master/bible/${ref.cat}/${ref.art}.md` : "";
}

// Raw markdown — what the in-app viewer fetches and renders.
export function twArticleRawUrl(idOrLink: string | null | undefined): string {
  const ref = parseTwId(idOrLink);
  return ref ? `${TW_BASE}/raw/branch/master/bible/${ref.cat}/${ref.art}.md` : "";
}

// Door43 serves raw .md with permissive CORS (node-twl-generator relies on the
// same), so the browser can fetch articles directly. Cache per session — the
// articles are immutable for the life of a tab.
const cache = new Map<string, Promise<string>>();

export function fetchTwArticle(idOrLink: string): Promise<string> {
  const url = twArticleRawUrl(idOrLink);
  if (!url) return Promise.reject(new Error("unrecognized TW article id"));
  let pending = cache.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .catch((err) => {
        cache.delete(url); // don't cache failures — allow retry on reopen
        throw err;
      });
    cache.set(url, pending);
  }
  return pending;
}
