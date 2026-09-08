# scrubbler

A headless service that strips edition and remaster cruft from a Last.fm library and saves the
correction as an automatic edit, so Last.fm fixes future scrobbles server-side.

```
Nevermind (Deluxe Edition)          ->  Nevermind
Silver Springs - 2004 Remaster      ->  Silver Springs
Damned Damned Damned (Bonus Tracks Version)  ->  Damned Damned Damned
```

It runs unattended on a small VM alongside other personal services. There is no UI and no review
queue: it applies only changes it is confident about and logs everything else.

## How it works

There is no Last.fm API for editing scrobbles — editing exists only as an authenticated web form.
So the service uses each transport for what it is good at:

| Stage | Transport | Why |
|---|---|---|
| **Sweep** — find candidates | Read API (`user.getTopAlbums`, `user.getTopTracks`) | ~250 requests enumerates every distinct entity. Cheap and official. |
| **Resolve** — build the edit | Scrape the library page (`+noredirect`, paced) | The API never returns `albumartist`, which the edit form requires to match exactly. |
| **Write** | `POST /user/<you>/library/edit-track` | The only way to edit a scrobble. |

Each write sets `edit_all` (apply to all past scrobbles of that exact tuple) and
`create_automatic_edit_rule` (apply to all future ones). Because Last.fm then corrects new scrobbles
itself, steady-state work approaches zero — the service is really a rule-discovery loop, and sweeps
are stateless full enumerations rather than an incremental cursor.

## The rule engine

The catalogue is **closed**, and each pattern must match the **entire** trailing segment of a title.
That is the whole safety story. A survey of 8,831 real albums and 40,257 real tracks found that most
trailing segments are genuine title content:

> `Pt. II` · `Reprise` · `Live in Rotterdam 1984` · `BBC John Peel Session 1990` ·
> `Unfinished Outtake` · `Original Mix` · `Original Motion Picture Soundtrack` · `DJ Mix` ·
> **`Taylor's Version`**

Full-segment anchoring is what saves all of these: `(Live)` strips, `(Live in Rotterdam 1984)` does
not match at all. A substring matcher — or a "find the common suffix" heuristic — destroys them.

Guards, each with a named test in `test/rules/engine.test.ts`:

- the remainder must keep ≥2 characters and at least one alphanumeric;
- a casing-only result is dropped (Last.fm rejects those server-side anyway);
- a title that *is* the marker (a track called `Remastered`) is skipped and recorded;
- at most 3 stripping passes, so compound tails collapse but runaway edits cannot;
- a bare year is only removed as a *continuation* of a marker (`Hand of Doom - 2012 - Remaster`),
  never alone, and never when it would break a range (`The Beatles 1967 - 1970`);
- album markers are never tested against track titles, or vice versa.

### Rule groups

Set via `RULES_ENABLED` / `RULES_EXPERIMENTAL_ENABLED`. An unknown name is a startup error, so a
typo cannot silently disable a group.

| Group | Default | Applies to | Examples |
|---|---|---|---|
| `remaster` | **on** | track, album | `- Remastered`, `- 2004 Remaster`, `(2009 Digital Remaster)` |
| `edition` | **on** | track, album | `(Deluxe Edition)`, `(Expanded Version)`, `(Collector's Edition)`, `(Bonus Track Version)`, `(Reissue)` |
| `bonus` | **on** | track, album | `- Bonus Track`, `(Bonus Tracks)`, `(Explicit)`, `(Clean)` |
| `feat-album` | off | album | `(feat. X)` on an *album* title — store cruft |
| `feat-track` | off | track | `(feat. X)` on a *track* title — **deletes a real credit** |
| `ep-single` | off | album | `- EP`, `- Single` |
| `live` | off | track, album | `(Live)` |
| `version` | off | track, album | `- Radio Edit`, `- Single Version`, `- Album Version` |
| `mono-stereo` | off | track, album | `(Mono)`, `(Stereo)` |

`- Album Version` sits with `- Single Version` and `- Radio Edit` rather than with the bonus
markers: all three name *which recording* it is, so stripping them merges takes that differ.

