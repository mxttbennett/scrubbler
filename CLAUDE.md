# scrubbler

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
| `src/report/` | journald logging + REST-only Discord bot (no gateway, so it shows offline) |

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
- **An album rename uses `edit-album`, not N `edit-track` calls.** `?edited-variation=` has two
  values; `library-album-scrobble` posts to `/library/edit-album` and needs only the album name and
  album artist pairs — no timestamp, no track, no `edit_all`. Album candidates therefore never
  recurse into track pages. `edit-track` is for when a *track title* carries a marker.
- **Albums are swept before tracks and that order is load-bearing.** The album rename lands first, so
  a track page read afterwards already shows the clean album name and the track edit's
  `album_name_original` cannot go stale and silently no-op. `test/scrub/albumFirst.test.ts` fails if
  the order changes.
- **Discovery is incremental by default.** A cursor over `getRecentTracks` replaces re-sweeping 49k
  entities, because `create_automatic_edit_rule` means new dirty entities can only arrive with new
  scrobbles. A weekly full sweep is the completeness guarantee. The cursor advances only after a
  completed cycle. Candidates that resolve to nothing are remembered — that repeated paced page
  fetch, not the API calls, is the real cost.
- **Shutdown drains.** `stop()` resolves once the in-flight edit *and its verification* have
  finished; never go back to flipping a flag and exiting, or a deploy can change Last.fm without
  recording it.
- **One request per tuple, carrying every field that changes.** The `*_original` 4-tuple is the
  edit's WHERE clause, so two POSTs against one tuple cannot both land — the first rewrites what the
  second selects on. `Resolver.fold` therefore derives the *complete* change for a tuple (track and
  album title together) from a single row. Because it is complete, writes stream as tuples resolve;
  do not batch them up "to merge later", there is nothing left to merge.
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
  4 req/s is fine for the API, 1.5s spacing still got throttled on the pages, so the default is
  15s with 5s of jitter. The jitter is **not** camouflage — the User-Agent names this service. It
  decorrelates the cadence from a fixed rate-limit window and stops requests re-synchronising after
  a shared backoff.
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

## Writes

- **One `WriteLock` per process, and every Last.fm write goes through it.** The worker, an approval
  click and a slash command are three independent writers; Last.fm returns `200` for a no-op edit, so
  an interleaved write is misreported as success rather than merely delayed.
- The lock is **not re-entrant** by design — a depth counter cannot tell a nested acquire from a
  second caller arriving while it is held, and the permissive guess allows exactly what it prevents.
  Acquire at the innermost write only; a mistake then deadlocks loudly instead of corrupting quietly.

## Custom replacements

- **A custom rule is consulted in `cleanTitle`, before the pass loop, and both the planner and the
  resolver must pass the lookup.** Discovery and resolution are separate decisions through the same
  function: a rule the planner cannot see nominates no candidate, and one the resolver cannot see
  reads as `already clean on the library page`.
- **The replacement is returned as typed and never stripped further.** One rule, one answer.
- **Artist is required.** `Candidate` needs one and neither library path can be built without one, so
  a title-only rule is undiscoverable — this is structural, not a deferred feature.
- `custom` is a `RuleTag`, deliberately **not** a tenth `GroupName`: `MARKER_GROUPS` is keyed on
  `GroupName` and `RULES_ENABLED` validates against it, so a tenth group would be nameable in config
  and need a fake pattern entry.

## Approvals

An approval is a **resume**, not a second persistence path. A proposal marks existing
`applied_edits` rows `awaiting_approval`; approving flips them back to `planned` and runs them
through the ordinary executor. Never add a table that stores a pending edit's fields — the ledger
already has them.

- `awaiting_approval` is **never** auto-applied. `Executor.run` skips only `verified`/`applied`, so
  anything that widens the resume filter must exclude it explicitly. `Approvals.carryOver` exists
  because the resume path used to run before any mode branch.
- Grouping happens at the **candidate boundary**, which is the only place a candidate's tuples are
  produced together. `Resolver.onGroup` therefore suppresses `onEdit`/`onAlbumEdit`; registering
  both would write before proposing.
- Album edits go through the ledger like track edits — `kind='album'` with `''` in every track
  field, which is also why `resumable` must stay kind-aware.
- `APPROVAL_MODE` is read once at startup. `sweep_state.paused` is the live flag; do not add a
  second live mode switch.

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
