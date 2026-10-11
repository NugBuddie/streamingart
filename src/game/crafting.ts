import { type Ctx, fail, result, type Result } from './ctx.js';
import { loadPlayer, shelterOf, hasStructure, structureLevel, pay, fmtCost, missing, addItem, addEquipment, equipmentOf } from './store.js';
import { RECIPES, RECIPE_BY_ID, STRUCTURE_LIMITS, STRUCTURE_NAMES, type Recipe } from '../data/recipes.js';
import { ITEMS, label, findItem } from '../data/items.js';
import { requireHome, requireShelter } from './shelter.js';
import { tx } from '../db/index.js';

const STATION_NAME: Record<string, string> = { hand: '✋ By hand', workbench: '🛠️ Workbench', furnace: '🔥 Furnace', stove: '🍳 Stove', purifier: '🚰 Purifier' };
const STATION_STRUCT: Record<string, string> = { workbench: 'workbench', furnace: 'furnace', stove: 'stove', purifier: 'water_purifier' };

export function list(ctx: Ctx, pid: number, station?: string): Result {
  const { db } = ctx;
  const lines: string[] = [];
  for (const st of ['hand', 'workbench', 'furnace', 'purifier', 'stove']) {
    if (station && station !== st) continue;
    const rs = RECIPES.filter((r) => r.station === st);
    if (!rs.length) continue;
    const built = st === 'hand' || hasStructure(db, pid, STATION_STRUCT[st]);
    lines.push(`**${STATION_NAME[st]}**${built ? '' : ' 🚫 not built'}`);
    for (const r of rs) {
      const ok = !missing(db, pid, r.inputs).length;
      lines.push(`${ok ? '✅' : '▫️'} \`${r.id}\` ${r.name} ← ${fmtCost(r.inputs)}${r.power ? ` · ${r.power}⚡power` : ''}`);
    }
  }
  return result('Crafting recipes', lines, { recipes: RECIPES.map((r) => ({ ...r, canCraft: !missing(db, pid, r.inputs).length })) });
}

function findRecipe(q: string): Recipe {
  const s = q.trim().toLowerCase().replace(/\s+/g, '_');
  return RECIPE_BY_ID[s] ?? RECIPES.find((r) => r.name.toLowerCase() === q.trim().toLowerCase()) ?? fail(`Unknown recipe "${q}". See /craft list.`);
}

export function make(ctx: Ctx, pid: number, recipeQ: string, times = 1): Result {
  const r = findRecipe(recipeQ);
  times = Math.max(1, Math.min(50, Math.floor(times)));
  return tx(ctx.db, () => {
    const { db } = ctx;
    const p = loadPlayer(ctx, pid);
    if (r.station !== 'hand' || r.kind === 'structure') {
      requireHome(p);
      requireShelter(ctx, pid);
    }
    if (r.station !== 'hand') {
      if (!hasStructure(db, pid, STATION_STRUCT[r.station])) return fail(`You need a ${STATION_NAME[r.station]} (build it at the workbench) for this.`);
    }
    if (r.kind === 'structure') {
      const have = structureLevel(db, pid, r.output)?.quantity ?? 0;
      const limit = STRUCTURE_LIMITS[r.output] ?? 1;
      if (have >= limit) return fail(`You already have the maximum (${limit}) of ${STRUCTURE_NAMES[r.output]}.`);
      times = Math.min(times, limit - have);
    }
    if (r.kind === 'robot') {
      if (db.prepare('SELECT 1 FROM robots WHERE player_id = ?').get(pid)) return fail('You already own a Scav-Bot (upgrade it with /shelter upgrade robot).');
      times = 1;
    }
    if (r.kind === 'equipment') times = Math.min(times, 5);
    if (r.power) {
      const sh = shelterOf(db, pid);
      if (sh.power_charge < r.power * times) return fail(`Needs ${r.power * times}⚡ stored power (you have ${sh.power_charge}). Charge your power bank with batteries.`);
      db.prepare('UPDATE shelters SET power_charge = power_charge - ? WHERE player_id = ?').run(r.power * times, pid);
    }
    pay(ctx, pid, r.inputs, 'craft', times);
    const outQty = r.outputQty * times;
    switch (r.kind) {
      case 'item': addItem(db, pid, r.output, outQty); break;
      case 'equipment': for (let i = 0; i < times; i++) addEquipment(ctx, pid, r.output); break;
      case 'structure':
        db.prepare(`INSERT INTO shelter_structures (player_id,structure,level,quantity) VALUES (?,?,1,?)
          ON CONFLICT(player_id,structure) DO UPDATE SET quantity = quantity + excluded.quantity`).run(pid, r.output, times);
        break;
      case 'robot':
        db.prepare("INSERT INTO robots (player_id,level,mode,durability,max_durability,created_at) VALUES (?,1,'mission',150,150,?)").run(pid, ctx.now());
        break;
    }
    db.prepare('INSERT INTO craft_log (player_id,recipe_id,quantity,inputs_json,output_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(pid, r.id, times, JSON.stringify(Object.fromEntries(Object.entries(r.inputs).map(([k, v]) => [k, v * times]))), JSON.stringify({ [r.output]: outQty }), ctx.now());
    const made = r.kind === 'structure' ? `${STRUCTURE_NAMES[r.output]} ×${times}` : r.kind === 'robot' ? '🤖 Scav-Bot' : label(r.output, outQty);
    return result('Crafted', [`✅ Crafted ${made} (cost ${fmtCost(r.inputs, times)}${r.power ? `, ${r.power * times}⚡` : ''}).`]);
  });
}

/** Repair bench: restore durability of a weapon/tool. Cost: 1 scrap per 10 durability (+1 iron ingot per 30 for valuable gear). */
export function repairItem(ctx: Ctx, pid: number, ref: string): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    requireHome(loadPlayer(ctx, pid));
    requireShelter(ctx, pid);
    if (!hasStructure(db, pid, 'repair_bench')) return fail('You need a 🔨 Repair Bench (craft it at the workbench).');
    const id = Number(String(ref).replace('#', ''));
    const eq = equipmentOf(db, pid);
    const row = Number.isFinite(id) && id > 0 ? eq.find((e) => e.id === id)
      : eq.filter((e) => e.item_id === findItem(ref)?.id && e.durability < e.max_durability).sort((a, b) => a.durability - b.durability)[0];
    if (!row) return fail('No such gear. See /inventory for `#ids`.');
    const miss = row.max_durability - row.durability;
    if (miss <= 0) return fail('That item is already in perfect condition.');
    const cost: Record<string, number> = { scrap: Math.ceil(miss / 10) };
    if (ITEMS[row.item_id].value >= 25) cost.iron_ingot = Math.ceil(miss / 30);
    pay(ctx, pid, cost, 'repair');
    db.prepare('UPDATE player_equipment SET durability = max_durability WHERE id = ?').run(row.id);
    return result('Repaired', [`🔨 ${label(row.item_id)} restored to ${row.max_durability}/${row.max_durability} (cost ${fmtCost(cost)}).`]);
  });
}

