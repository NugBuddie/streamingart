/** Low-level data access shared by all services: players, inventory, equipment, ledger, notifications. */
import type { DB } from '../db/index.js';
import { type Ctx, fail } from './ctx.js';
import { ITEMS, FISTS, label, type WeaponStats } from '../data/items.js';
import type { Cost } from '../data/progression.js';
import { VAULT_CAPACITY } from '../data/progression.js';

export interface PlayerRow {
  id: number; discord_id: string | null; name: string; city_id: string; home_city_id: string;
  level: number; xp: number; hp: number; max_hp: number; energy: number; max_energy: number;
  food: number; max_food: number; water: number; max_water: number; void_coins: number; karma: number;
  raid_shield_until: number; protected_until: number; last_energy_at: number; created_at: number; last_seen_at: number;
}
export interface ShelterRow {
  player_id: number; city_id: string; level: number; hp: number; max_hp: number; door_level: number; door_hp: number;
  vault_level: number; power_charge: number; updated_at: number;
}
export interface EquipRow { id: number; player_id: number; item_id: string; durability: number; max_durability: number; equipped: number; location: string }

export const economy = (db: DB) => db.prepare('SELECT * FROM economy_stats WHERE id = 1').get() as any;
export const worldState = (db: DB) => db.prepare('SELECT * FROM world_state WHERE id = 1').get() as any;

// --------------------------------------------------------------- players
/** Loads a player and lazily applies energy regeneration (1 per N min; halved when starving/dehydrated). */
export function loadPlayer(ctx: Ctx, id: number): PlayerRow {
  const p = ctx.db.prepare('SELECT * FROM players WHERE id = ?').get(id) as PlayerRow | undefined;
  if (!p) return fail('Player not found.');
  return regen(ctx, p);
}

function regen(ctx: Ctx, p: PlayerRow): PlayerRow {
  const now = ctx.now();
  const stepMs = economy(ctx.db).energy_regen_minutes * 60_000 * (p.food === 0 || p.water === 0 ? 2 : 1);
  const steps = Math.floor((now - p.last_energy_at) / stepMs);
  if (steps <= 0) return p;
  const gain = Math.min(steps, p.max_energy - p.energy);
  const last = p.energy + gain >= p.max_energy ? now : p.last_energy_at + steps * stepMs;
  ctx.db.prepare('UPDATE players SET energy = energy + ?, last_energy_at = ? WHERE id = ?').run(gain, last, p.id);
  return { ...p, energy: p.energy + gain, last_energy_at: last };
}

export function playerByDiscord(ctx: Ctx, discordId: string): PlayerRow | undefined {
  const p = ctx.db.prepare('SELECT id FROM players WHERE discord_id = ?').get(discordId) as { id: number } | undefined;
  return p ? loadPlayer(ctx, p.id) : undefined;
}

export function playerByName(ctx: Ctx, name: string): PlayerRow | undefined {
  const p = ctx.db.prepare('SELECT id FROM players WHERE name = ?').get(name.trim()) as { id: number } | undefined;
  return p ? loadPlayer(ctx, p.id) : undefined;
}

export function shelterOf(db: DB, playerId: number): ShelterRow {
  return db.prepare('SELECT * FROM shelters WHERE player_id = ?').get(playerId) as ShelterRow;
}

export function structureLevel(db: DB, pid: number, structure: string): { level: number; quantity: number } | undefined {
  return db.prepare('SELECT level, quantity FROM shelter_structures WHERE player_id = ? AND structure = ? AND quantity > 0').get(pid, structure) as any;
}
export const hasStructure = (db: DB, pid: number, s: string) => !!structureLevel(db, pid, s);

export const isCriminal = (p: { karma: number }) => p.karma <= -3;

// ------------------------------------------------------------- inventory
export function qty(db: DB, pid: number, item: string): number {
  return (db.prepare('SELECT quantity FROM player_inventory WHERE player_id = ? AND item_id = ?').get(pid, item) as any)?.quantity ?? 0;
}
export function addItem(db: DB, pid: number, item: string, n: number): void {
  if (n <= 0) return;
  if (!ITEMS[item]) throw new Error(`unknown item ${item}`);
  db.prepare(`INSERT INTO player_inventory (player_id,item_id,quantity) VALUES (?,?,?)
    ON CONFLICT(player_id,item_id) DO UPDATE SET quantity = quantity + excluded.quantity`).run(pid, item, n);
}
export function takeItem(db: DB, pid: number, item: string, n: number): void {
  if (n <= 0) return;
  const r = db.prepare('UPDATE player_inventory SET quantity = quantity - ? WHERE player_id = ? AND item_id = ? AND quantity >= ?').run(n, pid, item, n);
  if (r.changes === 0) fail(`You don't have ${label(item, n)}.`);
  db.prepare('DELETE FROM player_inventory WHERE player_id = ? AND item_id = ? AND quantity = 0').run(pid, item);
}
export function inventory(db: DB, pid: number): Record<string, number> {
  const rows = db.prepare('SELECT item_id, quantity FROM player_inventory WHERE player_id = ?').all(pid) as any[];
  return Object.fromEntries(rows.map((r) => [r.item_id, r.quantity]));
}
export function missing(db: DB, pid: number, cost: Cost, mult = 1): string[] {
  return Object.entries(cost).filter(([, n]) => n > 0).flatMap(([id, n]) => {
    const have = qty(db, pid, id);
    return have < n * mult ? [`${label(id)} (${have}/${n * mult})`] : [];
  });
}
/** Atomically pay an item cost (call inside a tx). Logs to player_spend_log. */
export function pay(ctx: Ctx, pid: number, cost: Cost, category: string, mult = 1): void {
  const miss = missing(ctx.db, pid, cost, mult);
  if (miss.length) fail(`Missing: ${miss.join(', ')}`);
  for (const [id, n] of Object.entries(cost)) {
    if (n <= 0) continue;
    takeItem(ctx.db, pid, id, n * mult);
    ctx.db.prepare('INSERT INTO player_spend_log (player_id,category,item_id,quantity,created_at) VALUES (?,?,?,?,?)').run(pid, category, id, n * mult, ctx.now());
  }
}
export const fmtCost = (c: Cost, mult = 1) => Object.entries(c).filter(([, n]) => n > 0).map(([i, n]) => label(i, n * mult)).join(', ');

