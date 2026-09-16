import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { CustomRules } from '../rules/customRules.js';

export interface OverridesPayload {
  content: string;
  components: unknown[];
}

/** The two things the operator has told the service by hand, as one list. */
export type OverrideKind = 'rule' | 'ignore';

export interface OverrideRow {
  kind: OverrideKind;
  id: number;
  /** One line for the list; the select menu shows the same text, clipped to Discord's limits. */
  summary: string;
  detail: string;
}

export type OverridesAction =
  | { action: 'page'; page: number }
  | { action: 'pick'; kind: OverrideKind; id: number }
  | { action: 'remove'; kind: OverrideKind; id: number }
  | { action: 'back' };

// Under Discord's 25-option select cap, with room left for the paging row.
const PAGE_SIZE = 20;

export const overridesPickId = () => 'ovr:pick';
export const overridesRemoveId = (kind: OverrideKind, id: number) => `ovr:remove:${kind}:${id}`;
export const overridesPageId = (page: number) => `ovr:page:${page}`;
export const overridesBackId = () => 'ovr:back';

export function parseOverridesId(id: string): OverridesAction | undefined {
  const parts = id.split(':');
  if (parts[0] !== 'ovr') return undefined;
  if (id === 'ovr:back') return { action: 'back' };

  if (parts[1] === 'page' && parts.length === 3) {
    const page = Number(parts[2]);
    return Number.isInteger(page) && page >= 1 ? { action: 'page', page } : undefined;
  }
  if ((parts[1] === 'pick' || parts[1] === 'remove') && parts.length === 4) {
    const kind = parts[2];
    const rowId = Number(parts[3]);
    if (kind !== 'rule' && kind !== 'ignore') return undefined;
    if (!Number.isInteger(rowId) || rowId < 0) return undefined;
    return { action: parts[1] === 'pick' ? 'pick' : 'remove', kind, id: rowId };
  }
  return undefined;
}

/**
 * One list for the custom replacements and the ignore list, with removal on the row rather than as
 * a command. Retyping an artist and title exactly to undo something you are looking at was the
 * worst of the old surface, and it is the reason four subcommands collapse into this one.
 */
export class OverridesPanel {
  private page = 1;
  private selected: { kind: OverrideKind; id: number } | undefined;
  private notice: string | undefined;

  constructor(private readonly deps: { db: Db; customRules: CustomRules }) {}

  handle(customId?: string): OverridesPayload {
    const action = customId === undefined ? undefined : parseOverridesId(customId);
    if (action === undefined) {
      this.selected = undefined;
      this.notice = undefined;
      return this.render();
    }

    if (action.action === 'back') {
      this.selected = undefined;
      this.notice = undefined;
    }
    if (action.action === 'page') {
      this.page = action.page;
      this.selected = undefined;
    }
    if (action.action === 'pick') {
      this.selected = { kind: action.kind, id: action.id };
      this.notice = undefined;
    }
    if (action.action === 'remove') {
      this.notice = this.remove(action.kind, action.id);
      this.selected = undefined;
    }
    return this.render();
  }

  private remove(kind: OverrideKind, id: number): string {
    if (kind === 'rule') {
      const removed = this.deps.customRules.removeById(id);
      return removed === undefined
        ? 'That replacement is already gone.'
        : `Removed the ${removed.kind} replacement for ${removed.artist} — "${removed.fromTitle}".`;
    }
    const row = this.deps.db
      .select()
      .from(schema.ignored)
      .where(eq(schema.ignored.id, id))
      .get();
    if (row === undefined) return 'That ignore is already gone.';
    this.deps.db.delete(schema.ignored).where(eq(schema.ignored.id, id)).run();
    return `Removed ${row.artist} — "${row.title}". It can be proposed again on the next sweep.`;
  }

  rows(): OverrideRow[] {
    const rules = this.deps.customRules.list().map((r): OverrideRow => {
      const applied = r.timesApplied === 0 ? 'never applied' : `applied ${r.timesApplied}x`;
      return {
        kind: 'rule',
        id: r.id,
        summary: `${r.kind} ${r.artist} — "${r.fromTitle}"`,
        detail: `-> "${r.toTitle}"  (${applied})`,
      };
    });
    const ignores = this.deps.db
      .select()
      .from(schema.ignored)
      .all()
      .map((r): OverrideRow => ({
        kind: 'ignore',
        id: r.id,
        summary: `${r.kind} ${r.artist} — "${r.title}"`,
        detail: r.reason,
      }));
    return [...rules, ...ignores];
  }

  private render(): OverridesPayload {
    const all = this.rows();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const page = Math.min(Math.max(1, this.page), pages);
    this.page = page;
    const slice = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    const lines: string[] = [];
    const rules = slice.filter((r) => r.kind === 'rule');
    const ignores = slice.filter((r) => r.kind === 'ignore');
    if (rules.length > 0) {
      lines.push('replacements');
      for (const r of rules) lines.push(`  ${r.summary}`, `    ${r.detail}`);
    }
    if (ignores.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('ignored');
      for (const r of ignores) lines.push(`  ${r.summary}`);
    }
    if (all.length === 0) {
      lines.push('Nothing overridden. /scrub replace adds a replacement; the Never button ignores.');
    } else {
      lines.push('', `page ${page}/${pages} · ${all.length} override(s)`);
    }

    const chosen =
      this.selected === undefined
        ? undefined
        : slice.find((r) => r.kind === this.selected!.kind && r.id === this.selected!.id);

    const content =
      '```\n' +
      lines.join('\n') +
      '\n```' +
      (this.notice === undefined ? '' : `\n${this.notice}`) +
      (chosen === undefined ? '' : `\nRemove **${chosen.summary}**?`);

    return { content, components: this.components(slice, pages, page, chosen) };
  }

  private components(
    slice: OverrideRow[],
    pages: number,
    page: number,
    chosen: OverrideRow | undefined,
  ): unknown[] {
    if (chosen !== undefined) {
      return [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 4,
              label: 'Remove',
              custom_id: overridesRemoveId(chosen.kind, chosen.id),
            },
            { type: 2, style: 2, label: '< Back', custom_id: overridesBackId() },
          ],
        },
      ];
    }
    if (slice.length === 0) return [];

    const rows: unknown[] = [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: overridesPickId(),
            placeholder: 'Choose one to remove...',
            options: slice.map((r) => ({
              label: r.summary.slice(0, 100),
              value: `${r.kind}:${r.id}`,
              description: r.detail.slice(0, 100),
            })),
          },
        ],
      },
    ];
    if (pages > 1) {
      rows.push({
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            label: '< Prev',
            custom_id: overridesPageId(Math.max(1, page - 1)),
            ...(page === 1 ? { disabled: true } : {}),
          },
          {
            type: 2,
            style: 2,
            label: 'Next >',
            custom_id: overridesPageId(Math.min(pages, page + 1)),
            ...(page === pages ? { disabled: true } : {}),
          },
        ],
      });
    }
    return rows;
  }
}
