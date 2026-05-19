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
  onAuthError,
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
// This is a UX flag only — auth state lives in HttpOnly cookies and is
// gone by the time we read this. Cleared on next successful sign-in.
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

// Auth gate. The API requires a valid Access cookie for every write, so we
// must have one before mounting the editor — otherwise every save 401s.
//
// Boot sequence:
//   1. If the URL has ?_auth_denied=1, the OAuth callback rejected this DCS
//      account (not on the editor allowlist). Show the denied screen.
//   2. Otherwise call /api/auth/me. The HttpOnly Access cookie is sent
//      automatically; we never see the token itself. On 200 → ready; on
//      401 → fall through.
//   3. If the user explicitly signed out (SIGNED_OUT_KEY), stay in missing
//      — block the dev silent re-mint so the "Sign in with Door43" flow
//      is required after logout.
//   4. In dev mode, attempt /api/auth/dev silent mint. If 404 (disabled)
//      or any other failure → missing.
//   5. In prod, fall straight to missing.
type AuthState =
  | { kind: "loading" }
  | { kind: "ready"; me: MeResponse | null; role: Role }
  | { kind: "missing" }                            // not signed in — show "Sign in with Door43"
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
    // Step 1: OAuth callback rejected this account (not on the allowlist).
    if (params.get("_auth_denied")) {
      const username = params.get("u");
      history.replaceState(null, "", location.pathname + location.hash);
      return { kind: "denied", username };
    }
    return { kind: "loading" };
  });

  // loading → /api/auth/me probe → ready/missing/denied/error. The Access
  // cookie (if any) rides automatically. A successful 200 also clears any
  // stale signed_out flag — implicit "we got back in" signal.
  useEffect(() => {
    if (state.kind !== "loading") return;
    let cancelled = false;
    fetchAuthMe()
      .then(async (me) => {
        if (cancelled) return;
        if (me && (me.role === "admin" || me.role === "editor" || me.role === "viewer")) {
          clearSignedOutFlag();
          setReadOnly(me.role === "viewer");
          setState({ kind: "ready", me, role: me.role });
          return;
        }
        if (me && !me.role) {
          setState({ kind: "denied", username: me.username });
          return;
        }
        // me === null → 401, no cookie. Decide whether to silent-mint (dev)
        // or land on the sign-in screen.
        if (isSignedOut() || !import.meta.env.DEV) {
          setState({ kind: "missing" });
          return;
        }
        try {
          const devMe = await devSignIn("dev");
          if (cancelled) return;
          if (devMe.role !== "admin" && devMe.role !== "editor" && devMe.role !== "viewer") {
            setState({ kind: "denied", username: devMe.username });
            return;
          }
          clearSignedOutFlag();
          setReadOnly(devMe.role === "viewer");
          setState({ kind: "ready", me: devMe, role: devMe.role });
        } catch (err: unknown) {
          if (cancelled) return;
          const status = (err as { status?: number })?.status;
          if (status === 404) {
            // DEV_AUTH_ENABLED=false (e.g. running prod build locally).
            setState({ kind: "missing" });
          } else {
            setState({ kind: "error", message: String(err) });
          }
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { status?: number })?.status;
        if (status === 403) {
          setState({ kind: "denied", username: null });
        } else {
          setState({ kind: "error", message: String(err) });
        }
      });
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

  if (auth.kind === "loading") {
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100vh" }} spacing={2}>
        <CircularProgress />
        <Typography variant="body2" color="text.secondary">signing in…</Typography>
      </Stack>
    );
  }
  if (auth.kind === "missing") {
    // After an explicit logout (signed_out flag set) we surface a "queued
    // edits are safe" reassurance line. First-time visitors with no token
    // see the bare "Sign in to continue" screen instead — they have no
    // queued edits to worry about.
    const wasSignedOut = isSignedOut();
    const devSignInClick = () => {
      clearSignedOutFlag();
      setAuth({ kind: "loading" });
    };
    return (
      <Stack alignItems="center" justifyContent="center" sx={{ height: "100vh" }} spacing={2}>
        <Typography variant="h6">
          {wasSignedOut ? "You're signed out" : "Sign in to continue"}
        </Typography>
        {wasSignedOut && (
          <Typography variant="body2" color="text.secondary">
            Queued edits stay in your browser until you sign back in.
          </Typography>
        )}
        <Button variant="contained" href="/api/auth/dcs/start" size="large">
          Sign in with Door43
        </Button>
        {import.meta.env.DEV && (
          <Button variant="text" size="small" onClick={devSignInClick}>
            Sign in (dev)
          </Button>
        )}
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
            // Server-side: clear cookies via logout, then start the OAuth
            // dance. The user still has to sign out of DCS separately to
            // actually switch accounts (DCS session cookie is sticky).
            void authLogout().finally(() => {
              location.href = "/api/auth/dcs/start";
            });
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
    // Server-side cleanup clears all three session cookies, revokes the
    // session row, and best-effort revokes the DCS access token. Set the
    // local UX flag so the next boot doesn't silent-mint in dev.
    await authLogout();
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
    setAuth({ kind: "missing" });
  };

  const handleSessionExpired = () => {
    // Cookies are still set but the Access token expired and refresh failed
    // (e.g. session revoked). Send the user through OAuth in both dev and
    // prod — there's no silent recovery from this state.
    location.href = "/api/auth/dcs/start";
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
