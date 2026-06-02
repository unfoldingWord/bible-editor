# bible-editor

Tactical web editor for unfoldingWord gateway-language translation work. **7-month lifespan, then archived.**

Replaces the gatewayEdit + tcCreate + DCS-as-source-of-truth pipeline with an editor where:

- Saves land in a database first; **DCS receives nightly snapshot commits**, never live writes.
- Every edit is buffered in an IndexedDB outbox before it leaves the browser, so network blips and unexpected logouts don't lose work.
- Row-level optimistic concurrency lets multiple editors work the same chapter without clobbering each other.
- The UI shows multiple verses and notes at once (Timeline rail · Scripture column · Resource column), with a columns mode for ULT/UST/UHB doc-style editing and an alignment modal for word alignment.

See [`docs/plan.md`](docs/plan.md) for the full design. See [`docs/design/`](docs/design/) for the source UI design bundle.

## Stack

- **Backend**: Cloudflare Workers + Hono router + D1 (SQLite) + R2 + Durable Objects.
- **Frontend**: Vite + React + Material UI v5 (same component family as the legacy tools).
- **Bible data**: `usfm-js` for USFM ↔ JSON round-trip; `enhanced-word-aligner-rcl` for the alignment UI.
- **Auth**: DCS OAuth → our own JWT (long-lived, decoupled from DCS token TTL).

## Dev loop

```sh
# install everything
npm install

# run the API (Workers + Miniflare + local D1) and the web app in parallel
npm run dev
```

The Vite dev server proxies `/api/*` to the local Wrangler instance. Same code runs on Cloudflare in production via `wrangler deploy`.

## Layout

```
api/         Cloudflare Workers backend (Wrangler project)
web/         React + Vite frontend
docs/        plan, design bundle, screenshots
```

## Credits

This project builds on the work of several unfoldingWord open-source repositories:

- **[gateway-edit](https://github.com/unfoldingWord/gateway-edit)** — harmonized book-package editor for gateway-language translation work.
- **[tc-create-app](https://github.com/unfoldingWord/tc-create-app)** — web-based editor for translation notes, questions, and word links.
- **[translationCore](https://github.com/unfoldingWord/translationCore)** — desktop application for checking Bible translations against checking resources.

## License

[MIT](LICENSE) © 2026 unfoldingWord
