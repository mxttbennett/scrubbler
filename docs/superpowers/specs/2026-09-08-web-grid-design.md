# Web grid — a local UI for reviewing and bulk-editing metadata

**Status:** design captured mid-brainstorm, not complete. Decisions 1–5 are settled; sections 4–7
of the design were never written. Resume at "Open questions", then "Not yet designed".

## The idea

A local web page that turns scrubbler from a daemon that reports to you into a tool you sit in
front of. One sortable, filterable grid of every metadata decision the service has made, with
inline editing and bulk operations — a Last.fm tag organiser, with the daemon as the thing that
fills the queue.

The grid's core job is the operation the Discord bot cannot do: take a selection of tracks on one
album and apply the same change to all of them at once — stripping `- Live` off all twelve tracks
of a live album, say — instead of approving or rejecting one card at a time.

### Why this is a promotion, not a workaround

Commit `6a8c895` changed the live rule from *stripping* to *normalising*: `Song (Live at Rotterdam
1984)` becomes `Song - Live at Rotterdam 1984`, and the dash form is the one nothing touches. So
the `- Live` suffixes a user would want to bulk-strip are often output the engine produced on
purpose, because every character of the qualifier surviving is what licenses that rule to exist.

Today the only way to get "strip live qualifiers off this one album" is to add a stripping pattern
to the marker catalogue — exactly what the closed-catalogue invariant forbids. The grid gives that
decision a home *outside* the pattern list. **The escape hatch moves from the rules to the human,
which is how the catalogue gets to stay closed and conservative.** The grid protects the invariant
rather than eroding it.

## Settled decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Localhost only.** Binds `127.0.0.1`, hardcoded, not configurable. | The process holds a Last.fm session cookie with write access. Any exposure puts that behind a hand-written HTTP surface. Localhost makes the threat model "someone already has a shell," at which point the cookie was theirs anyway — and skips TLS, sessions and password storage entirely. |
| 2 | **Sits beside Discord**, does not replace it. | Discord keeps notifying; the grid is where bulk work happens. Both write through the same ledger. v1 touches nothing that already works. |
| 3 | **A typed edit is a one-off override, promotable to a rule.** | A rule is *discovery* — it makes the planner nominate titles it would otherwise never look at, forever. A correction is not. Keeping the verbs separate keeps `custom_rules` small and intentional instead of accumulating one permanent row per correction. |
| 4 | **Bulk transforms are inferred from the first edit.** Edit one track; the grid diffs what you did, recognises it as a trailing-segment removal, and offers to apply the same change to the rest of the selection. | Zero new UI vocabulary — you just type, and it asks. An explicit transform toolbar is the fallback if inference proves too weak in practice. |
| 5 | **Approach A: plain JS, no bundler.** `node:http`, one hand-written HTML/CSS/JS file. | The repo has zero frontend tooling. A bundler means a second build pipeline, a second lint config, and a changed deploy story. A sortable/filterable/groupable grid with inline edit is ~300 lines of vanilla DOM code. Migrating a working plain-JS page later is a known, bounded job. |
| 6 | **Data scope: ledger by default, on-demand album expansion.** | See below. |

### On decision 6

`applied_edits` holds every tuple the engine ever acted on, so a corrected title is there and can
be re-edited. But a track the engine never nominated — no marker in its title — **has no row
anywhere in the database** and is invisible to the grid.

Loading the library instead is not available. `LibraryPages` paces at 15s + 5s jitter because
Last.fm soft-throttles the web pages with an HTTP `200` reading "You're requesting too many pages"
— no `429`, no `Retry-After`. At ~50 rows a page, 49k entities is ~1000 paced fetches: four-plus
hours to populate the grid once.

The way out is already in the code. `extractAlbumTrackNames` (`src/lastfm/pages.ts:93`) pulls an
album's full tracklist from the *same* HTML the edit form comes from — one fetch, one album, ~15s.
So expanding a single album on demand yields its real tracklist including tracks with no ledger
row, which is exactly the granularity bulk-stripping an album needs and the only granularity the
rate limiter can afford. Cache expansions in memory; re-expand is instant.

A full local mirror of the library (a background crawler plus an `entities` table plus a staleness
story) is the genuine "organiser" endgame and is explicitly out of scope for v1.

## Architecture

### Placement

The web server **must live inside the daemon process.** `src/index.ts:26` takes a process lock on
the DB path, and `WriteLock` is a plain in-memory object shared by every `Executor` in the process.
A separate web process would hold its own `WriteLock` — precisely the "two unordered writers
against the same account" the comment at `index.ts:74` exists to prevent. Last.fm returns `200` for
a no-op edit, so the collision would be misreported as success rather than failing loudly.

So this is not "scrubbler plus a web app". It is a **fourth caller inside the existing process**,
alongside the worker, the approval click, and the slash command.

New module `src/web/`, started from `main()` beside the Discord gateway, behind new config
`WEB_ENABLED` (default off) and `WEB_PORT`:

