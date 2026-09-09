# Runtime rule configuration from Discord

## Problem

Rule tiers are fixed at process start. `RULES=group:tier` is parsed once by `loadConfig`, and the
derived `enabledGroups` / `gatedGroups` sets are captured as values by every collaborator that
reads them. Changing a rule from `auto` to `gated`, or turning one off, means editing `.env` on the
VPS and restarting the service.

The operator wants to do it from Discord, through an interactive menu, alongside the pause switch
that already exists.

## Scope

In scope: the per-group tier (`auto` / `gated` / `off`) for the eleven catalogue groups, and
pause/resume.

Out of scope, deliberately: `DRY_RUN`, `SHADOW_MODE`, `APPROVAL_MODE`, and every pacing and limit
setting. `APPROVAL_MODE` in particular stays startup-only, so the invariant in `CLAUDE.md`
("`APPROVAL_MODE` is read once at startup … do not add a second live mode switch") is not amended
by this work.

## Precedence

A three-layer resolution, narrowest wins:

```
catalogue default (MARKER_GROUPS[g].defaultTier)
  <- RULES env var, for groups it names
     <- rule_tiers table, for groups explicitly changed from Discord
```

Only changed groups get a row. Resetting a group deletes its row, so `RULES` governs it again.
This keeps `.env` meaningful: a group the operator has never touched in Discord still behaves
exactly as the deployed config says, and a group that has been overridden is reported as such in
the panel and in the startup log, so a deploy that "did nothing" is diagnosable.

## Components

### `src/rules/tierStore.ts` (new)

```ts
class TierStore {
  constructor(db: Db, envTiers: Record<GroupName, Tier>, opts: {
    approvalMode: boolean;
    /** False when any of the four DISCORD_* vars is absent; `set` then refuses `gated`. */
    discordConfigured: boolean;
  });
  effective(): Readonly<Record<GroupName, Tier>>;
  enabled(): ReadonlySet<GroupName>;   // tier !== 'off'
  gated(): ReadonlySet<GroupName>;     // tier === 'gated'
  set(group: GroupName, tier: Tier): void;   // throws TierRejected on gated-without-Discord
  reset(group: GroupName): void;
  sourceOf(group: GroupName): 'override' | 'env' | 'default';
}
```

`effective()` is the primary accessor; `enabled()` and `gated()` are views of it kept because the
existing call sites want sets. Every accessor returns a frozen value, never a set the caller could
mutate or observe mutating mid-iteration.

`set` refuses `gated` when Discord is not configured, throwing `TierRejected` (the same shape as
`RuleRejected` in `customRules.ts`) for the panel to render. `loadConfig` already refuses to boot on
that combination — "a proposal nobody can see or click is worse than no approval gate at all"
(`config.ts:202`) — and an overlay written to the database would otherwise walk straight past that
check and accumulate invisible proposals.

Overrides are read into memory at construction and the cache is refreshed on write, following
`CustomRules`. One process owns the database, so the cache cannot go stale. `enabled()` and
`gated()` are memoised and invalidated on write, because they are called on every candidate.

`effective()` applies the `APPROVAL_MODE` coercion (`auto` becomes `gated`) *after* the overlay, so
there is one rule for how the global and the per-group setting interact rather than two that have
to be reconciled. The panel states this in its footer instead of offering an `Auto` button that
would silently not take.

`sourceOf` needs to tell "named in `RULES`" from "catalogue default", which `Config` currently
discards — `parseTiers` returns a partial map that is immediately spread over `DEFAULT_TIERS`. So
`Config` gains one field, `explicitTiers: Partial<Record<GroupName, Tier>>`, carrying that partial
through unmerged. `tiers`, `enabledGroups` and `gatedGroups` stay on `Config` and keep their present
meaning: the startup snapshot, and the input to the overlay.

