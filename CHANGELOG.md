# Changelog

Newest release first. Every merge to `main` adds an entry here in the same commit that bumps
`version` in `package.json` — see [VERSIONING.md](VERSIONING.md) for which number to pick. Each
GitHub release takes its notes from the matching section.

Entry format: `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD`, then one `-` bullet per change, written for the
person running the service rather than for the diff.

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
