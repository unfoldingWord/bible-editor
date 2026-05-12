// NB: src/spikes/AlignerSmoke.tsx is intentionally NOT imported.
// Aligner integration is deferred to Phase 3 — see docs/plan.md.
import { useEffect, useState } from "react";
import { Shell } from "./components/Shell";
import { useBook } from "./hooks/useBook";

interface Location {
  book: string;
  chapter: number;
  verse: number;
}

function parseHash(): Location {
  const m = location.hash.match(/^#\/?([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?/);
  if (!m) return { book: "ZEC", chapter: 1, verse: 1 };
  return {
    book: m[1].toUpperCase(),
    chapter: m[2] ? parseInt(m[2], 10) : 1,
    verse: m[3] ? parseInt(m[3], 10) : 1,
  };
}

export function App() {
  const [loc, setLoc] = useState<Location>(() => parseHash());
  // useBook is hoisted here so its chapter cache survives Shell remounts
  // (which happen when the user navigates between chapters via the URL).
  // It's enabled at the App level so the BookSummary loads up-front; the
  // per-chapter payloads stay lazy.
  const bookHook = useBook(loc.book, true);

  useEffect(() => {
    const handler = () => setLoc(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const navigate = (book: string, chapter: number, verse?: number) => {
    location.hash =
      verse !== undefined && verse > 1
        ? `#/${book}/${chapter}/${verse}`
        : `#/${book}/${chapter}`;
  };

  return (
    <Shell
      key={`${loc.book}-${loc.chapter}-${loc.verse}`}
      book={loc.book}
      chapter={loc.chapter}
      initialVerse={loc.verse}
      onNavigate={navigate}
      bookHook={bookHook}
    />
  );
}
