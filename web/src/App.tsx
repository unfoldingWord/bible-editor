// NB: src/spikes/AlignerSmoke.tsx is intentionally NOT imported.
// Aligner integration is deferred to Phase 3 — see docs/plan.md.
import { useEffect, useState } from "react";
import { Alert, Box, Button, CircularProgress, Snackbar, Stack, Typography } from "@mui/material";
import { Shell } from "./components/Shell";
import { useBook } from "./hooks/useBook";
import { devSignIn, getAuthToken, onAuthError, setAuthToken } from "./sync/api";

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
// have one before mounting the editor — otherwise every save 401s.
//
// Boot sequence:
//   1. If the URL has ?_auth=<token> (DCS OAuth callback), store it and clean URL.
//   2. If a token is already in localStorage, skip straight to ready.
//   3. In dev mode (import.meta.env.DEV), silently mint via /api/auth/dev.
//   4. Otherwise redirect to /api/auth/dcs/start (production OAuth flow).
type AuthState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "missing" }   // DCS OAuth available — show sign-in button
  | { kind: "error"; message: string };

function useAuthGate(): AuthState {
  const [state, setState] = useState<AuthState>(() => {
    // Step 1: absorb token from DCS OAuth callback.
    const params = new URLSearchParams(location.search);
    const urlToken = params.get("_auth");
    if (urlToken) {
      setAuthToken(urlToken);
      history.replaceState(null, "", location.pathname + location.hash);
      return { kind: "ready" };
    }
    return getAuthToken() ? { kind: "ready" } : { kind: "loading" };
  });

  useEffect(() => {
    if (state.kind !== "loading") return;
    let cancelled = false;

    if (import.meta.env.DEV) {
      // Step 3: silent dev mint — only when DEV_AUTH_ENABLED=true on the worker.
      devSignIn("dev")
        .then(() => { if (!cancelled) setState({ kind: "ready" }); })
        .catch((err: unknown) => {
          if (cancelled) return;
          const status = (err as { status?: number })?.status;
          // 404 = DEV_AUTH_ENABLED is false; fall through to the sign-in button.
          if (status === 404) setState({ kind: "missing" });
          else setState({ kind: "error", message: String(err) });
        });
    } else {
      // Step 4: production — hand off to DCS OAuth.
      setState({ kind: "missing" });
    }

    return () => { cancelled = true; };
  }, [state.kind]);

  return state;
}

export function App() {
  const [loc, setLoc] = useState<Location>(() => parseHash());
  const auth = useAuthGate();
  const [sessionExpired, setSessionExpired] = useState(false);
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

  useEffect(() => onAuthError(() => setSessionExpired(true)), []);

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
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100vh" }} spacing={2}>
        <Typography variant="h6">Sign in to continue</Typography>
        <Button variant="contained" href="/api/auth/dcs/start" size="large">
          Sign in with Door43
        </Button>
      </Stack>
    );
  }
  if (auth.kind === "error") {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="error">auth failed: {auth.message}</Alert>
      </Box>
    );
  }

  const handleReSignIn = () => {
    setAuthToken(null);
    if (import.meta.env.DEV) {
      location.reload();
    } else {
      location.href = "/api/auth/dcs/start";
    }
  };

  return (
    <>
      <Shell
        key={`${loc.book}-${loc.chapter}-${loc.verse}`}
        book={loc.book}
        chapter={loc.chapter}
        initialVerse={loc.verse}
        onNavigate={navigate}
        bookHook={bookHook}
        onLogout={handleReSignIn}
      />
      <Snackbar
        open={sessionExpired}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Alert
          severity="warning"
          variant="filled"
          action={
            <Button color="inherit" size="small" onClick={handleReSignIn}>
              Sign in
            </Button>
          }
        >
          Your session expired — sign in to keep saving. Queued edits will sync after sign-in.
        </Alert>
      </Snackbar>
    </>
  );
}
