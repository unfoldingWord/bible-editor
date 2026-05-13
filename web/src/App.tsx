// NB: src/spikes/AlignerSmoke.tsx is intentionally NOT imported.
// Aligner integration is deferred to Phase 3 — see docs/plan.md.
import { useEffect, useState } from "react";
import { Alert, Box, CircularProgress, Stack, Typography } from "@mui/material";
import { Shell } from "./components/Shell";
import { useBook } from "./hooks/useBook";
import { devSignIn, getAuthToken } from "./sync/api";

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

// Auth gate. The API requires a Bearer token for every write, so we must
// have one before mounting the editor — otherwise every save 401s. In dev
// we silently mint a token via /api/auth/dev; once DCS OAuth ships this
// branch redirects there instead.
type AuthState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

function useAuthGate(): AuthState {
  const [state, setState] = useState<AuthState>(() =>
    getAuthToken() ? { kind: "ready" } : { kind: "loading" },
  );
  useEffect(() => {
    if (state.kind !== "loading") return;
    let cancelled = false;
    devSignIn("dev")
      .then(() => {
        if (!cancelled) setState({ kind: "ready" });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // /api/auth/dev returns 404 when DEV_AUTH_ENABLED is false; treat
        // that as "you need to sign in" rather than a hard error so prod
        // can swap in a real OAuth redirect later.
        const status = (err as { status?: number })?.status;
        if (status === 404) setState({ kind: "missing" });
        else setState({ kind: "error", message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [state.kind]);
  return state;
}

export function App() {
  const [loc, setLoc] = useState<Location>(() => parseHash());
  const auth = useAuthGate();
  // useBook is hoisted here so its chapter cache survives Shell remounts
  // (which happen when the user navigates between chapters via the URL).
  // Don't initialize it until auth is ready — the BookSummary fetch is now
  // gated and would otherwise burn a 401 every reload.
  const bookHook = useBook(loc.book, auth.kind === "ready");

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

  if (auth.kind === "loading") {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100vh" }} spacing={2}>
        <CircularProgress />
        <Typography variant="body2" color="text.secondary">signing in…</Typography>
      </Stack>
    );
  }
  if (auth.kind === "missing") {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="warning">
          Sign-in required. The dev token endpoint is disabled — wire DCS OAuth or set
          DEV_AUTH_ENABLED=true on the worker.
        </Alert>
      </Box>
    );
  }
  if (auth.kind === "error") {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="error">auth failed: {auth.message}</Alert>
      </Box>
    );
  }

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
