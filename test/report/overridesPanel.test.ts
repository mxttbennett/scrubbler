import { describe, expect, it } from 'vitest';
import { createDb, runMigrations, schema } from '../../src/db/index.js';
import { CustomRules } from '../../src/rules/customRules.js';
import { Planner } from '../../src/scrub/planner.js';
import {
  OverridesPanel,
  overridesBackId,
  overridesPageId,
  overridesPickId,
  overridesRemoveId,
  parseOverridesId,
} from '../../src/report/overridesPanel.js';

function harness() {
  const db = createDb(':memory:');
  runMigrations(db);
  const customRules = new CustomRules(db);
  return { db, customRules, panel: new OverridesPanel({ db, customRules }) };
}

function ignore(h: ReturnType<typeof harness>, artist: string, title: string) {
  h.db
    .insert(schema.ignored)
    .values({ kind: 'track', artist, title, reason: 'never' })
    .run();
}

describe('overrides panel ids', () => {
  it('round-trips the ids the renderer issues', () => {
    expect(parseOverridesId(overridesRemoveId('rule', 7))).toEqual({
      action: 'remove',
      kind: 'rule',
      id: 7,
    });
    expect(parseOverridesId(overridesPageId(3))).toEqual({ action: 'page', page: 3 });
    expect(parseOverridesId(overridesBackId())).toEqual({ action: 'back' });
    expect(parseOverridesId('ovr:pick:ignore:4')).toEqual({
      action: 'pick',
      kind: 'ignore',
      id: 4,
    });
  });

  it('rejects ids from another panel or with a bad payload', () => {
    expect(parseOverridesId('cfg:back')).toBeUndefined();
    expect(parseOverridesId('approve:1')).toBeUndefined();
    expect(parseOverridesId('ovr:remove:artist:1')).toBeUndefined();
    expect(parseOverridesId('ovr:remove:rule:nope')).toBeUndefined();
    expect(parseOverridesId('ovr:page:0')).toBeUndefined();
  });
});

describe('/scrub overrides', () => {
  it('lists replacements and ignores together, a replacement with its apply count', () => {
    const h = harness();
    h.customRules.add({ kind: 'track', artist: 'Jim', fromTitle: 'a', toTitle: 'b' });
    ignore(h, 'Nirvana', 'all apologies - live');

    const { content } = h.panel.handle();

    expect(content).toContain('replacements');
    expect(content).toContain('Jim — "a"');
    expect(content).toContain('never applied');
    expect(content).toContain('ignored');
    expect(content).toContain('Nirvana — "all apologies - live"');
    expect(content).toContain('2 override(s)');
  });

  it('says so when there is nothing overridden, and offers no controls', () => {
    const { content, components } = harness().panel.handle();
    expect(content).toContain('Nothing overridden');
    expect(components).toEqual([]);
  });

  /** The reason the four commands collapsed: removal is on the row you are looking at. */
  it('removes a replacement from the row rather than from retyped arguments', () => {
    const h = harness();
    const rule = h.customRules.add({ kind: 'track', artist: 'Jim', fromTitle: 'a', toTitle: 'b' });

    h.panel.handle(`ovr:pick:rule:${rule.id}`);
    const after = h.panel.handle(overridesRemoveId('rule', rule.id));

    expect(after.content).toContain('Removed the track replacement for Jim');
    expect(h.customRules.list()).toEqual([]);
  });

  /** The removal has to reach the planner, not just the table, or the entry stays invisible. */
  it('round-trips an ignore back into the planner', () => {
    const h = harness();
    ignore(h, 'Slint', 'Good Morning, Captain');
    const id = h.db.select().from(schema.ignored).all()[0]!.id;

    const planner = new Planner({} as never, 'u', () => new Set(['remaster']), h.db, 3);
    const candidate = { kind: 'track' as const, artist: 'Slint', title: 'Good Morning, Captain' };
    expect(planner.filterLive([candidate])).toEqual([]);

    const after = h.panel.handle(overridesRemoveId('ignore', id));

    expect(after.content).toContain('can be proposed again');
    expect(planner.filterLive([candidate])).toEqual([candidate]);
  });

  it('reports a second removal honestly rather than claiming it worked', () => {
    const h = harness();
    const rule = h.customRules.add({ kind: 'track', artist: 'Jim', fromTitle: 'a', toTitle: 'b' });
    h.panel.handle(overridesRemoveId('rule', rule.id));

    expect(h.panel.handle(overridesRemoveId('rule', rule.id)).content).toContain('already gone');
  });

  it('asks before removing, and Back leaves the entry alone', () => {
    const h = harness();
    const rule = h.customRules.add({ kind: 'track', artist: 'Jim', fromTitle: 'a', toTitle: 'b' });

    const picked = h.panel.handle(`ovr:pick:rule:${rule.id}`);
    expect(picked.content).toContain('Remove **track Jim');

    h.panel.handle(overridesBackId());
    expect(h.customRules.list()).toHaveLength(1);
  });

  it('pages once past the select cap, and clamps a page past the end', () => {
    const h = harness();
    for (let i = 0; i < 25; i++) ignore(h, 'A', `t${i}`);

    const first = h.panel.handle();
    expect(first.content).toContain('page 1/2');
    // Select row plus a paging row; one page would have the select alone.
    expect(first.components).toHaveLength(2);

    expect(h.panel.handle(overridesPageId(9)).content).toContain('page 2/2');
  });

  it('offers every row on the page to the select, keyed by kind and id', () => {
    const h = harness();
    const rule = h.customRules.add({ kind: 'track', artist: 'Jim', fromTitle: 'a', toTitle: 'b' });
    ignore(h, 'Nirvana', 'x');
    const ignoreId = h.db.select().from(schema.ignored).all()[0]!.id;

    const select = (h.panel.handle().components[0] as { components: { custom_id: string; options: { value: string }[] }[] })
      .components[0]!;

    expect(select.custom_id).toBe(overridesPickId());
    expect(select.options.map((o) => o.value)).toEqual([`rule:${rule.id}`, `ignore:${ignoreId}`]);
  });
});