The experimental groups are off because they distinguish *different recordings*. Merging them loses
real information and cannot be undone. `feat` is split so you can enable the safe album half without
the lossy track half.

## Safety

Layered, because a false positive is irreversible and `edit_all` widens every write to all scrobbles
sharing the tuple:

- **`DRY_RUN=true` by default** — plans and logs everything, writes nothing.
- **Idempotency ledger** (`applied_edits`), keyed on the original 4-tuple, with attempt-based
  backoff so a permanently rejected edit is not retried forever.
- **The ledger is the only dedupe.** Existing automatic-edit rules are read and reported but never
  used to skip work: a rule created without "apply to all past scrobbles" fixes only future ones, so
  a title that is *still* dirty proves the past scrobbles need editing regardless of the rule.
- **`MAX_EDITS_PER_RUN`** caps the blast radius of a bad ruleset.
- **Serial writes** with `WRITE_DELAY_MS` spacing. Parallel writes produce inconsistent results.
- **Paced reads** — `PAGE_DELAY_MS` defaults to 15s. Last.fm throttles the web pages with an HTTP
  `200` error page, and 1.5s still tripped it. A first pass therefore takes hours, which is the
  right trade for a service that runs continuously.
- **Verification** — Last.fm returns `200` for an accepted-but-no-op edit, so each write is
  confirmed by re-reading the row after a delay.

## Running it

```sh
cp .env.example .env && chmod 600 .env   # then fill it in
npm install
npm run dev -- --once                    # one sweep, then exit
npm test
```

`--once` runs a single sweep and exits; without it the service loops every `SWEEP_INTERVAL_MS`.

Deployment is manual for now — see [deploy/README.md](deploy/README.md) for the rsync + systemd
steps, the pre-deploy snapshot, and what rollback can and cannot undo.

## Reporting

Everything goes to journald (`journalctl -u scrubbler -f`). Set `DISCORD_BOT_TOKEN` and
`DISCORD_CHANNEL_ID` and it also posts:

- **one embed per correction** by default, with the old title struck through above the new one, the
  rule that fired, and running totals in the footer. Set `DIGEST_EVERY` above 1 to batch them into a
  code-fenced digest instead, which is quieter for a large backfill;
- a **summary embed** at the end of each sweep, with tuple / applied / verified / unverified /
  failed counts;
- an **error embed** for anything that fails, immediately.

The embed title names the outcome — *Corrected*, *Corrected, unconfirmed*, *Failed to correct*, or
*Would correct* in a dry run — and is coloured to match, so the channel reads at a glance. In the
journald log and in batched digests the same outcomes are marked `+`, `?`, `!` and `·`.

Posting is rate limited to one message per 1.2s, under Discord's ~5-per-5s channel limit, so
one-per-correction is safe even in a dry run where nothing pauses between edits.

It posts over the REST API with no gateway connection, so **the bot shows as offline** in Discord's
member list. That is deliberate: this service only ever posts, so a websocket would be a process to
supervise for no benefit. Reporting is best-effort throughout and never fails a sweep.

## Seeing what it would change

`npm run report` sweeps the API and prints every planned change without scraping or writing
anything, to `/tmp/sweep-report.{txt,json}`. Safe to run at any time, and the right way to review
the diff before setting `DRY_RUN=false`.

## Inspecting what it did

```sh
sqlite3 .data/scrubbler.sqlite \
  "select status, count(*) from applied_edits group by status;"

sqlite3 .data/scrubbler.sqlite \
  "select track_name_original, track_name, album_name_original, album_name, groups
   from applied_edits where status='verified' limit 20;"

sqlite3 .data/scrubbler.sqlite "select reason, count(*) from skipped group by reason;"
```

## Credits

The Last.fm edit contract was originally reverse-engineered by
[lastfm-bulk-edit](https://github.com/Rudey/lastfm-bulk-edit) (AGPL), a browser userscript. This
service reimplements the same contract headlessly; note that the endpoint has since moved from
`/library/edit` to `/library/edit-track`, which the userscript still hardcodes.
