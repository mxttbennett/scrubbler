# scrobble-scrubber

Headless Last.fm metadata cleaner. TypeScript (strict, ESM), Node 22, better-sqlite3 + Drizzle,
vitest. Modelled on the sibling `feed1` service; same conventions apply unless noted here.

## Layout

| Path | What lives there |
|---|---|
| `src/core/` | zod-validated env config |
| `src/rules/` | the marker catalogue and the **pure** title engine; no I/O |
| `src/lastfm/` | read API client, web session + cookie jar, page parsing, the edit writer |
| `src/scrub/` | planner (sweep), resolver (candidates → tuples), executor, worker loop |
| `src/db/` | Drizzle schema; migrations in `drizzle/` applied at startup |
| `src/report/` | journald logging + Discord webhook |

## Invariants

These five are the things a newcomer gets wrong. Each one was found the hard way.

- **The marker catalogue is closed, and patterns match the WHOLE trailing segment.** Never add a
  substring or shape-based match. A survey of the real library found most trailing segments are
  genuine content (`Pt. II`, `Reprise`, `Live in Rotterdam 1984`, `Taylor's Version`), and only
  full-segment anchoring distinguishes `(Live)` from `(Live in Rotterdam 1984)`. The upstream
  userscript's `detectSuffixPatterns` heuristic is the anti-pattern: it works only because a human
  ticks each box.
- **`+noredirect` on every library URL, tracks and albums alike.** Without it Last.fm 301s to a
  canonical form that is *lowercased*, and a casing-only difference makes the `*_original` tuple
  stop matching — while Last.fm also rejects casing-only edits, so the write silently no-ops.
- **Group into 4-tuples before computing the change.** The `*_original` 4-tuple is the edit's WHERE
  clause, so two POSTs against one tuple cannot both land — the first rewrites what the second
  selects on. `Resolver.fold` merges track and album cleanups for a tuple into one request.
- **Never send a `Mozilla/5.0`-prefixed User-Agent.** Last.fm answers those with `406` and an ~8KB
  error page that still carries `<title>Login | Last.fm</title>`, so it reads as a real page. Verify
  by looking for `csrfmiddlewaretoken`, not by the title.
- **HTTP status cannot detect auth state.** Wrong password → `200`. Successful login → `302`.
  Missing `Referer` → also `302`, with `csrftoken` cleared. The auth probe 302s either way and only
  the `Location` distinguishes them. `Session.isAuthenticated` is the single place that logic lives.
- **Pace library page reads, and detect the throttle by content.** Last.fm soft-throttles the web
  pages with an HTTP `200` page reading "You're requesting too many pages" — no `429`, no
  `Retry-After`. `LibraryPages` owns a 1.5s rate limiter and `isThrottled()`; never bypass either.
  The JSON API and the web pages are separate rate-limit domains, and the web one is far tighter:
  4 req/s is fine for the API, 1.5s spacing still got throttled on the pages, so the default is 15s.
- **Never skip an edit because an automatic-edit rule exists.** A rule created without "apply to all
  past scrobbles" corrects only future ones, so a still-dirty title is evidence the edit is *needed*.
  Rules are read for reporting only; `applied_edits` is the sole dedupe.
- **Writes are serial, and success is not implied by `200`.** Parallel writes produce inconsistent
  results, and Last.fm returns `200` for an accepted-but-no-op edit — hence `VERIFY_EDITS`, and the
  delay before verifying, because it serves stale rows briefly after a write.

## Wire contract

`POST /user/<username>/library/edit-track?edited-variation=library-track-scrobble` — note
`edit-track`, not `edit`; the userscript's hardcoded path is stale. Two steps: a library row's
`form[data-edit-scrobble]` gives six fields, and POSTing those **plus `ajax=1` in the body** returns
the real edit form. Full field set, including the `submit=edit-scrobble` field the userscript never
names, is in `src/lastfm/editor.ts`.

Automatic-edit rules live at two separate URLs:
`/settings/subscription/automatic-edits/albums` (unpaginated) and `.../tracks` (paginated).

## Testing

Seams are constructor-injected (`sleep`, `fetchImpl`, `log`, `statePath`) rather than module-mocked.
No network in tests. `test/rules/engine.test.ts` runs against
`test/fixtures/lfm-title-corpus.json` — a real library snapshot — and **snapshots the full verdict**.
That snapshot is the safety net: read its diff on every catalogue change. It has already caught two
regressions that the unit cases missed.

## Loop

```sh
npm run dev -- --once  # one sweep against the real account (respects DRY_RUN)
npm test
npm run typecheck
npm run lint
npm run db:generate -- --name <what_it_does>   # always pass --name
```
