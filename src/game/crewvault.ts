/**
 * Crew vault: a shared stash. Anyone in the crew can DEPOSIT from their inventory.
 * Only the leader (and members the leader trusts via `can_vault`) can open it, and only they can REWARD items out
 * (to any crew member, themselves included). Crew-raid loot lands here. Every movement is written to crew_vault_log.
 */
import { type Ctx, fail, result, type Result } from './ctx.js';
import { loadPlayer, takeItem, addItem, notify, economy } from './store.js';
import { crewOf, type CrewRef } from './crews.js';
import { findItem, label } from '../data/items.js';
import { tx, type DB } from '../db/index.js';
import { log } from '../logger.js';

export const crewVaultCapacity = (db: DB, crew: { max_members: number }) => 200 + 40 * (crew.max_members - economy(db).crew_base_size);
export const vaultUsedUnits = (db: DB, crewId: number): number => (db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM crew_vault WHERE crew_id = ?').get(crewId) as any).n;

interface Access { crew: CrewRef; owner: boolean; canVault: boolean; canRaid: boolean }
export function accessOf(db: DB, pid: number): Access {
  const crew = crewOf(db, pid) ?? fail('You are not in a crew.');
  const m = db.prepare('SELECT can_vault, can_raid FROM crew_members WHERE player_id = ?').get(pid) as any;
  const owner = crew.role === 'owner';
  return { crew, owner, canVault: owner || !!m.can_vault, canRaid: owner || !!m.can_raid };
}

/** Add to the vault up to capacity. Returns how much fit. (Call inside a tx.) */
export function vaultAdd(ctx: Ctx, crewId: number, item: string, n: number, kind: string, actor: number | null, ref?: string): number {
  const { db } = ctx;
  const crew = db.prepare('SELECT max_members FROM crews WHERE id = ?').get(crewId) as any;
  const fit = Math.max(0, Math.min(n, crewVaultCapacity(db, crew) - vaultUsedUnits(db, crewId)));
  if (fit <= 0) return 0;
  db.prepare('INSERT INTO crew_vault (crew_id,item_id,quantity) VALUES (?,?,?) ON CONFLICT(crew_id,item_id) DO UPDATE SET quantity = quantity + excluded.quantity').run(crewId, item, fit);
  db.prepare('INSERT INTO crew_vault_log (crew_id,player_id,kind,item_id,quantity,ref,created_at) VALUES (?,?,?,?,?,?,?)').run(crewId, actor, kind, item, fit, ref ?? null, ctx.now());
  return fit;
}

export function view(ctx: Ctx, pid: number): Result {
  const { db } = ctx;
  const a = accessOf(db, pid);
  const cap = crewVaultCapacity(db, a.crew), used = vaultUsedUnits(db, a.crew.id);
  if (!a.canVault) {
    return result('Crew vault 🔒', [`The crew vault holds **${used}/${cap}** units, but only the leader (or members they trust) can open it.`, 'You can still deposit with `/crew deposit`.'], { restricted: true, used, capacity: cap });
  }
  const items = db.prepare('SELECT item_id, quantity FROM crew_vault WHERE crew_id = ? ORDER BY item_id').all(a.crew.id) as any[];
  const hist = db.prepare(`SELECT l.*, p.name AS actor, t.name AS target FROM crew_vault_log l LEFT JOIN players p ON p.id = l.player_id LEFT JOIN players t ON t.id = l.target_id
    WHERE l.crew_id = ? ORDER BY l.id DESC LIMIT 8`).all(a.crew.id) as any[];
  const verb: Record<string, (h: any) => string> = {
    deposit: (h) => `📥 ${h.actor} deposited`, reward: (h) => `🎁 ${h.actor} rewarded ${h.target ?? '?'}`, raid_loot: () => '⚔️ Raid loot', raid_stolen: () => '🏴 Stolen by a rival crew',
  };
  return result(`Crew vault — [${a.crew.tag}] ${a.crew.name}`, [
    `📦 ${used}/${cap} units`, ...(items.length ? items.map((i) => label(i.item_id, i.quantity)) : ['(empty)']),
    '', '**Recent activity**', ...(hist.length ? hist.map((h) => `${verb[h.kind](h)} ${label(h.item_id, h.quantity)} · <t:${Math.floor(h.created_at / 1000)}:R>`) : ['—']),
    '', a.owner ? 'Hand items out with `/crew reward`. Trust members with `/crew perms`.' : 'You were trusted with vault access by the leader.',
  ], { items, used, capacity: cap, history: hist });
}

export function deposit(ctx: Ctx, pid: number, itemQ: string, n = 1): Result {
  const d = findItem(itemQ) ?? fail(`Unknown item "${itemQ}".`);
  if (d.kind === 'weapon' || d.kind === 'tool') fail('Gear can’t go in the crew vault (only stackable items).');
  n = Math.max(1, Math.floor(n));
  return tx(ctx.db, () => {
    const a = accessOf(ctx.db, pid);
    takeItem(ctx.db, pid, d.id, n);
    const fit = vaultAdd(ctx, a.crew.id, d.id, n, 'deposit', pid);
    if (fit < n) { addItem(ctx.db, pid, d.id, n - fit); if (fit === 0) fail('The crew vault is full.'); }
    const me = loadPlayer(ctx, pid);
    log.info(`👥 [crew] ${me.name} deposited ${fit}× ${d.name} into [${a.crew.tag}] vault`);
    return result('Deposited', [`📥 ${label(d.id, fit)} added to the crew vault.${fit < n ? ` (${n - fit} returned — vault full)` : ''}`]);
  });
}

/** Leader / permitted member hands items out of the vault to any crew member (including themselves). */
export function reward(ctx: Ctx, pid: number, targetId: number | undefined, itemQ: string, n = 1): Result {
  const d = findItem(itemQ) ?? fail(`Unknown item "${itemQ}".`);
  n = Math.max(1, Math.floor(n));
  return tx(ctx.db, () => {
    const { db } = ctx;
    const a = accessOf(db, pid);
    if (!a.canVault) fail('Only the crew leader (or members they trust) can take items out of the crew vault.');
    const to = targetId ?? pid;
    if (!db.prepare('SELECT 1 FROM crew_members WHERE crew_id = ? AND player_id = ?').get(a.crew.id, to)) fail('You can only reward members of your own crew.');
    const r = db.prepare('UPDATE crew_vault SET quantity = quantity - ? WHERE crew_id = ? AND item_id = ? AND quantity >= ?').run(n, a.crew.id, d.id, n);
    if (!r.changes) fail(`The crew vault doesn't have ${label(d.id, n)}.`);
    db.prepare('DELETE FROM crew_vault WHERE crew_id = ? AND item_id = ? AND quantity = 0').run(a.crew.id, d.id);
    addItem(db, to, d.id, n);
    db.prepare("INSERT INTO crew_vault_log (crew_id,player_id,kind,item_id,quantity,target_id,created_at) VALUES (?,?,'reward',?,?,?,?)").run(a.crew.id, pid, d.id, n, to, ctx.now());
    const giver = loadPlayer(ctx, pid), taker = loadPlayer(ctx, to);
    if (to !== pid) notify(ctx, to, 'crew', `🎁 **${giver.name}** rewarded you ${label(d.id, n)} from the crew vault!`);
    log.info(`🎁 [crew] ${giver.name} rewarded ${taker.name} ${n}× ${d.name} from [${a.crew.tag}] vault`);
    return result('Reward given', [`🎁 ${taker.name} receives ${label(d.id, n)}.`]);
  });
}

/** Leader grants/revokes `vault` (open/withdraw/reward) and `raid` (start & launch crew raids). */
export function setPerms(ctx: Ctx, pid: number, targetId: number, perms: { vault?: boolean; raid?: boolean }): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    const a = accessOf(db, pid);
    if (!a.owner) fail('Only the crew leader can change permissions.');
    if (targetId === pid) fail('You are the leader — you already have every permission.');
    const m = db.prepare('SELECT * FROM crew_members WHERE crew_id = ? AND player_id = ?').get(a.crew.id, targetId) as any;
    if (!m) fail('That player is not in your crew.');
    const v = perms.vault ?? !!m.can_vault, r = perms.raid ?? !!m.can_raid;
    db.prepare('UPDATE crew_members SET can_vault = ?, can_raid = ? WHERE crew_id = ? AND player_id = ?').run(v ? 1 : 0, r ? 1 : 0, a.crew.id, targetId);
    const t = loadPlayer(ctx, targetId);
    notify(ctx, targetId, 'crew', `🔑 Your crew permissions changed: vault access ${v ? 'YES' : 'no'}, raid command ${r ? 'YES' : 'no'}.`);
    log.info(`🔑 [crew] ${loadPlayer(ctx, pid).name} set ${t.name}: vault=${v} raid=${r}`);
    return result('Permissions updated', [`🔑 **${t.name}** — vault access: ${v ? '✅' : '❌'} · can start crew raids: ${r ? '✅' : '❌'}`]);
  });
}