**Validation ordering.** `config.ts:202` throws when any group is gated and a `DISCORD_*` var is
missing, and it runs before any database is open. Leave it exactly there: it is the guard for the
env layer, and moving it after `TierStore` would let a bad `.env` boot. The overlay layer is guarded
instead by `TierStore.set` refusing `gated` under the same condition, so both layers enforce one
rule at the point where each is written. An override that turns the last env-gated group `off`
therefore still cannot rescue a boot that `.env` alone would fail — correctly, because the operator
must be able to read the running config out of `.env` plus the panel, not out of a boot log.

### Schema

```ts
export const ruleTiers = sqliteTable('rule_tiers', {
  group: text('group').primaryKey(),
  tier: text('tier', { enum: ['auto', 'gated', 'off'] }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
```

`timestamp_ms` and an explicit `notNull` match the existing columns (`schema.ts:4`, `schema.ts:95`);
`set()` writes a fresh `Date`. SQLite will not enforce `GroupName`, so `TierStore` validates the key
against `isGroupName` on read as well as write — a row left by an older build naming a group that no
longer exists is ignored with a warning rather than crashing the load, the same tolerance
`isGated` already shows for stale group names (`tiers.ts:14`).

Generated with `npm run db:generate -- --name add_rule_tiers`.

### Live reads: value to getter

Every site that captured a set now takes a getter, so a read cannot return a startup snapshot:

| Site | Change |
|---|---|
| `Planner` | ctor arg 3: `ReadonlySet<GroupName>` -> `() => ReadonlySet<GroupName>` |
| `Resolver` | ctor arg 3, same |
| `Approvals` | `deps.enabledGroups` -> `deps.enabledGroups()` |
| `ScrubWorker` | `this.config.gatedGroups` -> a `gatedGroups()` dep |
| `Commands` | `deps.enabledRules` / `deps.gatedRules` -> getters |
| `index.ts` | passes `() => tierStore.enabled()` / `() => tierStore.gated()` |
| `index.ts:191` (`applyOneEntity`) | no code change — it reuses the long-lived `Resolver` from `index.ts:61`, so converting that ctor arg makes `/scrub replace` live for free. Listed because it is a **write path**, and it needs its own test. |
| `index.ts:139-142` (startup log) | built after `TierStore`, reporting effective tiers and marking overridden groups |

Nothing may re-snapshot a getter into a `const` that outlives the decision it feeds. See the worker
section below: that is where the mistake is easiest to make and worst to make.

The type change is the mechanism: it conscripts the compiler into finding every read site. The
alternative — sharing one mutable `Set` and mutating it in place — compiles untouched, which is
precisely why it is rejected: nothing at a call site would reveal that the value can change.

### `punctuation` and the startup capability gate

`index.ts` currently passes the worker a `findClusters` dep only when `punctuation` is enabled, and
its *absence* is what keeps ~280 API calls unspent. A live tier cannot rewire a constructor, so
that conditional must move:

- `index.ts` passes `findClusters` unconditionally.
- `ScrubWorker` gates the scan on `this.gatedGroups`-style live read —
  `enabled().has('punctuation')` — at the existing check around `worker.ts:192`.

The cost property is preserved: the calls still only happen when the group is on, now evaluated per
cycle instead of once at boot. The `clusterRan` stamping comment at `worker.ts:188` already
anticipates a group being turned on later and needs no change.

### `off` is a missing bucket, not just a missing set member

`splitByTier` (`tiers.ts:30`) partitions a candidate's edits two ways, gated and auto:

```ts
(isGated(edit.groups, gated) ? gatedEdits : autoEdits).push(edit);
```

There is no `off`. Today that is complete, because a group can only be `off` at boot and an off
group therefore never produces an edit to partition. Under live tiers it stops being complete: a
group flipped to `off` after planning makes `isGated` return `false`, the edit falls through to
`autoEdits`, and it is **written**. That is the same inversion as the drain hazard below, but it
fires during an ordinary cycle rather than only when the last gated group clears, which makes it the
more likely of the two to actually happen.

So `splitByTier(group, gated)` is replaced by `partitionByTier(group, tiers)`, taking the effective
tier map and returning three buckets:

