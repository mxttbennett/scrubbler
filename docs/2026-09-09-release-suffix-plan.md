# Release-suffix handling — findings and plan

**Date:** 2026-09-09 · **Status:** decided, no code changes proposed

Triggered by HalfNoise showing three albums for one track: `Flowerss - EP` (13),
`She Said` (6), `Flowerss` (1). Question asked: should a gated card offer a third
button so the *suffixed* name can win and the bare copies merge into it?

## Finding: the feature already exists

`ep-single` has been in the catalogue all along — album-only, `off` by default,
whole-segment anchored on `ep` and `single`. Verified against the real engine:

| Input | Field | Result |
|---|---|---|
| `Flowerss - EP` | album | `Flowerss` |
| `Flowerss (EP)` | album | `Flowerss` |
| `Flowerss - Single` | album | `Flowerss` |
| `Flowerss` | album | no change |
| `EP` | album | no change (no trailing segment) |
| `Flowerss - EP` | track | no change (album-only, by design) |

`ep-single:gated` was already set in the local `.env`.

## Scan results

Read-only, API-only (`user.getTopAlbums` / `getTopTracks`), no page reads, no writes.

```
ALBUMS=8654   TRACKS=39973

EP_SINGLE_HITS       19    albums ep-single would rewrite
SUFFIX_BARE_PAIRS     5    ...of which a bare twin actually exists
  SUFFIXED WINS       1    keeping "- EP" is the right answer
  BARE WINS           3
  TIES                1
TWINLESS_STRIPS      14    no twin; pure cruft removal

SELF_NAMED_ALBUMS          1454    albums sharing a name with one of their own tracks (17%)
SELF_NAMED_WITH_OTHER      879
```

The five pairs:

```
SUFFIX | HalfNoise                   | Flowerss - EP (13)       vs Flowerss (1)
BARE   | Jefre Cantu-Ledesma         | In Summer - EP (1)       vs IN SUMMER (55)
BARE   | HAIM                        | Summer Girl - Single (2) vs Summer Girl (3)
BARE   | Epic Rap Battles of History | Artists vs Turtles (1)   vs Artists vs Turtles (3)
TIE    | Iyaz                        | Replay - Single (1)      vs Replay (1)
```

## Decisions

**1. Keep `ep-single` as a strip-only rule. No new group, no card change.**

The reverse direction is correct for exactly one album in 8,654. Rejected:

- *Cluster-only `ep-single`* (fires only with a proven twin) — abandons 14 twinless
  strips to fix 1 case.
- *A new release-type cluster group* — a tenth group, a migration and a precedence
  rule, to serve one album.
- *A universal third button on gated cards* — the motivating case cannot be served by
  a button at all. `ep-single` receives one title and returns one answer; it never sees
  the row you would merge *from*, so there is no alternative target to offer. Deciding
  which row survives is cluster knowledge, and putting it behind a click would pull
  library-wide state into the embed. `live-track`'s Strip button is legitimately
  different: one input, two transformations of the same title.

**2. Drop the "album named after its own track" idea.**

At 1,454 of 8,654 (17%) this is the *title track* — `Pet Sounds`, `Is This It`,
`Pink Moon`, `Aja`, `Replica`. The shape is noise, not a duplicate signal. A rule on it
would mangle a sixth of the library. Any future attempt needs a different discriminator
(e.g. album has exactly one track), and the album→track mapping that would require is
the expensive resource `LibraryMirror` exists to avoid.

**3. Handle the exceptions per-album with shipped machinery.**

For `HalfNoise`, to keep `Flowerss - EP` and pull the 1-play row into it:

1. Click **Never** on the gated `Flowerss - EP → Flowerss` card. Writes to `ignored`;
   only `/scrub unignore` reverses it, so `ep-single` stops proposing it permanently.
2. `/rule album "HalfNoise" "Flowerss" "Flowerss - EP"` — safe because a custom
   replacement is returned as typed and never stripped further.

**Step 1 is not optional.** Without it the two rows ping-pong forever: the custom rule
maps bare → suffixed, `ep-single` maps suffixed → bare, and neither settles. The same
recipe covers the `Iyaz` tie if wanted. The three `BARE WINS` pairs need nothing —
`ep-single` already resolves them the right way.

## Actions

| # | Action | Owner | Status |
|---|---|---|---|
| 1 | Add `punctuation:gated` to local `.env` | Claude | **done**, parses on main (11 tiers) |
| 2 | Add `punctuation:gated` and `ep-single:gated` to the VM `.env` | Matt | pending — no VM access from the session |
| 3 | `Never` on the HalfNoise `Flowerss - EP` card | Matt | pending, needs a gated sweep to propose it |
| 4 | `/rule album "HalfNoise" "Flowerss" "Flowerss - EP"` | Matt | pending, after #3 |
| 5 | Reconcile the hit-count discrepancy below | — | optional |

No source changes. No migration. No PR.

## Open items

**Hit-count discrepancy.** The corpus fixture yielded **31** `ep-single` hits; the live
scan yielded **19**, on a library the corpus is a subset of. Both cannot be right —
possibly edits applied since the 2026-09-07 capture, possibly a bug in one probe. It does
not move the decisions (the 5 pairs and their play counts come from one consistent live
enumeration), but 19 should not be quoted as settled until reconciled.

**Local startup.** `punctuation:gated` fails config validation on
`matt/web-grid-library-mirror`, which predates #30 and does not know the group. That is
the startup guard working as intended — don't run the local daemon from that branch until
it catches up to `main`.

**Corpus caveat worth remembering.** `test/fixtures/lfm-title-corpus.json` keeps only
titles that already carry a trailing delimiter segment, so the bare halves of every pair
were discarded at capture. It cannot measure absence, and any "does a twin exist?"
question has to go to a live scan.
