/**
 * Gathering. No shelter needed.
 *   by hand : branches, small stones, rags (cloth)
 *   chop    : needs an axe      -> wood (+ branches)
 *   mine    : needs a pickaxe   -> stone, and with better tiers coal / copper / iron / adamantite
 * Tool tiers: 1 stone · 2 scrap · 3 copper · 4 iron · 5 forged steel · 6 adamantium. Better tiers yield more and unlock ores.
 * Stone tools are crude and break after ~12 uses, so you are pushed up the tier ladder.
 */
import { type Ctx, fail, result, type Result } from './ctx.js';
import { loadPlayer, addItem, addTo, lootText, equipmentOf, wear, inOpenCrewRaid, type EquipRow } from './store.js';
import { ITEMS, label } from '../data/items.js';
import { CITY_BY_ID } from '../data/world.js';
import { Rng, freshSeed } from './rng.js';
import { tx } from '../db/index.js';

export const TIER_NAMES = ['', 'Stone', 'Scrap', 'Copper', 'Iron', 'Forged Steel', 'Adamantium'];
const TIER_MULT = [0, 1, 1.4, 1.8, 2.4, 3.2, 4.5];

interface Node { item: string; minTier: number; w: number; min: number; max: number; minDanger?: number }
const ORE_TABLE: Node[] = [
  { item: 'stone', minTier: 1, w: 60, min: 2, max: 4 },
  { item: 'copper_ore', minTier: 2, w: 25, min: 1, max: 3 },
  { item: 'coal', minTier: 3, w: 20, min: 1, max: 3 },
  { item: 'iron_ore', minTier: 3, w: 25, min: 1, max: 3 },
  { item: 'adamantite_ore', minTier: 5, w: 5, min: 1, max: 2, minDanger: 4 },
];

export const GATHER_TARGETS = ['branches', 'stones', 'rags', 'chop', 'mine'] as const;

function bestTool(equip: EquipRow[], type: 'axe' | 'pickaxe'): EquipRow | undefined {
  return equip.filter((e) => e.location === 'bag' && e.durability > 0 && ITEMS[e.item_id].tool?.type === type)
    .sort((a, b) => ITEMS[b.item_id].tool!.tier - ITEMS[a.item_id].tool!.tier)[0];
}

export function gather(ctx: Ctx, pid: number, targetQ: string): Result {
  const target = String(targetQ ?? '').toLowerCase().trim();
  const alias: Record<string, string> = { branch: 'branches', sticks: 'branches', stone: 'mine', stones: 'stones', rocks: 'stones', cloth: 'rags', wood: 'chop', ore: 'mine' };
  const t = alias[target] ?? target;
  if (!(GATHER_TARGETS as readonly string[]).includes(t)) return fail(`Gather what? ${GATHER_TARGETS.join(', ')}.`);
  return tx(ctx.db, () => {
    const { db } = ctx;
    const p = loadPlayer(ctx, pid);
    if (db.prepare("SELECT 1 FROM missions WHERE player_id = ? AND status = 'active'").get(pid)) fail('You are out on a mission.');
    if (inOpenCrewRaid(db, pid)) fail('You are signed up for a crew raid.');
    const city = CITY_BY_ID[p.city_id];
    const energy = t === 'rags' ? 4 : t === 'chop' || t === 'mine' ? 6 : 3;
    const food = t === 'chop' || t === 'mine' ? 1 : 0, water = t === 'chop' || t === 'mine' ? 2 : 1;
    if (p.energy < energy) fail(`You're exhausted — this needs ${energy}⚡ (you have ${p.energy}).`);
    if (p.food < food || p.water < water) fail('You are too hungry/thirsty to work. Eat and drink first.');
    const rng = new Rng(freshSeed());
    const got: Record<string, number> = {};
    const lines: string[] = [];
    let toolRow: EquipRow | undefined, tier = 0;

    if (t === 'branches') addTo(got, 'branch', rng.int(2, 4));
    else if (t === 'stones') addTo(got, 'small_stone', rng.int(2, 4));
    else if (t === 'rags') { addTo(got, 'cloth', rng.int(1, 2)); if (rng.chance(0.25)) addTo(got, 'scrap', rng.int(1, 2)); }
    else {
      const type = t === 'chop' ? 'axe' : 'pickaxe';
      toolRow = bestTool(equipmentOf(db, pid), type);
      if (!toolRow) return fail(t === 'chop'
        ? 'You need an axe. Pick up 2 branches + 3 small stones and `/craft make recipe:stone_axe`.'
        : 'You need a pickaxe. Pick up 2 branches + 3 small stones and `/craft make recipe:stone_pickaxe`.');
      tier = ITEMS[toolRow.item_id].tool!.tier;
      if (t === 'chop') {
        addTo(got, 'wood', Math.max(1, Math.round(rng.int(2, 4) * TIER_MULT[tier])));
        if (rng.chance(0.3)) addTo(got, 'branch', rng.int(1, 3));
      } else {
        const pool = ORE_TABLE.filter((n) => n.minTier <= tier && city.danger >= (n.minDanger ?? 0));
        for (let i = 0; i < 2 + tier; i++) { const n = rng.weighted(pool, (x) => x.w); addTo(got, n.item, Math.max(1, Math.round(rng.int(n.min, n.max) * (1 + 0.15 * (tier - 1))))); }
      }
      wear(db, toolRow.id, 1);
    }

    db.prepare('UPDATE players SET energy = energy - ?, food = food - ?, water = water - ? WHERE id = ?').run(energy, food, water, pid);
    for (const [k, v] of Object.entries(got)) addItem(db, pid, k, v);
    const verb = { branches: 'pick up branches', stones: 'collect small stones', rags: 'search the ruins for rags', chop: 'chop trees', mine: 'mine the rock' }[t];
    lines.push(`You ${verb}${toolRow ? ` with your ${label(toolRow.item_id)} (${TIER_NAMES[tier]} tier)` : ''}: **${lootText(got)}**. (-${energy}⚡${food ? ` -${food}🍖` : ''} -${water}💧)`);
    if (toolRow) {
      const left = toolRow.durability - 1;
      lines.push(left <= 0 ? `💥 Your ${label(toolRow.item_id)} **broke**! (repair it at a repair bench, or craft a better one)` : left <= 4 ? `⚠️ ${label(toolRow.item_id)} is nearly worn out (${left}/${toolRow.max_durability}).` : `🔧 ${label(toolRow.item_id)} durability ${left}/${toolRow.max_durability}.`);
      if (t === 'mine' && tier < 3 && Object.keys(got).every((k) => k === 'stone')) lines.push('💡 A copper pickaxe or better finds coal and iron; a scrap pickaxe finds copper ore.');
    }
    return result('Gathered', lines, { got, target: t });
  });
}
