# Changelog

Newest release first. Every merge to `main` adds an entry here in the same commit that bumps
`version` in `package.json` — see [VERSIONING.md](VERSIONING.md) for which number to pick. Each
GitHub release takes its notes from the matching section.

Entry format: `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD`, then one `-` bullet per change, written for the
person running the service rather than for the diff.

## [1.4.0] - 2026-09-09

- New rule group **`punctuation`**, off by default. It merges library entries whose names differ only
  by typographic punctuation — a curly apostrophe against a straight one, curly quotes, an en or em
  dash, an ellipsis character, a doubled space — so `Don't Stop` and `Don’t Stop` stop being two
  rows. Artists are covered as well as albums and tracks: `Jim O'Rourke` and `Jim O’Rourke` were two
  separate artists in a real library, 476 plays against 1.
- Nothing is touched unless a differently-punctuated twin actually exists. A lone
  `Negative Space (1981–2014)` keeps its en dash; only names that already have a sibling move.
- The surviving spelling is whichever variant you have played most, with its punctuation
  canonicalised — so casing follows the popular version too, which is what makes
  `She's Like Heroin to Me` and `She’s Like Heroin To Me` actually converge rather than merely
  losing their curly quote.
- It will **not** merge `Björk` with `Bjork`, `R&B` with `R and B`, or `A / B` with `A & B`. Those are
  arguably different names and the merge cannot be undone.
- The scan is API-only — about 280 requests, roughly a minute — and runs on the weekly full sweep
  rather than every cycle. It reads no rate-limited library pages.
- Turn it on with `RULES=punctuation:gated` to see each merge on a Discord card first. `off` (the
  default) spends nothing, not even the scan.
- An artist rename on a card now links to the artist's library page. It previously linked to a track
  named after the artist, which never exists.

## [1.3.0] - 2026-09-08

- A gated card for a rule that *rewrites* a label now carries a third button, **Strip**, which
  applies the same edit with the label removed instead of standardised. Today that is `live-track`
  alone: where a rule's proposal is already a removal, **Apply** is that outcome and a third button
  would duplicate it.
- The decision is per card and remembers nothing — the next live title still proposes the rewrite and
  asks again.
- If there is nothing to remove (a title whose remainder would be too short, say) the card stays live
  and says so, rather than silently doing nothing.
- A stripped card retires as `Applied — label removed`, with its subject updated to the removed form
  so the wording and the change agree.

## [1.2.0] - 2026-09-08

- `live-track` now **standardises** a live label instead of removing it: `Song (Live)` becomes
  `Song - Live`, and `Song (Live at Rotterdam 1984)` becomes `Song - Live at Rotterdam 1984`. The
  qualifier is kept verbatim, so nothing is lost — which is what makes matching a segment that only
  *starts* with Live legitimate where stripping one never was. The library already held both shapes
  of the same gig; this converges them on the form nothing touches.
- The marker is standardised to `Live` whatever case it arrived in, so `(live)` and `(LIVE)` both
  become `- Live`. Only the marker is re-cased — the qualifier is content, and title-casing it would
  mangle `WCOZ`, `BBC` and `5/22/77`.
- A title already in the dash form is left alone, including one whose marker is mis-cased
  (`all apologies - live`): fixing the case alone is an edit Last.fm silently rejects, so there is
  nothing to send.
- A compound such as `(Live; 2001 Remaster)` is left alone rather than rewritten, since rewriting it
  would preserve the remaster label. A marker sitting *before* a live label is also left in place —
  once the label is content, what precedes it is no longer the trailing segment.
- `live-album` is unchanged: it still strips a bare `(Live)`, because a release that only exists
  live has a redundant label, and no album in the library uses the dash form at all.
- New `deploy/repropose-stale.mjs` drops the outstanding proposals for a rule whose meaning changed,
  so they are re-resolved rather than applying the edit the old rule computed. See
  `deploy/README.md`.

## [1.1.4] - 2026-09-08

- Play counts are gone from the rule-engine test corpus, along with the scrobble totals in its
  header. Only the title is ever read, so nothing is lost, and a repo that is about to be public has
  no business carrying a listening history. Titles and artists are unchanged, and the verdict
  snapshot is byte-identical — the safety net is exactly what it was.
- `CLAUDE.md` no longer spells out the edit forms field by field. The invariants stay, the
  step-by-step transcript goes — it read as a recipe rather than as guidance, which is the wrong
  thing for a repo that is about to be public.
- No change to how the service runs, what it matches, or what it writes.

## [1.1.3] - 2026-09-08

- The README now states the Last.fm terms position up front: the API has no method for editing a
  scrobble, so the service drives the same authenticated web forms a browser uses, which is contrary
  to clause 2.6 of the API terms. Nothing about how it runs has changed — this says out loud what it
  was already doing.
