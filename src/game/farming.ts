import { type Ctx, fail, result, type Result } from './ctx.js';
import { loadPlayer, structureLevel, takeItem, addItem, qty } from './store.js';
import { CROPS, cropBySeed, MAX_PLANTERS } from '../data/crops.js';
import { findItem, label } from '../data/items.js';
import { MIN } from '../data/progression.js';
import { requireHome, requireShelter } from './shelter.js';
import { Rng, freshSeed } from './rng.js';
import { tx } from '../db/index.js';

interface PlanterRow { player_id: number; slot: number; crop_id: string; planted_at: number; ready_at: number; needs_water_at: number; second_watered_at: number | null }

/** Effective harvest time: a late second watering pushes it back by the time spent thirsty. Unwatered => stalled (null). */
export function readyAt(p: PlanterRow): number | null {
  if (p.second_watered_at === null) return null;
  return p.ready_at + Math.max(0, p.second_watered_at - p.needs_water_at);
}

function slotCount(ctx: Ctx, pid: number): number {
  return Math.min(MAX_PLANTERS, structureLevel(ctx.db, pid, 'planter')?.quantity ?? 0);
}

export function list(ctx: Ctx, pid: number): Result {
  const { db } = ctx;
  const n = slotCount(ctx, pid);
  const rows = db.prepare('SELECT * FROM planters WHERE player_id = ?').all(pid) as PlanterRow[];
  const now = ctx.now();
  const lines: string[] = [];
  const slots = [];
  for (let s = 1; s <= MAX_PLANTERS; s++) {
    const r = rows.find((x) => x.slot === s);
    let state: string, text: string;
    if (s > n) { state = 'locked'; text = '🔒 not built (`/craft make planter`)'; }
    else if (!r) { state = 'empty'; text = '🟫 empty'; }
    else {
      const ready = readyAt(r), c = CROPS[r.crop_id];
      if (ready !== null && now >= ready) { state = 'ready'; text = `✅ ${label(c.id)} ready to harvest!`; }
      else if (ready === null && now >= r.needs_water_at) { state = 'thirsty'; text = `💧 ${label(c.id)} is THIRSTY — growth paused. Water it!`; }
      else if (ready === null) { state = 'growing'; text = `🌱 ${label(c.id)} growing; needs water in ${Math.max(0, Math.ceil((r.needs_water_at - now) / MIN))} min`; }
      else { state = 'growing'; text = `🌱 ${label(c.id)} growing; ready in ${Math.ceil((ready - now) / MIN)} min`; }
    }
    lines.push(`**${s}.** ${text}`);
    slots.push({ slot: s, state, crop: r?.crop_id ?? null, readyAt: r ? readyAt(r) : null, needsWaterAt: r?.needs_water_at ?? null });
  }
  lines.push('', `Crops need 2 💧 clean water: at planting and halfway through growth. Seeds you own: ${Object.values(CROPS).map((c) => qty(db, pid, c.seed) ? label(c.seed, qty(db, pid, c.seed)) : null).filter(Boolean).join(', ') || 'none'}`);
  return result('Roof planters', lines, { slots });
}

export function plant(ctx: Ctx, pid: number, slot: number, seedQ: string): Result {
  const d = findItem(seedQ);
  const crop = d ? cropBySeed(d.id) ?? CROPS[d.id] : undefined;
  if (!crop) return fail('Pick a seed, e.g. `seed_potato`.');
  return tx(ctx.db, () => {
    const { db } = ctx;
    requireHome(loadPlayer(ctx, pid));
    requireShelter(ctx, pid);
    if (!Number.isInteger(slot) || slot < 1 || slot > slotCount(ctx, pid)) return fail(`Planter slot must be 1-${slotCount(ctx, pid) || '—'} (build more with /craft make planter, max ${MAX_PLANTERS}).`);
    if (db.prepare('SELECT 1 FROM planters WHERE player_id = ? AND slot = ?').get(pid, slot)) return fail('That planter is already in use.');
    takeItem(db, pid, crop.seed, 1);
    takeItem(db, pid, 'clean_water', 1);
    const now = ctx.now(), grow = crop.growMinutes * MIN;
    db.prepare('INSERT INTO planters (player_id,slot,crop_id,planted_at,ready_at,needs_water_at) VALUES (?,?,?,?,?,?)').run(pid, slot, crop.id, now, now + grow, now + Math.floor(grow / 2));
    db.prepare("INSERT INTO player_spend_log (player_id,category,item_id,quantity,created_at) VALUES (?,'farm','clean_water',1,?)").run(pid, now);
    return result('Planted', [`🌱 Planted ${label(crop.id)} in planter ${slot} (−1 seed, −1 💧). Water it again after ${Math.floor(crop.growMinutes / 2)} min; ready after ${crop.growMinutes} min.`]);
  });
}

export function water(ctx: Ctx, pid: number, slot: number): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    requireHome(loadPlayer(ctx, pid));
    requireShelter(ctx, pid);
    const r = db.prepare('SELECT * FROM planters WHERE player_id = ? AND slot = ?').get(pid, slot) as PlanterRow | undefined;
    if (!r) return fail('Nothing is planted there.');
    if (r.second_watered_at !== null) return fail('That crop has already had its second watering.');
    takeItem(db, pid, 'clean_water', 1);
    const now = ctx.now();
    db.prepare('UPDATE planters SET second_watered_at = ? WHERE player_id = ? AND slot = ?').run(now, pid, slot);
    db.prepare("INSERT INTO player_spend_log (player_id,category,item_id,quantity,created_at) VALUES (?,'farm','clean_water',1,?)").run(pid, now);
    const late = Math.max(0, now - r.needs_water_at);
    return result('Watered', [late > 0 ? `💧 Watered, but the crop was thirsty for ${Math.ceil(late / MIN)} min — harvest delayed by that long.` : '💧 Watered on time. Harvest as scheduled.']);
  });
}

export function harvest(ctx: Ctx, pid: number, slot?: number): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    requireHome(loadPlayer(ctx, pid));
    requireShelter(ctx, pid);
    const now = ctx.now();
    const rows = (db.prepare('SELECT * FROM planters WHERE player_id = ?' + (slot ? ' AND slot = ?' : '')).all(...(slot ? [pid, slot] : [pid])) as PlanterRow[])
      .filter((r) => { const t = readyAt(r); return t !== null && now >= t; });
    if (!rows.length) return fail('Nothing is ready to harvest.');
    const rng = new Rng(freshSeed());
    const lines: string[] = [];
    for (const r of rows) {
      const c = CROPS[r.crop_id];
      const n = rng.int(c.yield[0], c.yield[1]);
      addItem(db, pid, c.id, n);
      const seed = rng.chance(0.3) ? 1 : 0;
      if (seed) addItem(db, pid, c.seed, 1);
      db.prepare('DELETE FROM planters WHERE player_id = ? AND slot = ?').run(pid, r.slot);
      lines.push(`🧺 Planter ${r.slot}: ${label(c.id, n)}${seed ? ` + ${label(c.seed, 1)}` : ''}`);
    }
    return result('Harvest', lines);
  });
}
