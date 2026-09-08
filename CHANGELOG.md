# Changelog

Newest release first. Every merge to `main` adds an entry here in the same commit that bumps
`version` in `package.json` — see [VERSIONING.md](VERSIONING.md) for which number to pick. Each
GitHub release takes its notes from the matching section.

Entry format: `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD`, then one `-` bullet per change, written for the
person running the service rather than for the diff.

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