- Last.fm is credited as the source of library data in the README and in the test corpus, which is
  what the API terms ask for wherever that data is distributed.
- The User-Agent announced `scrubbler/0.1.0` regardless of the version actually running. It now
  reads the package version, so Last.fm's logs name the build.

## [1.1.2] - 2026-09-08

- Releases are now created as **pre-releases** and promoted when they are deployed, so GitHub's
  "Latest release" means "the highest version that has ever run" rather than "the newest tag". A
  version you skip stays marked as never having run, and the releases page becomes a deployment log.
- Promotion is one-way: a rollback does not demote the release it rolled back from, because that one
  did run. After a rollback the release list is therefore ahead of the box, and `/scrub status`, the
  startup line and the deploy summary remain the authority on what is running.

## [1.1.1] - 2026-09-08

- The deploy workflow's run is now titled after the ref it is deploying, so the Actions list reads
  `deploy v1.1.0` instead of three identical `deploy` rows. Dispatch a tag to see it.
- Each deploy also records the version that actually came up in its run summary, read back from the
  service's startup line on the box rather than from `package.json` — a half-applied deploy cannot
  report the version it meant to ship.

## [1.1.0] - 2026-09-08

- Rule groups now have a **tier** instead of being on or off: `auto` applies as before, `gated` fires
  but turns every candidate into a Discord card with **Apply**/**Never**, and `off` never fires. Set
  them with `RULES=remaster:auto,live-album:gated`; a group you do not name keeps its default. This
  is what "experimental" always meant to gesture at — how much supervision a rule gets — except it is
  now your choice per rule rather than a fixed property of the rule.
- Tiers can be mixed within one sweep, and within one candidate: a candidate whose tuples span both
  tiers proposes the gated ones and writes the rest. A tuple tagged with both an auto and a gated
  group is gated, because a tuple is a single request and cannot be half-applied.
- `RULES_ENABLED` and `RULES_EXPERIMENTAL_ENABLED` still work, map to `auto`, and log a deprecation
  notice; they cannot be combined with `RULES`. Nothing in an existing `.env` needs to change.
- `APPROVAL_MODE=true` is now shorthand for promoting every `auto` group to `gated`, so its
  behaviour is unchanged.
- Shadow mode reports for any rule that is `off`, not only the ones that used to be called
  experimental — so a default-on rule you switch off can now be surveyed too.
- `/scrub status` gains a `rules` line naming the groups by tier, and `/scrub pending` no longer
  claims there is nothing to approve when a gated rule is configured without `APPROVAL_MODE`.
- Any gated group now requires the Discord owner/guild config that only `APPROVAL_MODE=true` used to.

## [1.0.1] - 2026-09-08

- Internal: the release step no longer fails when the tag already points at the commit being
  released. A re-run or a force-push after a history rewrite is a no-op, not a forgotten version
  bump, and only the second of those should turn `main` red.

## [1.0.0] - 2026-09-08

First versioned release. The service has been running unattended against a real library for some
time; this entry marks the point where releases became tracked, not the point where it started
working. Per-change history before this is in the git log and pull requests #1-#18.

- Strips edition and remaster cruft from a Last.fm library headlessly, against a **closed** marker
  catalogue where every pattern must match the whole trailing segment. Nine groups, three on by
  default (`remaster`, `edition`, `bonus`), the rest opt-in via `RULES_EXPERIMENTAL_ENABLED`.
- Album renames go through one `edit-album` request rather than N track edits, and albums are swept
  before tracks so a track edit's `album_name_original` cannot go stale.
- Discovery is incremental by default, on a cursor over recent scrobbles, with a weekly full sweep
  as the completeness guarantee.
- Every correction is reported to Discord as an embed — the change, the rule that fired, the
  scrobbles it moved, and links to the affected library pages.
- `APPROVAL_MODE` turns each candidate into a Discord card with **Apply** and **Never** buttons; an
  approval resumes the existing ledger row rather than storing the edit a second time.
- Shadow mode reports what a *disabled* rule would have caught, so a group can be assessed before
  it is switched on.
- `/scrub` slash commands for status, stats, pending approvals, pause/resume, custom replacements
  and the ignore list. `/scrub status` now names the running version.
- Custom replacements: a per-artist, per-title rename consulted before the catalogue, for cruft the
  closed catalogue cannot reach.
- Writes are serial through a single process-wide lock, verified after the fact, and recorded in an
  `applied_edits` ledger that is the only dedupe — an automatic-edit rule existing is never taken as
  evidence the work is done.
- Deploy is a manual-trigger GitHub Actions workflow that snapshots the ledger with `VACUUM INTO`
  before swapping the build in.