// ----------------------------------------------------------------- robot
export function robotView(ctx: Ctx, pid: number): Result {
  const r = ctx.db.prepare('SELECT * FROM robots WHERE player_id = ?').get(pid) as any;
  if (!r) return fail('You have no Scav-Bot. Craft one: `/craft make scav_bot`.');
  return result('🤖 Scav-Bot', [
    `Level ${r.level} · durability ${r.durability}/${r.max_durability}${r.durability === 0 ? ' ❌ offline (repair it)' : ''}`,
    `Mode: **${r.mode === 'mission' ? 'Mission companion — extra bag space & scavenging bonus' : 'Home defender — fights beside turrets and doubles auto-collected monster loot'}**`,
    'Switch with `/robot mode`, repair with `/robot repair` (repair bench), upgrade with `/shelter upgrade robot`.',
  ], r);
}
export function robotMode(ctx: Ctx, pid: number, mode: string): Result {
  if (mode !== 'mission' && mode !== 'home') return fail('Mode must be `mission` or `home`.');
  if (mode === 'home' && ctx.db.prepare("SELECT 1 FROM missions WHERE player_id = ? AND status='active'").get(pid)) return fail('Your robot is out on a mission.');
  const r = ctx.db.prepare('UPDATE robots SET mode = ? WHERE player_id = ?').run(mode, pid);
  if (!r.changes) return fail('You have no Scav-Bot.');
  return result('Scav-Bot', [mode === 'mission' ? '🤖 Your Scav-Bot will follow you on missions.' : '🛡️ Your Scav-Bot now guards the shelter.']);
}
export function robotRepair(ctx: Ctx, pid: number): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    requireHome(loadPlayer(ctx, pid));
    requireShelter(ctx, pid);
    if (!hasStructure(db, pid, 'repair_bench')) return fail('You need a 🔨 Repair Bench.');
    const r = db.prepare('SELECT * FROM robots WHERE player_id = ?').get(pid) as any;
    if (!r) return fail('You have no Scav-Bot.');
    if (r.durability >= r.max_durability) return fail('Your Scav-Bot is fully repaired.');
    const cost = { scrap: Math.ceil((r.max_durability - r.durability) / 10), circuit: 1 };
    pay(ctx, pid, cost, 'repair');
    db.prepare('UPDATE robots SET durability = max_durability WHERE player_id = ?').run(pid);
    return result('Scav-Bot repaired', [`🔧 Fully repaired for ${fmtCost(cost)}.`]);
  });
}
