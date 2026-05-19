// NB: src/spikes/AlignerSmoke.tsx is intentionally NOT imported.
// Aligner integration is deferred to Phase 3 — see docs/plan.md.
import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, CircularProgress, Snackbar, Stack, Typography } from "@mui/material";
import { Shell } from "./components/Shell";
import { useBook } from "./hooks/useBook";
import {
  authLogout,
  devSignIn,
  fetchAuthMe,
  getAuthToken,
  onAuthError,
  setAuthToken,
  setReadOnly,
  updateLastLocation,
  type MeResponse,
  type Role,
} from "./sync/api";

interface Location {
  book: string;
  chapter: number;
  verse: number;
}

// OBA (Obadiah) is the shortest book in the canon — one chapter, 21 verses.
// Loads faster than ZEC on a cold cache and keeps the default landing page
// snappy. Bookmarks / direct links still win because parseHash only falls
// back to this when no hash is present.
const DEFAULT_BOOK = "OBA";

// Set when the user explicitly clicks "Sign out". Read at boot to suppress
// the dev-mode silent re-mint and show the signed-out screen instead.
const SIGNED_OUT_KEY = "bible-editor.signed_out";

function parseHash(): Location {
  const m = location.hash.match(/^#\/?([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?/);
  if (!m) return { book: DEFAULT_BOOK, chapter: 1, verse: 1 };
  return {
    book: m[1].toUpperCase(),
    chapter: m[2] ? parseInt(m[2], 10) : 1,
    verse: m[3] ? parseInt(m[3], 10) : 1,
  };
}

function isDefaultLoc(l: Location): boolean {
  return l.book === DEFAULT_BOOK && l.chapter === 1 && l.verse === 1;
}

// Auth gate. The API requires a Bearer token for every write, so we must
// have one before mounting the editor — otherwise every save 401s.
//
// Boot sequence:
//   1. If localStorage has the signed-out flag, show the signed-out screen
//      (suppresses dev silent re-mint after an explicit logout).
//   2. If the URL has ?_auth_denied=1, the OAuth callback rejected this DCS
//      account (not on the editor allowlist). Show the denied screen.
//   3. If the URL has #_auth=<token> (DCS OAuth callback success), store it
//      and strip the fragment, then verify the role via /api/auth/me.
//   4. If a token is already in localStorage, verify via /api/auth/me.
//   5. In dev mode (import.meta.env.DEV), silently mint via /api/auth/dev.
//   6. Otherwise show the sign-in button (production OAuth flow).
type AuthState =
  | { kind: "loading" }
  | { kind: "verifying" }                          // have a token; checking role
  | { kind: "ready"; me: MeResponse | null; role: Role }
  | { kind: "signed_out" }                         // explicit logout; awaits sign-in click
  | { kind: "missing" }                            // DCS OAuth available — show sign-in button
  | { kind: "denied"; username: string | null }    // signed in but not on editor allowlist
  | { kind: "error"; message: string };

function isSignedOut(): boolean {
  try {
    return localStorage.getItem(SIGNED_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

function clearSignedOutFlag() {
  try {
    localStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    /* private mode */
  }
}

function useAuthGate(): [AuthState, (s: AuthState) => void] {
  const [state, setState] = useState<AuthState>(() => {
    const params = new URLSearchParams(location.search);

    // Step 2: OAuth callback rejected this account (not on the allowlist).
    if (params.get("_auth_denied")) {
      const username = params.get("u");
      history.replaceState(null, "", location.pathname + location.hash);
      return { kind: "denied", username };
    }

    // Step 3: absorb token from DCS OAuth callback (clears any stale
    // signed-out flag — a successful OAuth callback is an explicit sign-in).
    // The token rides in the URL fragment (#_auth=...) so it never hits
    // browser history, the Referer header, or edge logs — fragments are
    // browser-only. Note this prefix can never collide with the hash router
    // (which always starts "#/", e.g. "#/ZEC/1/1"); the leading underscore
    // also means parseHash's [A-Za-z0-9] capture won't match it.
    const hash = location.hash;
    let urlToken: string | null = null;
    if (hash.startsWith("#_auth=")) {
      try {
        urlToken = decodeURIComponent(hash.slice("#_auth=".length));
      } catch {
        urlToken = null;
      }
    }
    if (urlToken) {
      clearSignedOutFlag();
      setAuthToken(urlToken);
      history.replaceState(null, "", location.pathname + location.search);
      return { kind: "verifying" };
    }

    // Step 1: explicit logout takes precedence over any leftover token in
    // localStorage. Token survives only as a fallback for the (rare) case
    // where logout's POST failed before the client could clear it.
    if (isSignedOut()) return { kind: "signed_out" };

    return getAuthToken() ? { kind: "verifying" } : { kind: "loading" };
  });

  // verifying → ready/denied/error. Single fetch of /api/auth/me; the role
  // claim is also in the JWT so we trust the response.
  useEffect(() => {
    if (state.kind !== "verifying") return;
    let cancelled = false;
    fetchAuthMe()
      .then((me) => {
        if (cancelled) return;
        if (!me) {
          setState({ kind: "loading" });
          return;
        }
        if (me.role === "admin" || me.role === "editor" || me.role === "viewer") {
          setReadOnly(me.role === "viewer");
          setState({ kind: "ready", me, role: me.role });
        } else if (import.meta.env.DEV) {
          // Dev convenience: a stale token from before the role claim was
          // added has role=null. Drop it and let the loading branch silently
          // re-mint via /api/auth/dev with a fresh role claim.
          setAuthToken(null);
          setState({ kind: "loading" });
        } else {
          setState({ kind: "denied", username: me.username });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { status?: number })?.status;
        if (status === 401) {
          // Token bad / refresh path failed. Clear and start over.
          setAuthToken(null);
          setState({ kind: "loading" });
        } else if (status === 403) {
          setState({ kind: "denied", username: null });
        } else {
          setState({ kind: "error", message: String(err) });
        }
      });
    return () => { cancelled = true; };
  }, [state.kind]);

  useEffect(() => {
    if (state.kind !== "loading") return;
    let cancelled = false;

    if (import.meta.env.DEV) {
      // Step 5: silent dev mint — only when DEV_AUTH_ENABLED=true on the worker.
      devSignIn("dev")
        .then(async (resp) => {
          if (cancelled) return;
          if (resp.role !== "admin" && resp.role !== "editor" && resp.role !== "viewer") {
            setState({ kind: "denied", username: resp.username });
            return;
          }
          setReadOnly(resp.role === "viewer");
          // devSignIn doesn't return last_* — pull it separately so we can
          // hydrate the view. Failure here is non-fatal: the user just lands
          // on the URL hash (or the default book).
          const me = await fetchAuthMe().catch(() => null);
          setState({ kind: "ready", me, role: resp.role });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const status = (err as { status?: number })?.status;
          // 404 = DEV_AUTH_ENABLED is false; fall through to the sign-in button.
          if (status === 404) setState({ kind: "missing" });
          else setState({ kind: "error", message: String(err) });
        });
    } else {
      // Step 6: production — show the sign-in button (user must click to OAuth).
      setState({ kind: "missing" });
    }

    return () => { cancelled = true; };
  }, [state.kind]);

  return [state, setState];
}

export function App() {
  const [loc, setLoc] = useState<Location>(() => parseHash());
  const [auth, setAuth] = useAuthGate();
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

  // Hydrate from server-side last-position. Fires once per auth session,
  // only when `loc` is the default book — a bookmarked deep link (which
  // makes `loc` non-default on mount) always wins. Reset on sign-out so the
  // next sign-in re-hydrates instead of stranding the user on the default.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (auth.kind !== "ready" || hydratedRef.current) return;
    hydratedRef.current = true;
    const me = auth.me;
    if (!me?.lastBook || me.lastChapter === null || me.lastVerse === null) return;
    if (!isDefaultLoc(loc)) return;
    navigate(me.lastBook, me.lastChapter, me.lastVerse);
  }, [auth, loc]);

  // Debounced push of the current location to the server so the next sign-in
  // on a different device / after a logout can land back here.
  useEffect(() => {
    if (auth.kind !== "ready") return;
    const t = setTimeout(() => {
      void updateLastLocation(loc.book, loc.chapter, loc.verse);
    }, 1500);
    return () => clearTimeout(t);
  }, [auth.kind, loc.book, loc.chapter, loc.verse]);

  if (auth.kind === "loading" || auth.kind === "verifying") {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100vh" }} spacing={2}>
        <CircularProgress />
        <Typography variant="body2" color="text.secondary">signing in…</Typography>
      </Stack>
    );
  }
  if (auth.kind === "signed_out") {
    const handleSignIn = () => {
      clearSignedOutFlag();
      if (import.meta.env.DEV) {
        setAuth({ kind: "loading" });
      } else {
        location.href = "/api/auth/dcs/start";
      }
    };
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100vh" }} spacing={2}>
        <Typography variant="h6">You're signed out</Typography>
        <Typography variant="body2" color="text.secondary">
          Queued edits stay in your browser until you sign back in.
        </Typography>
        <Button variant="contained" onClick={handleSignIn} size="large">
          {import.meta.env.DEV ? "Sign in (dev)" : "Sign in with Door43"}
        </Button>
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
  if (auth.kind === "denied") {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100vh", px: 4 }} spacing={2}>
        <Typography variant="h6">Not authorized</Typography>
        <Typography variant="body2" color="text.secondary" textAlign="center" sx={{ maxWidth: 480 }}>
          {auth.username
            ? `Your DCS account "${auth.username}" isn't on the editor allowlist for this app yet.`
            : `Your DCS account isn't on the editor allowlist for this app yet.`}
          {" "}If you should have access, ask an admin to add you.
        </Typography>
        <Button
          variant="outlined"
          onClick={() => {
            setAuthToken(null);
            location.href = "/api/auth/dcs/start";
          }}
          size="small"
        >
          Sign in with a different Door43 account
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

  const handleSignOut = async () => {
    // Best-effort server-side cleanup BEFORE we drop the bearer token, so
    // the request actually carries Authorization. We don't await the result
    // for the UI transition — the local token is what gates editing.
    await authLogout();
    setAuthToken(null);
    try {
      localStorage.setItem(SIGNED_OUT_KEY, "1");
    } catch {
      /* private mode */
    }
    // Strip the URL hash too: leaving #/JON/3 around would confuse the next
    // boot into thinking the user requested a specific verse. Mirror that
    // into React state (replaceState doesn't fire hashchange) so the next
    // sign-in's hydration sees loc=default and pulls from the server.
    history.replaceState(null, "", location.pathname);
    setLoc({ book: DEFAULT_BOOK, chapter: 1, verse: 1 });
    hydratedRef.current = false;
    setAuth({ kind: "signed_out" });
  };

  const handleSessionExpired = () => {
    setAuthToken(null);
    if (import.meta.env.DEV) {
      location.reload();
    } else {
      location.href = "/api/auth/dcs/start";
    }
  };

  const isViewer = auth.kind === "ready" && auth.role === "viewer";

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {isViewer && (
        <Alert severity="info" variant="filled" sx={{ borderRadius: 0, py: 0.5 }}>
          You're signed in as an <strong>unfoldingWord</strong> member — read-only access.
          Edits won't be saved. Ask an admin to add you to the editor allowlist if you need to edit.
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Shell
          key={`${loc.book}-${loc.chapter}-${loc.verse}`}
          book={loc.book}
          chapter={loc.chapter}
          initialVerse={loc.verse}
          onNavigate={navigate}
          bookHook={bookHook}
          onLogout={handleSignOut}
        />
      </Box>
      <Snackbar
        open={sessionExpired}
        anchorOrigin={{ vertical: "top", horizontal: "center" }}
      >
        <Alert
          severity="warning"
          variant="filled"
          action={
            <Button color="inherit" size="small" onClick={handleSessionExpired}>
              Sign in
            </Button>
          }
        >
          Your session expired — sign in to keep saving. Queued edits will sync after sign-in.
        </Alert>
      </Snackbar>
    </Box>
  );
}
