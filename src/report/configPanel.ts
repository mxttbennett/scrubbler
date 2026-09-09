import { ALL_GROUPS, type GroupName, type Tier, isGroupName, isTier } from '../rules/markers.js';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { TierStore } from '../rules/tierStore.js';

export interface PanelPayload {
  content: string;
  components: unknown[];
}

export interface PanelState {
  tiers: Readonly<Record<GroupName, Tier>>;
  sourceOf: (group: GroupName) => 'override' | 'env' | 'default';
  paused: boolean;
  approvalMode: boolean;
  selected?: GroupName;
  confirmOff?: { group: GroupName; pending: number };
}

export type ConfigAction =
  | { action: 'pick' }
  | { action: 'set'; group: GroupName; tier: Tier; confirmed?: true }
  | { action: 'reset'; group: GroupName }
  | { action: 'back' }
  | { action: 'pause' }
  | { action: 'resume' };

export const pickId = () => 'cfg:pick';
export const setId = (group: GroupName, tier: Tier, confirmed = false) =>
  `cfg:set:${group}:${tier}${confirmed ? ':confirm' : ''}`;
export const resetId = (group: GroupName) => `cfg:reset:${group}`;
export const backId = () => 'cfg:back';

export function parseConfigId(id: string): ConfigAction | undefined {
  const parts = id.split(':');
  if (parts[0] !== 'cfg') return undefined;
  if (id === 'cfg:pick') return { action: 'pick' };
  if (id === 'cfg:back') return { action: 'back' };
  if (id === 'cfg:pause') return { action: 'pause' };
  if (id === 'cfg:resume') return { action: 'resume' };
  if (parts[1] === 'reset' && parts.length === 3 && isGroupName(parts[2]!)) {
    return { action: 'reset', group: parts[2] };
  }
  if (
    parts[1] === 'set' &&
    (parts.length === 4 || parts.length === 5) &&
    isGroupName(parts[2]!) &&
    isTier(parts[3]!) &&
    (parts.length === 4 || parts[4] === 'confirm')
  ) {
    return {
      action: 'set',
      group: parts[2],
      tier: parts[3],
      ...(parts.length === 5 ? { confirmed: true as const } : {}),
    };
  }
  return undefined;
}

export function renderPanel(state: PanelState): PanelPayload {
  const lines = [`Rule configuration                          paused: ${state.paused ? 'yes' : 'no'}`, ''];
  for (const group of ALL_GROUPS) {
    lines.push(`${group.padEnd(14)} ${state.tiers[group].padEnd(6)} (${state.sourceOf(group)})`);
  }
  if (state.approvalMode) {
    lines.push('', 'APPROVAL_MODE is forcing auto rules to gated until restart.');
  }
  if (state.confirmOff !== undefined) {
    lines.push(
      '',
      `${state.confirmOff.group} has ${state.confirmOff.pending} proposal(s) pending; turning it off will discard them.`,
    );
  }
  if (state.selected !== undefined) {
    lines.push('', `${state.selected} - currently ${state.tiers[state.selected]} (${state.sourceOf(state.selected)})`);
  }

  return {
    content: lines.join('\n'),
    components:
      state.selected === undefined
        ? [picker(state)]
        : [tierButtons(state.selected, state.confirmOff), navButtons(state.paused)],
  };
}

export class ConfigPanel {
  private selected: GroupName | undefined;

  constructor(
    private readonly deps: { db: Db; tiers: TierStore; approvalMode: boolean },
  ) {}

  handle(customId = 'cfg:back'): PanelPayload {
    const pick = customId.match(/^cfg:pick:([^:]+)$/);
    if (pick !== null && isGroupName(pick[1]!)) {
      this.selected = pick[1];
      return this.render();
    }

    const action = parseConfigId(customId);
    if (action === undefined) return this.render();
    if (action.action === 'back') this.selected = undefined;
    if (action.action === 'pause') this.setPaused(true);
    if (action.action === 'resume') this.setPaused(false);
    if (action.action === 'reset') {
      this.deps.tiers.reset(action.group);
      this.selected = action.group;
    }
    if (action.action === 'set') {
      this.selected = action.group;
      const pending = action.tier === 'off' ? this.pendingFor(action.group) : 0;
      if (pending > 0 && action.confirmed !== true) {
        return this.render({ group: action.group, pending });
      }
      this.deps.tiers.set(action.group, action.tier);
    }
    return this.render();
  }

  private render(confirmOff?: { group: GroupName; pending: number }): PanelPayload {
    const row = this.deps.db
      .select()
      .from(schema.sweepState)
      .where(eq(schema.sweepState.id, 1))
      .get();
    return renderPanel({
      tiers: this.deps.tiers.effective(),
      sourceOf: (group) => this.deps.tiers.sourceOf(group),
      paused: row?.paused === true,
      approvalMode: this.deps.approvalMode,
      ...(this.selected === undefined ? {} : { selected: this.selected }),
      ...(confirmOff === undefined ? {} : { confirmOff }),
    });
  }

  private setPaused(paused: boolean): void {
    this.deps.db
      .insert(schema.sweepState)
      .values({ id: 1, paused })
      .onConflictDoUpdate({ target: schema.sweepState.id, set: { paused } })
      .run();
  }

  private pendingFor(group: GroupName): number {
    const pending = this.deps.db
      .select({ id: schema.approvals.id })
      .from(schema.approvals)
      .where(eq(schema.approvals.status, 'pending'))
      .all();
    if (pending.length === 0) return 0;
    const ids = pending.map((row) => row.id);
    const links = this.deps.db
      .select()
      .from(schema.approvalEdits)
      .where(inArray(schema.approvalEdits.approvalId, ids))
      .all();
    if (links.length === 0) return pending.length;
    const editIds = links.map((link) => link.appliedEditId);
    const edits = this.deps.db
      .select({ groups: schema.appliedEdits.groups })
      .from(schema.appliedEdits)
      .where(inArray(schema.appliedEdits.id, editIds))
      .all();
    return edits.filter((edit) => edit.groups.split(',').includes(group)).length;
  }
}

function picker(state: PanelState) {
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: pickId(),
        placeholder: 'Choose a rule to change...',
        options: ALL_GROUPS.map((group) => ({
          label: group,
          value: group,
          description: `${state.tiers[group]} (${state.sourceOf(group)})`,
        })),
      },
    ],
  };
}

function tierButtons(group: GroupName, confirmOff: PanelState['confirmOff']) {
  const offNeedsConfirm = confirmOff?.group === group;
  return {
    type: 1,
    components: [
      { type: 2, style: 2, label: 'Auto', custom_id: setId(group, 'auto') },
      { type: 2, style: 2, label: 'Gated', custom_id: setId(group, 'gated') },
      { type: 2, style: offNeedsConfirm ? 4 : 2, label: 'Off', custom_id: setId(group, 'off', offNeedsConfirm) },
      { type: 2, style: 2, label: 'Reset to env', custom_id: resetId(group) },
    ],
  };
}

function navButtons(paused: boolean) {
  return {
    type: 1,
    components: [
      { type: 2, style: 2, label: '< Back', custom_id: backId() },
      {
        type: 2,
        style: paused ? 3 : 4,
        label: paused ? 'Resume sweeping' : 'Pause sweeping',
        custom_id: paused ? 'cfg:resume' : 'cfg:pause',
      },
    ],
  };
}