// -------------------------------------------------------------- equipment
export function addEquipment(ctx: Ctx, pid: number, item: string): number {
  const d = ITEMS[item];
  if (!d?.durability) throw new Error(`${item} is not equipment`);
  const r = ctx.db.prepare('INSERT INTO player_equipment (player_id,item_id,durability,max_durability,equipped,location,created_at) VALUES (?,?,?,?,0,?,?)')
    .run(pid, item, d.durability, d.durability, 'bag', ctx.now());
  return Number(r.lastInsertRowid);
}
export const equipmentOf = (db: DB, pid: number) =>
  db.prepare('SELECT * FROM player_equipment WHERE player_id = ? ORDER BY id').all(pid) as EquipRow[];

export interface Armed { eq?: EquipRow; stats: WeaponStats; name: string; ammoItem?: string }

/** Best usable weapon in the bag: equipped one first, else highest average damage. Falls back to fists. */
export function bestWeapon(db: DB, pid: number): Armed {
  const rows = (db.prepare("SELECT * FROM player_equipment WHERE player_id = ? AND location = 'bag' AND durability > 0").all(pid) as EquipRow[])
    .filter((e) => ITEMS[e.item_id]?.weapon)
    .filter((e) => { const w = ITEMS[e.item_id].weapon!; return !w.ranged || qty(db, pid, w.ammo!) > 0; });
  const score = (e: EquipRow) => (e.equipped ? 1000 : 0) + (ITEMS[e.item_id].weapon!.min + ITEMS[e.item_id].weapon!.max) / 2;
  rows.sort((a, b) => score(b) - score(a));
  const e = rows[0];
  if (!e) return { stats: FISTS, name: '👊 Fists' };
  const w = ITEMS[e.item_id].weapon!;
  return { eq: e, stats: w, name: label(e.item_id), ammoItem: w.ranged ? w.ammo : undefined };
}
export function ratchetOf(db: DB, pid: number): EquipRow | undefined {
  return db.prepare("SELECT * FROM player_equipment WHERE player_id = ? AND item_id = 'ratchet' AND location = 'bag' AND durability > 0 ORDER BY durability DESC LIMIT 1").get(pid) as any;
}
export function wear(db: DB, eqId: number, n: number): void {
  db.prepare('UPDATE player_equipment SET durability = MAX(0, durability - ?) WHERE id = ?').run(n, eqId);
}

// ------------------------------------------------------------------ vault
export function vaultUsed(db: DB, pid: number): number {
  const a = (db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM vault_contents WHERE player_id = ?').get(pid) as any).n;
  const b = (db.prepare("SELECT COUNT(*) n FROM player_equipment WHERE player_id = ? AND location = 'vault'").get(pid) as any).n;
  return a + b;
}
export const vaultCapacity = (db: DB, pid: number) => VAULT_CAPACITY[shelterOf(db, pid).vault_level];

// ---------------------------------------------------------- Void Coin ledger
/**
 * Exactly-once credit/debit. `key` must be deterministic for the logical event
 * (e.g. `mission:42:drop`); a repeat call returns false and changes nothing.
 */
export function vcApply(ctx: Ctx, pid: number, delta: number, reason: string, key: string, ref?: string): boolean {
  const { db } = ctx;
  if (delta === 0) return false;
  if (db.prepare('SELECT 1 FROM void_coin_transactions WHERE idempotency_key = ?').get(key)) return false;
  const r = db.prepare('UPDATE players SET void_coins = void_coins + ? WHERE id = ? AND void_coins + ? >= 0').run(delta, pid, delta);
  if (r.changes === 0) fail(`Not enough Void Coins (need ${-delta}).`);
  const bal = (db.prepare('SELECT void_coins b FROM players WHERE id = ?').get(pid) as any).b;
  db.prepare('INSERT INTO void_coin_transactions (player_id,delta,balance_after,reason,ref,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(pid, delta, bal, reason, ref ?? null, key, ctx.now());
  db.prepare(`UPDATE economy_stats SET ${delta > 0 ? 'total_vc_minted = total_vc_minted + ?' : 'total_vc_burned = total_vc_burned + ?'}, updated_at = ? WHERE id = 1`)
    .run(Math.abs(delta), ctx.now());
  return true;
}

// ---------------------------------------------------------------- notify
export function notify(ctx: Ctx, pid: number, kind: string, body: string): void {
  ctx.db.prepare('INSERT INTO notifications (player_id,kind,body,created_at) VALUES (?,?,?,?)').run(pid, kind, body, ctx.now());
}

/** Merge two loot maps. */
export function addTo(map: Record<string, number>, item: string, n: number) { if (n > 0) map[item] = (map[item] ?? 0) + n; }
export const lootText = (l: Record<string, number>) =>
  Object.entries(l).filter(([, n]) => n > 0).map(([i, n]) => label(i, n)).join(', ') || 'nothing';
export const bar = (v: number, max: number, w = 10) => {
  const f = Math.max(0, Math.min(w, Math.round((v / max) * w)));
  return '▰'.repeat(f) + '▱'.repeat(w - f);
};
