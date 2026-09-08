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

These are the things a newcomer gets wrong. Each one was found the hard way.

- **The marker catalogue is closed, and patterns match the WHOLE trailing segment.** Never add a
  substring or shape-based match. A survey of the real library found most trailing segments are
  genuine content (`Pt. II`, `Reprise`, `Live in Rotterdam 1984`, `Taylor's Version`), and only
  full-segment anchoring distinguishes `(Live)` from `(Live in Rotterdam 1984)`. The upstream
  userscript's `detectSuffixPatterns` heuristic is the anti-pattern: it works only because a human
  ticks each box.
- **That rule governs *stripping*. A lossless rewrite is a separate operation.** `DASH_NORMALIZED`
  reformats a track's `(Live …)` into `- Live …`, matching on a leading marker rather than the whole
  segment — legitimate because every character of the qualifier survives, which is the reason the
  anchoring rule exists. A group listed there never strips, so the two operations cannot blur. The
  library already held both shapes of the same gig, and the dash form is the one nothing touches.
- **`+noredirect` on every library URL, tracks and albums alike.** Without it Last.fm 301s to a
  canonical form that is *lowercased*, and a casing-only difference makes the `*_original` tuple
  stop matching — while Last.fm also rejects casing-only edits, so the write silently no-ops.
- **An album rename is one album-scoped edit, not N track edits.** The album form needs only the
  album and artist pair — no timestamp, no track, no `edit_all` — so album candidates never recurse
  into track pages. The track form is for when a *track title* carries a marker.
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
- **Identify honestly in the User-Agent; never impersonate a browser.** The service names itself
  and its repo, which is the point — a tool doing authenticated writes should be attributable. A
  browser-shaped User-Agent is also rejected, and the rejection page is shaped enough like a real
  one that page checks must look for the form token rather than the title.
- **HTTP status cannot detect auth state.** Success and several distinct failures are
  indistinguishable by status code alone, so every check has to read the response itself.
  `Session.isAuthenticated` is the single place that logic lives — do not re-derive it at a call
  site.
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

The edit is a two-step form submission against the ordinary library UI: read the row's edit form,
then post it back with the changed fields. `src/lastfm/editor.ts` is the only description of the
field set, and the only place it should live — it is a transcription of what the site's own form
does, so it tracks the site rather than a spec, and it will need revisiting whenever that changes.

Automatic-edit rules are read from two separate settings pages, one for albums and one for tracks;
only the track one paginates. See `src/lastfm/rules.ts`.

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

## Shadow mode

- **A shadow hit is not a ledger row.** `applied_edits` is unique on the four `*_original` columns
  and every status there means a decision was taken, so a shadow row would occupy the tuple a later
  real correction needs. It lives in `shadow_hits`, keyed `(rule, kind, title)`.
- **The artist is outside that key on purpose.** `sweepIncremental` nominates an album under the
  TRACK artist (`planner.ts` says so in its own comment) while `sweep()` uses the album artist, so
  including it would record the same album twice. Albums are therefore shadowed on the full sweep only.
- **Reporting happens after the cycle commits its state.** `RateLimiter.acquire` reserves its slot
  before awaiting, so posting fifty cards first pushes the awaited summary behind all of them and
  delays the cursor write by minutes.
- **`reportedAt` is separate from `seenAt`** and set only after a send returns. The REST sender
  no-ops silently when Discord is unconfigured, so marking a row reported at record time would
  suppress a card that was never sent.
- **The diff is against the enabled result**, not the raw title — otherwise every catalogue hit would
  also report as a shadow hit for every disabled rule.

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
- **Anything a resume needs must be a ledger column.** `timestamp`, `action`, `referer_path` and
  `track_names` are all there for that reason: a restart mid-resolution rebuilds the edit from the
  row alone, and the album page those track names came from is gone once the rename lands.
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

The corpus carries titles and artists and nothing else: play counts were stripped because only the
title is ever read, and a listening history is not something a public repo should carry. **Do not
"tidy" the corpus.** Its value is that the awkward cases are real.

## Loop

```sh
npm run dev -- --once  # one sweep against the real account (respects DRY_RUN)
npm test
npm run typecheck
npm run lint
npm run db:generate -- --name <what_it_does>   # always pass --name
```
