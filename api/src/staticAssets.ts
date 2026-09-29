// Serves /assets/* (Vite's content-hashed bundle) for the Worker. See issue #916.
//
// wrangler.toml routes /assets/* through the Worker (run_worker_first) because
// Workers Static Assets' `not_found_handling = "single-page-application"` is a
// global setting: without the Worker in the path, a request for a chunk that
// no longer exists (e.g. an old tab after a deploy) got 200 index.html plus
// the `immutable` Cache-Control that _headers sets for /assets/*, letting a
// browser or edge cache pin HTML under a .js URL for a year.
//
// env.ASSETS.fetch still applies the SPA fallback, so a miss shows up here as
// a text/html response. Real assets are returned unchanged, keeping the
// _headers Cache-Control.
export async function serveHashedAsset(req: Request, assets: Fetcher | undefined): Promise<Response> {
  if (assets) {
    const res = await assets.fetch(req);
    if (!(res.headers.get("Content-Type") ?? "").toLowerCase().startsWith("text/html")) return res;
    await res.body?.cancel();
  }
  return new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
