import { useEffect, useRef, useState } from "react";
import { Alert, Box, Button, CircularProgress, Link, Snackbar, Stack, Typography } from "@mui/material";
import { Shell } from "./components/Shell";
import { ArticleWorkspace } from "./components/ArticleWorkspace";
import { PreferencesWorkspace } from "./components/PreferencesWorkspace";
import { useBook } from "./hooks/useBook";
import { useAlerts } from "./hooks/useAlerts";
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
import { setPipelineUser } from "./sync/pipelineStore";

type PrefsSection = "brief" | "instructions" | "terminology" | "examples";
const PREFS_SECTIONS: PrefsSection[] = ["brief", "instructions", "terminology", "examples"];

type Location =
  | { view: "chapter"; book: string; chapter: number; verse: number }
  | { view: "article"; resource: "tw" | "ta"; articleId: string | null }
  | { view: "preferences"; section: PrefsSection };

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
  const pm = location.hash.match(/^#\/preferences(?:\/(\w+))?$/);
  if (pm) {
    const s = pm[1] as PrefsSection | undefined;
    return { view: "preferences", section: s && PREFS_SECTIONS.includes(s) ? s : "brief" };
  }
  const am = location.hash.match(/^#\/articles\/(tw|ta)(?:\/(.+))?$/);
  if (am) {
    return {
      view: "article",
      resource: am[1] as "tw" | "ta",
      articleId: decodeURIComponent(am[2] ?? "") || null,
    };
  }
  const m = location.hash.match(/^#\/?([A-Za-z0-9]+)(?:\/(\d+))?(?:\/(\d+))?/);
  if (!m) return { view: "chapter", book: DEFAULT_BOOK, chapter: 1, verse: 1 };
  return {
    view: "chapter",
    book: m[1].toUpperCase(),
    chapter: m[2] ? parseInt(m[2], 10) : 1,
    verse: m[3] ? parseInt(m[3], 10) : 1,
  };
}

function isDefaultLoc(l: Location): boolean {
  return l.view === "chapter" && l.book === DEFAULT_BOOK && l.chapter === 1 && l.verse === 1;
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
  const bookHook = useBook(
    loc.view === "chapter" ? loc.book : DEFAULT_BOOK,
    auth.kind === "ready" && loc.view === "chapter",
  );

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
    if (auth.kind !== "ready" || loc.view !== "chapter") return;
    const { book, chapter, verse } = loc;
    const t = setTimeout(() => {
      void updateLastLocation(book, chapter, verse);
    }, 1500);
    return () => clearTimeout(t);
  }, [auth.kind, loc]);

  // Must run before any of the early returns below — otherwise the hook is
  // conditionally invoked across renders (loading → ready calls one extra
  // hook), which violates Rules of Hooks. The hook itself no-ops while
  // auth is not "ready".
  const { alerts, dismiss } = useAlerts(auth.kind === "ready");

  useEffect(() => {
    setPipelineUser(auth.kind === "ready" ? auth.me?.userId ?? null : null);
  }, [auth]);

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
    setLoc({ view: "chapter", book: DEFAULT_BOOK, chapter: 1, verse: 1 });
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
      {alerts.length > 0 && (
        // Float the alert stack so it doesn't push Shell down — the outer
        // flex column's children can't actually shrink (Shell's internal
        // box rejects flex:1 minHeight:0 sizing), and any added in-flow
        // height makes <html> scroll the banner above the viewport.
        // Fixed positioning keeps the banner visible regardless of scroll
        // state and accepts the tradeoff of obscuring the top 44px of the
        // TopBar — appropriate UX for a "Benjamin fix this" alert.
        <Box
          sx={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: (theme) => theme.zIndex.appBar + 2,
          }}
        >
          {alerts.map((a) => (
            <Alert
              key={a.id}
              severity={a.severity}
              variant="filled"
              onClose={() => void dismiss(a.id)}
              sx={{ borderRadius: 0, py: 0.5 }}
            >
              {a.message}
              {a.linkUrl && (
                <>
                  {" — "}
                  <Link
                    href={a.linkUrl}
                    target="_blank"
                    rel="noopener"
                    color="inherit"
                    underline="always"
                  >
                    view run
                  </Link>
                </>
              )}
            </Alert>
          ))}
        </Box>
      )}
      {isViewer && (
        <Alert severity="info" variant="filled" sx={{ borderRadius: 0, py: 0.5 }}>
          You're signed in as an <strong>unfoldingWord</strong> member — read-only access.
          Edits won't be saved. Ask an admin to add you to the editor allowlist if you need to edit.
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0 }}>
        {loc.view === "preferences" ? (
          <PreferencesWorkspace
            section={loc.section}
            onNavigate={(s) => {
              location.hash = `#/preferences/${s}`;
            }}
          />
        ) : loc.view === "article" ? (
          <ArticleWorkspace
            resource={loc.resource}
            articleId={loc.articleId}
            onNavigate={(r, a) => {
              // Empty articleId (e.g. switching resource with nothing selected)
              // must not emit a trailing slash — `#/articles/ta/` fails the
              // article regex and misparses as a chapter.
              location.hash = a ? `#/articles/${r}/${encodeURIComponent(a)}` : `#/articles/${r}`;
            }}
          />
        ) : (
          <Shell
            key={loc.book}
            book={loc.book}
            chapter={loc.chapter}
            initialVerse={loc.verse}
            onNavigate={navigate}
            bookHook={bookHook}
            onLogout={handleSignOut}
            meUserId={auth.kind === "ready" ? auth.me?.userId ?? null : null}
          />
        )}
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
