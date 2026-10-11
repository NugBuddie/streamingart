import { type Ctx, fail, result, type Result } from './ctx.js';
import { loadPlayer, economy, vcApply, notify, type PlayerRow } from './store.js';
import { CITY_BY_ID } from '../data/world.js';
import { MIN } from '../data/progression.js';
import { tx } from '../db/index.js';
import type { DB } from '../db/index.js';

export interface CrewRef { id: number; name: string; tag: string; owner_id: number; max_members: number; role: string; members: number }

export function crewOf(db: DB, pid: number): CrewRef | undefined {
  return db.prepare(`SELECT c.id, c.name, c.tag, c.owner_id, c.max_members, m.role,
      (SELECT COUNT(*) FROM crew_members x WHERE x.crew_id = c.id) AS members
    FROM crew_members m JOIN crews c ON c.id = m.crew_id WHERE m.player_id = ?`).get(pid) as any;
}

export const areCrewmates = (db: DB, a: number, b: number) =>
  !!db.prepare('SELECT 1 FROM crew_members x JOIN crew_members y ON x.crew_id = y.crew_id WHERE x.player_id = ? AND y.player_id = ?').get(a, b);

/** Crew perks scale with the number of members. Energy discount on missions, loot bonus, raid power. */
export function crewBonus(db: DB, pid: number) {
  const c = crewOf(db, pid);
  const n = c?.members ?? 1;
  return { size: n, energyDiscount: Math.min(0.15, 0.03 * (n - 1)), lootBonus: 0.02 * (n - 1), raidBonus: 0.05 * (n - 1) };
}

const need = (db: DB, pid: number) => crewOf(db, pid) ?? fail('You are not in a crew. `/crew create` or `/crew join`.');

export function create(ctx: Ctx, pid: number, name: string, tag: string): Result {
  name = name.trim(); tag = tag.trim().toUpperCase();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{2,22}$/.test(name)) fail('Crew name: 3-23 characters (letters, numbers, space, _ -).');
  if (!/^[A-Z0-9]{2,5}$/.test(tag)) fail('Crew tag: 2-5 letters/numbers.');
  return tx(ctx.db, () => {
    const { db } = ctx;
    if (crewOf(db, pid)) fail('Leave your current crew first.');
    if (db.prepare('SELECT 1 FROM crews WHERE name = ? OR tag = ?').get(name, tag)) fail('That crew name or tag is taken.');
    const cid = Number(db.prepare('INSERT INTO crews (name,tag,owner_id,max_members,created_at) VALUES (?,?,?,?,?)').run(name, tag, pid, economy(db).crew_base_size, ctx.now()).lastInsertRowid);
    db.prepare("INSERT INTO crew_members (crew_id,player_id,role,joined_at) VALUES (?,?,'owner',?)").run(cid, pid, ctx.now());
    return result('Crew founded', [`**[${tag}] ${name}** is born. Up to ${economy(db).crew_base_size} members (expand to ${economy(db).crew_max_size} with Void Coins).`, 'Invite scavengers with `/crew invite`.']);
  });
}

export function invite(ctx: Ctx, pid: number, targetId: number): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    const c = need(db, pid);
    if (c.role !== 'owner') fail('Only the crew owner can invite.');
    if (c.members >= c.max_members) fail(`Crew is full (${c.members}/${c.max_members}). Use \`/crew expand\`.`);
    const t = loadPlayer(ctx, targetId);
    if (crewOf(db, t.id)) fail(`${t.name} is already in a crew.`);
    db.prepare('INSERT OR REPLACE INTO crew_invites (crew_id,player_id,invited_by,expires_at) VALUES (?,?,?,?)').run(c.id, t.id, pid, ctx.now() + 60 * MIN);
    notify(ctx, t.id, 'crew_invite', `👥 You were invited to join **[${c.tag}] ${c.name}**. Use \`/crew join ${c.name}\` within 1 hour.`);
    return result('Invite sent', [`${t.name} has been invited to [${c.tag}] ${c.name} (valid 1 hour).`]);
  });
}

