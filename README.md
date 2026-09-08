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

## Disclaimer

Last.fm's API exposes no method for editing a scrobble. Correcting one means driving the same
authenticated web forms a browser uses, which is what this service does: it logs in with your
credentials, reads your library pages, and posts to `/library/edit-track`.

That is contrary to clause 2.6 of the Last.fm [API Terms of Service](https://www.last.fm/api/tos),
which permits gathering data only through the documented API, and Last.fm may restrict, suspend or
terminate any account at its sole discretion ([Terms of Use](https://www.last.fm/legal/terms),
section 18).

Run it on your own account, at your own risk. It is non-commercial, identifies itself honestly in
its User-Agent, paces library reads at 15s with jitter, and backs off when Last.fm signals a
throttle — but none of that amounts to permission. The MIT licence covers defects in this code. It
does not cover what happens to your Last.fm account.

## How it works

There is no Last.fm API for editing scrobbles — editing exists only as an authenticated web form.
So the service uses each transport for what it is good at:

| Stage | Transport | Why |
|---|---|---|
| **Sweep** — find candidates | Read API (`user.getTopAlbums`, `user.getTopTracks`) | ~250 requests enumerates every distinct entity. Cheap and official. |
| **Resolve** — build the edit | Scrape the library page (`+noredirect`, paced) | The API never returns `albumartist`, which the edit form requires to match exactly. |
| **Write** | `POST /user/<you>/library/edit-track` | The only way to edit a scrobble. |

### Discovery

Most cycles are **incremental**: they poll `user.getRecentTracks` from a stored cursor, which is
seconds. That works because every write sets `create_automatic_edit_rule`, so Last.fm corrects future
scrobbles of a known pattern server-side — a genuinely new dirty entity can only arrive with a new
scrobble. A **full sweep** still runs every `FULL_SWEEP_INTERVAL_MS` (weekly) and on demand, as the
completeness guarantee.

The cursor advances only after a cycle completes, so an interruption re-examines rather than skips.

Candidates that resolve to nothing are remembered after `DEAD_CANDIDATE_ATTEMPTS` passes. This is the
larger of the two savings: a full sweep costs ~250 cheap API calls, but a permanently-empty candidate
costs a *paced 15-20s page fetch every cycle forever*.

```sh
npm start -- --resweep      # clear the cursor; next cycle walks the whole library
npm start -- --retry-dead   # forget empty candidates so they are tried again
```

Corrections are written **as each tuple resolves**, not after the whole library has been walked.
`Resolver.fold` derives the complete change for a tuple from one row — both track and album title
— so a tuple reached via an album page yields the same edit as one reached via a track page, and
writing immediately cannot leave a partial edit to collide with later. That matters because
resolving a dirty album means fetching its page *plus one page per track on it*, so a full pass
takes hours; deferring writes until the end would mean hours of silence.

Album renames take a **different, cheaper endpoint**. Last.fm's edit URL carries an
`?edited-variation=` parameter with two values: `library-track-scrobble` posts to `/library/edit-track`
and needs a timestamp plus `edit_all`, while `library-album-scrobble` posts to `/library/edit-album`
and takes only the album name and album artist pairs — no timestamp, no track, no `edit_all`, because
it is inherently album-wide. So renaming a 14-track album is **one** request, and album candidates
never need recursing into their track pages. `edit-track` is only used when a track title itself
carries a marker.

Albums are always swept before tracks, and that ordering is load-bearing: the album rename lands
first, so a track page read afterwards already shows the clean album name and a track edit's
`album_name_original` cannot go stale.

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

Each group has a **tier**, set via `RULES` as `group:tier` pairs. An unknown group or tier is a
startup error, so a typo cannot silently disable a group.

| Tier | What it does |
|---|---|
| `auto` | Fires and applies, reporting afterwards |
| `gated` | Fires, but every candidate becomes a Discord card with **Apply** / **Never** (and **Strip** for a rewriting rule); nothing is written until you click |
| `off` | Never fires. Set `SHADOW_MODE=true` to see what it *would* catch, for free and with no decisions |

```sh
RULES=remaster:auto,edition:auto,bonus:auto,live-album:gated
```

A group you do not name keeps the default in the table below. The ladder is deliberate: `off` plus
shadow mode surveys a rule across the whole library at no cost, `gated` costs one paced page fetch
and one click per candidate, `auto` costs nothing but supervision.

`APPROVAL_MODE=true` is kept as shorthand for "supervise everything" — it promotes every `auto`
group to `gated`. `RULES_ENABLED` / `RULES_EXPERIMENTAL_ENABLED` still work and map to `auto`, but
they are deprecated and log a notice at startup; they cannot be combined with `RULES`.

| Group | Default tier | Applies to | Examples |
|---|---|---|---|
| `remaster` | `auto` | track, album | `- Remastered`, `- 2004 Remaster`, `(2009 Digital Remaster)`, `(2019 Remastering)`, `(Expanded & Remastered)` |
| `edition` | `auto` | track, album | `(Deluxe Edition)`, `(Expanded Version)`, `(Collector's Edition)`, `(Bonus Track Version)`, `(Reissue)`, `(40th Anniversary Remaster)`, `(Remastered And Expanded)`, `(Remastered & Expanded Edition)` |
| `bonus` | `auto` | track, album | `- Bonus Track`, `(Bonus Tracks)`, `(Bonus Version)`, `(Explicit)`, `(Clean)` |
| `feat-album` | `off` | album | `(feat. X)` on an *album* title — store cruft |
| `feat-track` | `off` | track | `(feat. X)` on a *track* title — **deletes a real credit** |
| `ep-single` | `off` | album | `- EP`, `- Single` |
| `live-album` | `off` | album | `(Live)` on a release that only exists live — 14 in this library |
| `live-track` | `off` | track | `(live)`, `(Live at …)` → `- Live …` — **standardises the label rather than removing it** |
| `version` | `off` | track, album | `- Radio Edit`, `- Single Version`, `- Album Version` |
| `mono-stereo` | `off` | track, album | `(Mono)`, `(Stereo)` |

`- Album Version` sits with `- Single Version` and `- Radio Edit` rather than with the bonus
markers: all three name *which recording* it is, so stripping them merges takes that differ.

The groups defaulting to `off` do so because they distinguish *different recordings*. Merging them
loses real information and cannot be undone — `gated` is the middle ground when you want them
mostly, but not silently. `feat` is split so you can enable the safe album half without
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
- **Resolution is checkpointed.** Each resolved tuple is written to the ledger as `planned` before
  any write, and the next run applies those first. An interruption part-way through a multi-hour
  resolution costs one page fetch to resume, not the whole pass — the CSRF token comes from the
  session cookie, so one fresh token serves every carried-over write.
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

Deploys run from a manual-trigger GitHub Actions workflow — see
[deploy/README.md](deploy/README.md) for that, the pre-deploy snapshot, and what rollback can and
cannot undo. Releases are tagged automatically on merge; [VERSIONING.md](VERSIONING.md) says which
number to bump and how to tell what is running.

## Reporting

Everything goes to journald (`journalctl -u scrubbler -f`). Set `DISCORD_BOT_TOKEN` and
`DISCORD_CHANNEL_ID` and it also posts:

- **one embed per correction** by default, with the old title struck through above the new one, the
  rule that fired, how many of your scrobbles it moved, and running totals in the footer. Set `DIGEST_EVERY` above 1 to batch them into a
  code-fenced digest instead, which is quieter for a large backfill;
- a **summary embed** at the end of each sweep, with tuple / applied / verified / unverified /
  failed counts;
- an **error embed** for anything that fails, immediately.

The embed title names the outcome — *Corrected*, *Corrected, unconfirmed*, *Failed to correct*, or
*Would correct* in a dry run — and is coloured to match, so the channel reads at a glance. In the
journald log and in batched digests the same outcomes are marked `+`, `?`, `!` and `·`.

Posting is rate limited to one message per 1.2s, under Discord's ~5-per-5s channel limit, so
one-per-correction is safe even in a dry run where nothing pauses between edits.

Reports go over the REST API, which is best-effort throughout and never fails a sweep.

Whether the bot shows **online** depends on configuration, not on the mode: set `DISCORD_OWNER_ID`
and `DISCORD_GUILD_ID` and it holds a gateway connection to receive commands and button clicks. With
only a token and channel it posts and never listens, so it shows offline.

Proposals use a separate transport that throws on failure rather than swallowing it: a report that
vanishes costs a line of history, while a proposal that vanishes would leave an approval nobody can
ever act on.

## Approval mode

By default the service corrects unattended and tells you what it did. Set `APPROVAL_MODE=true` and
it instead asks first: every candidate becomes one Discord card with **Apply** and **Never**
buttons — and a third, **Strip**, when the rule that matched *rewrites* a label rather than removing
it. Nothing is written until you click.

One card per *candidate*, not per scrobble — if eleven tracks on an album share the same removable
suffix, that is one decision, not eleven. The card shows the artist, the change, the track list and
the rule that matched, with the cover art of the album as it *will* be.

- **Apply** writes the edits and creates the automatic-edit rule, then stamps the card `Applied`.
- **Strip** applies the same edit with the label *removed* instead of standardised, and stamps the
  card `Applied — label removed`. It appears only for a rewriting rule — today `live-track` — because
  that is the only case where removal is a third outcome; where the proposal is already a removal,
  Apply is it. The decision is per card and remembers nothing, so the next one still asks. If there
  turns out to be nothing to remove the card stays live and says so.
- **Never** records the entity on the ignore list, so it is not proposed again. Only
  `/scrub unignore` lifts that.
- Untouched for `APPROVAL_TTL_HOURS` (a week by default), a card becomes `Expired` and its edits go
  back to the pending pool — an unread week is re-proposed, never discarded.

Only `DISCORD_OWNER_ID` can click; anyone else gets an ephemeral refusal. Startup refuses outright
if the mode is on without a bot token, channel, owner and guild.

The mode is read once at startup, so changing it needs a restart. Switching it **off** drains the
outstanding queue through the ordinary path on the next cycle and retires the cards — it does not
leave proposals stranded. For a live stop, use `/scrub pause`.

### Commands

Guild-scoped, owner-only, replies are ephemeral. **Not gated on approval mode** — set
`DISCORD_OWNER_ID` and `DISCORD_GUILD_ID` and you get all of these unattended too; `pending` and
`approve-all` simply say the mode is off. Type `/scrub` in the channel to see the list.

| Command | Does |
|---|---|
| `/scrub status` | mode, phase, candidate progress, verified/failed, pending count, cursor |
| `/scrub stats` | all-time corrections, albums and tracks counted separately |
| `/scrub pending` | the proposals awaiting a decision, with jump links |
| `/scrub approve-all` | approve every pending proposal, behind a confirmation button |
| `/scrub ignored [page]` | the ignore list |
| `/scrub unignore <artist> <title>` | remove an entry so it can be proposed again |
| `/scrub pause` / `/scrub resume` | stop and start at the candidate boundary, no restart needed |
| `/scrub resweep` | clear the scrobble cursor so the next sweep walks the whole library |
| `/scrub retry-dead` | forget the learned-empty candidates |
| `/scrub replace` | add a custom replacement and apply it now (see below) |
| `/scrub rules` | the custom replacements you have set, with apply counts |
| `/scrub unrule` | remove one |

## Shadow mode

The experimental rule groups are off because enabling one is irreversible. Shadow mode is how you
find out what a rule would do *before* trusting it with the library: with `SHADOW_MODE=true`, every
sweep reports what each **disabled** rule would have changed, in a violet card, and writes nothing.

```
Would correct — live-track
Nirvana ↗
  track name   all apologies (Live) ↗
               all apologies - Live
  rule         `live-track` is off — set it to `gated` or `auto` in RULES to turn it on
  nothing was changed · 137 more recorded, see /scrub shadow
```

Measured against a real library, which is the point: `feat-track` would touch **272** tracks,
`feat-album` **20**. `live-track` no longer removes anything — it rewrites a bracketed live label
into the dash form the library already uses elsewhere — so its hits are renames, not merges. Those
numbers are the argument for looking first.

- One card per hit, **capped per sweep** (`SHADOW_MAX_PER_SWEEP`, 50). Everything is recorded either
  way; the cap only delays announcements, and the rest go out on the next cycle.
- Each entity is announced **once**. A later sweep is silent unless the rule's answer changed.
- `/scrub shadow [rule]` lists everything recorded; `/scrub shadow-clear [rule]` forgets it so it is
  announced again.
- Albums are shadowed on the **weekly full sweep** only — the incremental path knows a scrobble's
  track artist but not its album artist, and filing an album under the wrong artist would break the
  dedupe permanently.
- A shadow hit is an observation, not a queued edit. There is no button to accept one: you either
  enable the rule or use `/scrub replace`.

## Custom replacements

The marker catalogue is closed on purpose — it matches whole trailing segments against a named list,
which is why `- 2022 Mix`, `- Second Version` and `Mono Mix Remaster` are all left alone. The cost of
that safety is that some real cruft is unreachable: a store artifact, a label's odd suffix, a title
that is simply wrong.

`/scrub replace` names one yourself:

```
/scrub replace kind:album artist:Pavement
               from:"Wowee Zowee: Sordid Sentinels Edition"
               to:"Wowee Zowee"
```

- It is a **standing rule**, consulted on every sweep, not a one-off — so a re-scrobble is caught too.
- It **beats the catalogue** and the replacement is used exactly as typed; it is never stripped
  further. One rule, one answer.
- It **applies to the named entity immediately**, because a new rule cannot be discovered until the
  next full sweep (weekly). Anything else matching is caught on that sweep.
- It **names one artist**, always. That is a structural limit, not a missing feature: everything in
  the pipeline is artist-addressed, and a title-only rule could never be discovered.
- It goes through the same ledger, verification and automatic-edit-rule path as a catalogue match, and
  **skips the approval gate** — approving your own typed instruction is a round trip for nothing.

Matching ignores casing and surrounding spaces, since Last.fm's own casing varies. A replacement that
differs from the original only in casing is rejected, because Last.fm silently discards such an edit.

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

Library and listening data comes from [Last.fm](https://www.last.fm), powered by AudioScrobbler. All
Last.fm Data remains the property of Last.fm. The corpus under `test/fixtures/` is a small
non-commercial extract of one account's own library, kept well inside the 100 MB Reasonable Usage
Cap set by clause 4.3.4 of the API Terms of Service.
