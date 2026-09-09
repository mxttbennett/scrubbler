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
  constructor(db: Db, envTiers: Record<GroupName, Tier>, approvalMode: boolean);
  effective(): Record<GroupName, Tier>;
  enabled(): ReadonlySet<GroupName>;   // tier !== 'off'
  gated(): ReadonlySet<GroupName>;     // tier === 'gated'
  set(group: GroupName, tier: Tier): void;
  reset(group: GroupName): void;
  sourceOf(group: GroupName): 'override' | 'env' | 'default';
}
```

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

### Schema

```
rule_tiers(
  group      TEXT PRIMARY KEY,
  tier       TEXT NOT NULL,
  updated_at INTEGER
)
```

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

## Testing

TDD; behaviour change, so a failing test precedes each piece. No network, seams
constructor-injected as elsewhere.

- `test/rules/tierStore.test.ts` — default vs env vs override vs reset precedence; `sourceOf` for
  each layer; `APPROVAL_MODE` coercion applied after the overlay; memoisation invalidated on write.
- `test/report/configPanel.test.ts` — render for each state (no selection, selection, paused,
  coercion footer); `customId` round-trip; rejection of malformed ids.
- `test/report/gateway.test.ts` — `cfg:` ids route to the panel and not to the approval path;
  non-owner is rejected; an unknown `cfg:` action is ignored rather than throwing.
- `test/scrub/tierLiveness.test.ts` — a `Planner` built once nominates differently after
  `TierStore.set` flips a group, with no reconstruction. This is the test that would fail if
  someone reverted a getter to a captured value.
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