```ts
interface TierSplit { off: EditGroup | undefined; gated: EditGroup | undefined; auto: EditGroup | undefined }
```

The precedence within one tuple is `off` > `gated` > `auto`, and it applies to the **whole tuple**,
for the reason `tiers.ts` already gives for gating: `Resolver.fold` folds a track rename and an
album rename into one `next`, and two POSTs against one `*_original` tuple cannot both land. An edit
tagged `['edition', 'live-track']` with `live-track` off is suppressed entirely — not written with
only the `edition` half — and the next sweep re-nominates the tuple with just the still-enabled
groups. Splitting it would auto-apply half of a change the operator asked to stop, which is exactly
what the existing comment says must never happen.

Suppressed tuples are recorded as `skipped` with a reason, so a cycle summary can say why an edit it
planned did not land.

### The `gated -> off` hazard, and a tier-aware drain

`ScrubWorker` (`worker.ts:150`) branches on whether anything is gated. The `else` branch, reached
when `gatedGroups.size === 0`, calls `Approvals.drainOnModeOff()` — and that method
(`approvals.ts:313`) does not cancel outstanding proposals, it **applies** them: each
`awaiting_approval` row is flipped to `planned` and written to Last.fm immediately.

Today that is defensible. Emptying `gatedGroups` requires editing `.env` and restarting, a
deliberate deployment-level act, and "supervision is off, apply the backlog" is a fair reading of it.

Live tiers break that reasoning. The same drain becomes reachable in two clicks: set the last
`gated` group to **off**, meaning *stop doing this*, and at the next cycle boundary the worker sees
an empty set and applies the entire pending backlog against real scrobble history. The production
ledger currently carries several hundred pending proposals. Last.fm edits are not reversible.

The defect is that mode-level state cannot express *why* the set emptied:

| Transition | Set empties | Correct behaviour |
|---|---|---|
| `gated -> auto` | yes | apply the backlog — the operator asked for it to happen unsupervised |
| `gated -> off`  | yes | retire the backlog — the operator asked for it *not* to happen |

So `drainOnModeOff` is replaced by a tier-aware `drainOnTierChange(effective)`, which partitions
pending proposals by the *current* tier of the groups that produced them:

- groups now `auto` — applied, exactly as today.
- groups now `off` — retired as `superseded` with `decidedBy: 'system'`, **never written**, and
  their ledger rows released (see below).

- groups still `gated` — untouched, still awaiting a decision.

This preserves the `CLAUDE.md` invariant that `awaiting_approval` is never auto-applied *against the
operator's intent*, and it removes the empty-set trigger entirely: the drain is now driven by the
tier map, which is the thing that actually changed.

**Releasing the ledger row.** `Approvals.retire` (`approvals.ts:532`) edits the Discord message and
nothing else — it never touches `applied_edits`. Every method that changes ledger state does so
explicitly: `expire()` sets `planned` (`approvals.ts:356`), `ignore()` sets `ignored`
(`approvals.ts:251`), `drainOnModeOff()` sets `planned` before applying (`approvals.ts:327`). So
retiring an off-tier proposal must carry its own ledger operation, or the row stays
`awaiting_approval` forever and permanently occupies the unique `*_original` tuple
(`schema.ts:53`) that a later correction needs.

The operation is a **delete** of the linked `applied_edits` rows and their `approval_edits` links,
in one transaction with the approval's status update. Deletion rather than a terminal status because
every `applied_edits` status means a decision was taken about that tuple's *content*, and here none
was: the edit was never attempted and the operator's instruction was "do not run this rule", not
"this correction is wrong". Leaving a terminal row would silently veto a future correction of the
same tuple by an unrelated rule. Deleting frees it, and the next sweep re-nominates if anything
still applies.

`drainOnModeOff` is removed rather than kept alongside, so there is no second path to a pending
proposal. Its caller at `worker.ts:163` becomes a `drainOnTierChange(tierStore.effective())` call
made unconditionally, not inside the `gatedGroups.size === 0` branch — the empty-set condition is
what made it dangerous.