export function join(ctx: Ctx, pid: number, crewName: string): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    if (crewOf(db, pid)) fail('Leave your current crew first.');
    const crew = db.prepare('SELECT * FROM crews WHERE name = ? OR tag = ?').get(crewName.trim(), crewName.trim()) as any;
    if (!crew) return fail('No such crew.');
    const inv = db.prepare('SELECT * FROM crew_invites WHERE crew_id = ? AND player_id = ? AND expires_at > ?').get(crew.id, pid, ctx.now());
    if (!inv) return fail('You need a valid invite from the crew owner.');
    const n = (db.prepare('SELECT COUNT(*) n FROM crew_members WHERE crew_id = ?').get(crew.id) as any).n;
    if (n >= crew.max_members) return fail('That crew is full.');
    db.prepare("INSERT INTO crew_members (crew_id,player_id,role,joined_at) VALUES (?,?,'member',?)").run(crew.id, pid, ctx.now());
    db.prepare('DELETE FROM crew_invites WHERE player_id = ?').run(pid);
    notify(ctx, crew.owner_id, 'crew', `👥 ${loadPlayer(ctx, pid).name} joined your crew.`);
    return result('Joined crew', [`You joined **[${crew.tag}] ${crew.name}** (${n + 1}/${crew.max_members}).`]);
  });
}

export function leave(ctx: Ctx, pid: number): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    const c = need(db, pid);
    db.prepare('DELETE FROM crew_members WHERE player_id = ?').run(pid);
    const heir = db.prepare('SELECT player_id FROM crew_members WHERE crew_id = ? ORDER BY joined_at LIMIT 1').get(c.id) as any;
    if (!heir) { db.prepare('DELETE FROM crews WHERE id = ?').run(c.id); return result('Crew disbanded', ['You were the last member; the crew is gone.']); }
    if (c.owner_id === pid) {
      db.prepare('UPDATE crews SET owner_id = ? WHERE id = ?').run(heir.player_id, c.id);
      db.prepare("UPDATE crew_members SET role = 'owner' WHERE player_id = ?").run(heir.player_id);
    }
    return result('Left crew', [`You left [${c.tag}] ${c.name}.`]);
  });
}

export function kick(ctx: Ctx, pid: number, targetId: number): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    const c = need(db, pid);
    if (c.role !== 'owner') fail('Only the owner can kick.');
    if (targetId === pid) fail('Use /crew leave.');
    const r = db.prepare('DELETE FROM crew_members WHERE crew_id = ? AND player_id = ?').run(c.id, targetId);
    if (!r.changes) fail('That player is not in your crew.');
    notify(ctx, targetId, 'crew', `You were removed from [${c.tag}] ${c.name}.`);
    return result('Kicked', ['Member removed.']);
  });
}

/** Spend Void Coins to grow the crew by one slot (5 -> 10). Idempotent per slot via the ledger key. */
export function expand(ctx: Ctx, pid: number): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    const e = economy(db);
    const c = need(db, pid);
    if (c.role !== 'owner') fail('Only the owner can expand the crew.');
    if (c.max_members >= e.crew_max_size) fail(`Your crew is already at the maximum of ${e.crew_max_size}.`);
    const cost = e.crew_expand_base_cost + e.crew_expand_step_cost * (c.max_members - e.crew_base_size);
    vcApply(ctx, pid, -cost, 'crew_expand', `crew:${c.id}:expand:${c.max_members + 1}`, `crew ${c.id}`);
    db.prepare('UPDATE crews SET max_members = max_members + 1 WHERE id = ?').run(c.id);
    return result('Crew expanded', [`🪙 -${cost} Void Coins. **[${c.tag}] ${c.name}** now holds ${c.max_members + 1} members.`]);
  });
}

export function info(ctx: Ctx, pid: number): Result {
  const { db } = ctx;
  const c = need(db, pid);
  const e = economy(db);
  const members = db.prepare(`SELECT p.id, p.name, p.level, p.city_id, m.role,
      EXISTS(SELECT 1 FROM missions x WHERE x.player_id = p.id AND x.status = 'active') AS on_mission
    FROM crew_members m JOIN players p ON p.id = m.player_id WHERE m.crew_id = ? ORDER BY m.joined_at`).all(c.id) as any[];
  const b = crewBonus(db, pid);
  const cost = c.max_members < e.crew_max_size ? e.crew_expand_base_cost + e.crew_expand_step_cost * (c.max_members - e.crew_base_size) : null;
  return result(`[${c.tag}] ${c.name}`, [
    `Members ${c.members}/${c.max_members}${cost !== null ? ` · expand cost ${cost} 🪙` : ' · max size'}`,
    `Perks: -${Math.round(b.energyDiscount * 100)}% mission energy, +${Math.round(b.lootBonus * 100)}% loot, +${Math.round(b.raidBonus * 100)}% raid power`,
    ...members.map((m) => `${m.role === 'owner' ? '👑' : '•'} ${m.name} (L${m.level}) — ${CITY_BY_ID[m.city_id]?.name}${m.on_mission ? ' 🧭' : ''}`),
  ], { crew: c, members, perks: b, expandCost: cost });
}

export type { PlayerRow };
