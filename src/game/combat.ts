/** Combat helpers. Fighters expose `strike(rng)`; players consume ammo/durability inside it. */
import type { Ctx } from './ctx.js';
import type { Rng } from './rng.js';
import { type PlayerRow, bestWeapon, takeItem, wear } from './store.js';

export interface Duelist {
  name: string;
  hp: number;
  strike: (rng: Rng) => number;
}
export interface DuelResult { aHp: number; bHp: number; rounds: number; winner: 'a' | 'b' | 'none' }

/** Alternating strikes (a first). Ends at 0 hp or after maxRounds. */
export function duel(rng: Rng, a: Duelist, b: Duelist, maxRounds = 8): DuelResult {
  let aHp = a.hp, bHp = b.hp, r = 0;
  while (r < maxRounds && aHp > 0 && bHp > 0) {
    r++;
    bHp -= a.strike(rng);
    if (bHp <= 0) break;
    aHp -= b.strike(rng);
  }
  return { aHp: Math.max(0, aHp), bHp: Math.max(0, bHp), rounds: r, winner: bHp <= 0 ? 'a' : aHp <= 0 ? 'b' : 'none' };
}

export const npcStriker = (dmg: [number, number], hit = 0.85) => (rng: Rng) => (rng.chance(hit) ? rng.int(dmg[0], dmg[1]) : 0);

/** A player's strike: re-picks the best usable weapon each swing, burns durability + ammo, 12% miss. */
export function playerStriker(ctx: Ctx, p: PlayerRow, bonus = 1) {
  const lvl = 1 + 0.03 * (p.level - 1);
  return (rng: Rng) => {
    const w = bestWeapon(ctx.db, p.id);
    const dmg = rng.int(w.stats.min, w.stats.max);
    if (w.eq) wear(ctx.db, w.eq.id, 1);
    if (w.ammoItem) takeItem(ctx.db, p.id, w.ammoItem, 1);
    return rng.chance(0.88) ? Math.round(dmg * lvl * bonus) : 0;
  };
}

/** Avg damage × breach multiplier of the player's best weapon: how hard they hit doors & turrets. */
export function breachPower(ctx: Ctx, p: PlayerRow): { power: number; name: string; strong: boolean } {
  const w = bestWeapon(ctx.db, p.id);
  const avg = (w.stats.min + w.stats.max) / 2;
  return { power: avg * w.stats.breach * (1 + 0.03 * (p.level - 1)), name: w.name, strong: w.stats.breach >= 1.5 };
}