### Reading at the decision point, not the top of the cycle

`ScrubWorker.runOnce` snapshots at `worker.ts:148`:

```ts
const gatedGroups = this.config.gatedGroups;
```

and uses it far later, inside `onGroup`, at `worker.ts:226`. Converting the *dependency* to a getter
while leaving this local `const` in place preserves precisely the staleness the change exists to
remove: the cycle would still decide every tuple against the tiers that were in force when it
started. The promise that "off means off now" lives or dies here.

So `onGroup` calls `this.tiers()` at the point of decision and passes the result to
`partitionByTier`. The same applies to the carry-over filter at `worker.ts:156` and to the
punctuation check below. A reviewer's rule of thumb for this PR: a getter assigned to a `const` that
outlives one decision is a bug.

The panel must also warn before the destructive half. Selecting `Off` for a group with outstanding
proposals re-renders with a confirmation step naming the count ("live-track has 41 proposals
pending; turning it off will discard them") rather than applying the change on the first click.

### Strip on a card whose group has since been turned off

`Approvals.strip` recomputes the alternative "remove the label instead of rewriting it" edit through
`strippedEdits` (`approvals.ts:426`), which calls `cleanTitle` with `enabledGroups`
(`approvals.ts:427`). Make that read live and a Strip click on an existing card stops recognising
the label once its group is off: `strippedEdits` returns nothing, `strip()` reports `no-op`
(`approvals.ts:197`) and resets the card to pending (`approvals.ts:198`). The operator gets a button
that silently does nothing, on a card that never clears.

The tier-aware drain already resolves this, and the resolution is ordering: an off group's proposals
are retired at the next cycle boundary, so the card is gone. The residual window is a click landing
between the tier change and that boundary. For it, `strip()` re-reads the effective tier for the
proposal's stored groups first and, if any is now `off`, retires the proposal through the same path
the drain uses and answers "that rule is switched off; the proposal has been discarded" instead of
`no-op`. One outcome, reachable two ways, never a dead button.

### `src/report/configPanel.ts` (new)

Pure functions, no `discord.js` import — a renderer and a `customId` codec, mirroring how
`proposals.ts` keeps its button ids testable without a client.

- `renderPanel(state) -> { content, components }` where `state` carries the effective tier and
  source per group, the selected group if any, whether the service is paused, and whether
  `APPROVAL_MODE` is forcing coercion.
- Ids are namespaced `cfg:` — `cfg:pick`, `cfg:set:<group>:<tier>`, `cfg:reset:<group>`, `cfg:back`,
  `cfg:pause`, `cfg:resume`.

### Gateway routing

`Gateway.onInteraction` gains a branch for string-select interactions and routes any `cfg:`
customId to the panel handler ahead of the approval path. `parseCustomId` already returns
`undefined` for unknown actions, so no existing behaviour changes.

The owner check reuses the existing `interaction.user.id !== ownerId` guard. Panel interactions use
`interaction.update()` rather than `deferUpdate()`: these are local SQLite writes, well inside the
3s ack budget, unlike an approval click which is a network write plus verification.

### Pause/resume

The panel's pause button drives `sweep_state.paused` through the same code path as `/scrub pause` —
`Commands.setPaused` extracted so there is one writer. No second live flag is introduced.

### `/scrub config`

A new subcommand on the existing `COMMAND_DEFINITION`, ephemeral, no options.

## UI

```
Rule configuration                          paused: no

  remaster       auto    (default)
  edition        auto    (default)
  live-track     off     (override)
  ep-single      gated   (env)
  punctuation    gated   (env)
  ...

[ Choose a rule to change...                        v ]

-- after choosing live-track --

live-track — currently off (override)
[ Auto ] [ Gated ] [ Off ] [ Reset to env ]
[ < Back ]  [ Pause sweeping ]
```

## Semantics of a change mid-cycle

Reads happen at each use, so:

- Turning a group **off** stops it applying to anything not yet written, including mid-cycle.
- Turning a group **on** takes effect from the next discovery pass, because the planner has already
  nominated for the running cycle.

A cycle can therefore be internally mixed. This is the accepted trade: "off" meaning "off now" is
worth more than a coherent cycle, and the alternative (staging until idle) would leave an urgent
stop waiting up to six hours behind `SWEEP_INTERVAL_MS`.

Turning a group **off** additionally retires its outstanding proposals at the next cycle boundary,
via the tier-aware drain above. Turning one from `gated` to `auto` applies them instead. Neither
transition may write an edit the operator has just asked to stop.

## Testing

TDD; behaviour change, so a failing test precedes each piece. No network, seams
constructor-injected as elsewhere.

- `test/rules/tierStore.test.ts` — default vs env vs override vs reset precedence; `sourceOf` for
  each layer; `APPROVAL_MODE` coercion applied after the overlay; memoisation invalidated on write.
- `test/report/configPanel.test.ts` — render for each state (no selection, selection, paused,
  coercion footer); `customId` round-trip; rejection of malformed ids.
- `test/report/gateway.test.ts` — `cfg:` ids route to the panel and not to the approval path;
  non-owner is rejected; an unknown `cfg:` action is ignored rather than throwing.
- `test/scrub/tiers.test.ts` — `partitionByTier`: an `off` tag suppresses the whole tuple even when
  another tag on it is `auto`; `off` beats `gated`; an album group goes one way whole; a stale
  non-group tag still does not suppress. This is the test that guards the irreversible case.
- `test/scrub/tierLiveness.test.ts` — a `Planner` built once nominates differently after
  `TierStore.set` flips a group, with no reconstruction; and a `ScrubWorker` mid-cycle does not
  write a tuple whose group was turned off *after* the cycle began. This is the test that would
  fail if someone reverted a getter to a captured value or re-snapshotted it into a `const`.
- `test/scrub/applyOneEntity.test.ts` — `/scrub replace` resolving through the long-lived resolver
  does not apply a group that has since been turned off. A write path, so it gets its own test.
- `test/rules/tierStore.test.ts` (additional) — `set('x', 'gated')` throws `TierRejected` when
  Discord is unconfigured; a `rule_tiers` row naming an unknown group is ignored with a warning
  rather than throwing.
- `test/scrub/approvals.test.ts` — the tier-aware drain: a pending proposal whose group is now
  `off` is retired and **no edit is written** (asserted against a spy editor, since this is the
  irreversible case); its `applied_edits` row and `approval_edits` link are gone, and a fresh
  correction on the same `*_original` tuple can then be inserted; one whose group is now `auto` is
  applied; one still `gated` is untouched. A test that the old empty-set trigger is gone, and one
  that `strip()` on an off group retires rather than answering `no-op`.
- `test/report/configPanel.test.ts` — selecting `Off` for a group with pending proposals renders
  the confirmation step and does not persist on the first click.
- `test/scrub/worker.test.ts` — the punctuation cluster scan runs when the group is enabled at
  cycle time and is skipped when it is not, with `findClusters` always injected.

## Documentation

- `CLAUDE.md` gains a short **Runtime configuration** section: tiers are live, `RULES` is the
  fallback, `rule_tiers` holds only overrides, and `APPROVAL_MODE` remains startup-only.
- The `src/report/` row of the Layout table says "REST-only Discord bot (no gateway)". `gateway.ts`
  is a websocket client handling commands and buttons; the REST-only property belongs to
  `reporter.ts`. Corrected narrowly, because it misdescribes a module this change edits.

## Out of scope

No generic settings table. No editing of credentials, pacing, or mode flags from Discord. No web
grid changes — `src/web/` is not on `main` yet, it lands with `matt/web-grid-library-mirror`, and
that branch will need `enabledRules` / `gatedRules` converted to getters when it rebases.