- `server.ts` — `node:http`, routing, JSON in/out, serves the static asset
- `handlers.ts` — endpoint logic, taking the same injected deps `Approvals` and `applyOneEntity` get
- `app.html` — one file, inline `<style>` and `<script>`

It gets its own `Executor`, for the same reason `Approvals` does (`index.ts:88`): a click can arrive
between cycles, when there is no cycle-scoped executor to reach for.

Nothing existing changes except `index.ts` wiring and `config.ts`.

### How an edit lands — the key finding

`CustomRuleLookup` is `(field, artist, title) => string | undefined` (`src/rules/customRules.ts`),
injected into `Resolver` as a constructor argument (`resolver.ts:49`). **Nothing requires it to be
backed by the database.**

So a manual override is an *ephemeral* lookup composed over `customRules.lookup`, and it needs
**zero changes to the rules engine, the resolver, or the executor.** `engine.ts:155` already carries
the comment describing the exact semantic decision 3 picked: "One rule, one answer — the result is
never fed back through the catalogue, so what the user typed is what lands." The one-off override
path is already built; it just has no caller that isn't the database.

Path for "strip `- Live` off these 12 tracks":

1. Browser POSTs the selection plus the transformation as explicit `{kind, artist, from, to}` pairs.
2. Handler builds an ephemeral `Map` of those entries falling back to `customRules.lookup`, and
   constructs a request-scoped `Resolver` with it.
3. It calls the same resolve-and-apply flow as `applyOneEntity` (`index.ts:158`), one candidate per
   selected title.
4. `cleanTitle` hits the override before the pass loop and returns the typed title verbatim.
   Everything downstream — `Resolver.fold`, the ledger row, dedupe, back-off, verification, album
   art, the automatic-edit rule — behaves exactly as for a catalogue match.
5. The ephemeral map is discarded. `custom_rules` is untouched unless *also save as rule* was clicked.

"Promote to rule" is then a one-liner: persist the same entry via `CustomRules.add`.

### Two invariants the handler must honour

- **Album before tracks.** If a selection contains both an album rename and track edits, apply the
  album edit first, then resolve the tracks — the order `test/scrub/albumFirst.test.ts` guards for
  the sweep, for the same reason: a track edit's `album_name_original` is part of its WHERE clause,
  and a stale one no-ops on a `200`. Write a test for this before writing any UI.
- **Trailing-anchored, never substring.** The inferred transformation is only ever *remove/replace
  this exact trailing segment*. The browser computes each row's `to` and displays it; the server
  receives explicit before/after pairs and never re-derives a pattern. There is therefore no
  pattern-matching code on the server, and nothing can silently mangle a title nobody looked at.
  This is the whole-segment anchoring discipline of the catalogue, borrowed for the manual tool.

### Data model

**No schema changes for the core feature.**

- Re-editing an already-corrected title needs no new row shape. `applied_edits` is unique on the
  four `*_original` columns; editing `Ripple - Live` (which the engine produced from `Ripple (Live)`)
  inserts a *new* row whose originals are the prior row's `next` values — a different tuple, no
  conflict. The ledger becomes a chain of edits over time, each row carrying its own correct WHERE
  clause.
- Album tracklist cache: in-memory `Map` for v1. It is pure cache; a table is a later call if losing
  it on restart proves annoying.

## Open questions

1. **Casing cannot be fixed.** `engine.ts:159` rejects a replacement differing from the original only
   in case. That is correct — Last.fm rejects casing-only edits and returns `200` on the no-op — but
   it means the grid **cannot fix capitalisation** (`Ripple` → `RIPPLE` will not go through). If that
   is part of the vision it is a separate problem needing a different solution. **Unanswered.**
2. **Provenance tag.** Proposal: add `manual` as a `RuleTag`, not a `GroupName` — the same distinction
   CLAUDE.md already makes for `custom`, and for the same reasons (`MARKER_GROUPS` is keyed on
   `GroupName`, `RULES_ENABLED` validates against it). Without it a hand-typed edit is
   indistinguishable in the ledger from one a saved rule produced. **Unanswered.**

## Not yet designed

Sections 4–7 of the brainstorm were never reached:

4. **Endpoint list.** Sketch only: `GET /api/rows` (status/kind/search params),
   `POST /api/rows/:id/{approve,ignore,retry,override}`, `POST /api/rows/bulk`, `GET|POST /api/rules`,
   `GET /api/state` + `POST /api/state/pause`, and album expansion. Every write handler a thin
   wrapper over `Approvals` and the shared `Executor`, the way `Commands` is today.
5. **Inference rules** — what shapes of edit the grid recognises as a repeatable transformation, and
   what it does when it cannot tell.
6. **Grid layout** — columns, filter chips (really just `WHERE status =`), album grouping, multi-select
   affordances, the rules panel with per-group shadow-hit counts, the `sweep_state` status strip with
   phase, progress and a pause toggle.
7. **Testing story.**

## Resuming

Re-enter via `superpowers:brainstorming` on the architectural path. Decisions 1–6 are settled and
should not be relitigated. Answer the two open questions, design sections 4–7, then this document
becomes the spec and `superpowers:writing-plans` takes over.
