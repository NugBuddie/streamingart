/**
 * Wandering Merchant.
 * Visits are DETERMINISTIC per (city, time-slot): the RNG is seeded from the event key, and the visit row has a UNIQUE
 * event_key, so concurrent bots/web requests/restarts can never create the same visit (or its offers) twice.
 * Every offer carries an honest fairness label computed from item values — the UI tells you when it is a scam.
 */
import { type Ctx, fail, result, type Result } from './ctx.js';
import { loadPlayer, economy, worldState, vcApply, takeItem, addItem, addEquipment, notify } from './store.js';
import { CITY_BY_ID } from '../data/world.js';
import { ITEMS, isEquipment, label } from '../data/items.js';
import { MIN } from '../data/progression.js';
import { Rng, hashSeed } from './rng.js';
import { tx } from '../db/index.js';
import type { DB } from '../db/index.js';

const SELL_POOL = ['seed_potato', 'seed_carrot', 'seed_cabbage', 'seed_tomato', 'seed_corn', 'seed_pepper', 'seed_berries', 'arrows', 'bullets', 'bandage', 'medkit',
  'battery', 'circuit', 'tea_leaves', 'coffee_beans', 'hops', 'gunpowder', 'iron_ingot', 'copper_ingot', 'coal', 'bow', 'rifle', 'ratchet'];
const BUY_POOL = ['scrap', 'wood', 'cloth', 'wire', 'rope', 'iron_ingot', 'battery', 'monster_hide', 'bone', 'canned_food', 'clean_water', 'cooked_meat', 'potato', 'tomato', 'stone', 'coal'];
const MERCHANT_DAILY_VC_CAP = 150;

export type Fairness = 'good' | 'fair' | 'poor' | 'scam';
export const fairnessOf = (ratio: number): Fairness => (ratio >= 1.1 ? 'good' : ratio >= 0.88 ? 'fair' : ratio >= 0.7 ? 'poor' : 'scam');
export const FAIR_LABEL: Record<Fairness, string> = {
  good: '🌟 Real deal — better than fair', fair: '✅ Real deal — fair price', poor: '🟡 Overpriced', scam: '⚠️ POTENTIAL SCAM',
};

interface OfferSpec { gives_item?: string; gives_qty: number; gives_vc: number; wants_item?: string; wants_qty: number; wants_vc: number; stock: number }

function drawFactor(rng: Rng, scamRate: number): number {
  const r = rng.next();
  if (r < scamRate) return 0.3 + rng.next() * 0.3;
  if (r < scamRate + 0.18) return 0.7 + rng.next() * 0.15;
  return 0.9 + rng.next() * 0.4;
}
const itemQty = (rng: Rng, id: string, sellSide: boolean) => {
  const v = ITEMS[id].value;
  if (isEquipment(id)) return 1;
  if (v >= 20) return rng.int(1, 2);
  if (v >= 8) return rng.int(1, 4);
  return sellSide ? rng.int(3, 10) : rng.int(8, 24);
};

function genOffers(rng: Rng, vcValue: number, scamRate: number): OfferSpec[] {
  const out: OfferSpec[] = [];
  // 1) merchant sells an item for VC
  { const id = rng.pick(SELL_POOL), q = itemQty(rng, id, true), f = drawFactor(rng, scamRate);
    out.push({ gives_item: id, gives_qty: q, gives_vc: 0, wants_qty: 0, wants_vc: Math.max(1, Math.ceil((ITEMS[id].value * q) / (vcValue * f))), stock: isEquipment(id) ? 1 : 5 }); }
  // 2) merchant buys an item for VC
  { const id = rng.pick(BUY_POOL), q = itemQty(rng, id, false), f = drawFactor(rng, scamRate);
    out.push({ gives_qty: 0, gives_vc: Math.max(1, Math.floor((ITEMS[id].value * q * f) / vcValue)), wants_item: id, wants_qty: q, wants_vc: 0, stock: 3 }); }
  // 3+4) barter swaps
  for (let i = 0; i < 2; i++) {
    const g = rng.pick(SELL_POOL), w = rng.pick(BUY_POOL.filter((x) => x !== g)), gq = itemQty(rng, g, true), f = drawFactor(rng, scamRate);
    out.push({ gives_item: g, gives_qty: gq, gives_vc: 0, wants_item: w, wants_qty: Math.max(1, Math.round((ITEMS[g].value * gq) / f / ITEMS[w].value)), wants_vc: 0, stock: 3 });
  }
  return out;
}

const valueOf = (item: string | null | undefined, n: number, vc: number, vcValue: number) => (item ? ITEMS[item].value * n : 0) + vc * vcValue;

function insertVisit(ctx: Ctx, key: string, kind: string, cityId: string | null, pid: number | null, slot: number, start: number, expires: number): number | null {
  const { db } = ctx;
  const r = db.prepare('INSERT OR IGNORE INTO merchant_visits (event_key,kind,city_id,player_id,slot,starts_at,expires_at) VALUES (?,?,?,?,?,?,?)').run(key, kind, cityId, pid, slot, start, expires);
  if (r.changes === 0) return null; // already exists => offers already generated
  const id = Number(r.lastInsertRowid);
  const e = economy(db);
  const rng = new Rng(hashSeed(key + ':offers'));
  const ins = db.prepare(`INSERT INTO merchant_offers (visit_id,gives_item,gives_qty,gives_vc,wants_item,wants_qty,wants_vc,stock,ratio,fairness,expires_at)
    VALUES (@visit_id,@gives_item,@gives_qty,@gives_vc,@wants_item,@wants_qty,@wants_vc,@stock,@ratio,@fairness,@expires_at)`);
  for (const o of genOffers(rng, e.vc_value, e.merchant_scam_rate)) {
    const ratio = valueOf(o.gives_item, o.gives_qty, o.gives_vc, e.vc_value) / valueOf(o.wants_item, o.wants_qty, o.wants_vc, e.vc_value);
    ins.run({ visit_id: id, gives_item: o.gives_item ?? null, gives_qty: o.gives_qty, gives_vc: o.gives_vc, wants_item: o.wants_item ?? null, wants_qty: o.wants_qty, wants_vc: o.wants_vc,
      stock: o.stock, ratio: +ratio.toFixed(3), fairness: fairnessOf(ratio), expires_at: expires });
  }
  return id;
}

export const currentSlot = (ctx: Ctx) => Math.floor(ctx.now() / (worldState(ctx.db).merchant_slot_minutes * MIN));

/** Roll (deterministically) whether the merchant is in `cityId` this slot and create the visit once. */
export function ensureCityVisit(ctx: Ctx, cityId: string): void {
  const w = worldState(ctx.db);
  const slot = currentSlot(ctx), start = slot * w.merchant_slot_minutes * MIN;
  const expires = start + w.merchant_stay_minutes * MIN;
  if (ctx.now() >= expires) return;
  const key = `merchant:city:${cityId}:${slot}`;
  if (!new Rng(hashSeed(key)).chance(Math.max(0, CITY_BY_ID[cityId].merchantChance) * w.merchant_city_rate)) return;
  insertVisit(ctx, key, 'city', cityId, null, slot, start, expires);
}
export function ensureShelterVisit(ctx: Ctx, pid: number): void {
  if (!(ctx.db.prepare('SELECT built FROM shelters WHERE player_id = ?').get(pid) as any)?.built) return;
  const w = worldState(ctx.db);
  const slot = currentSlot(ctx), start = slot * w.merchant_slot_minutes * MIN;
  const expires = start + w.merchant_stay_minutes * MIN;
  if (ctx.now() >= expires) return;
  const key = `merchant:shelter:${pid}:${slot}`;
  if (!new Rng(hashSeed(key)).chance(w.merchant_shelter_rate)) return;
  if (insertVisit(ctx, key, 'shelter', null, pid, slot, start, expires) !== null) notify(ctx, pid, 'merchant', '🧳 The wandering merchant is knocking at your shelter door! Check `/merchant`.');
}
/** Mission encounter: a private 30-minute visit keyed by the mission id. */
export function createMissionVisit(ctx: Ctx, pid: number, missionId: number, cityId: string): void {
  const now = ctx.now();
  insertVisit(ctx, `merchant:mission:${missionId}`, 'mission', cityId, pid, currentSlot(ctx), now, now + 30 * MIN);
}

const offerLine = (o: any, traded: boolean) => {
  const side = (item: string | null, n: number, vc: number) => [item ? label(item, n) : '', vc ? `🪙 ${vc}` : ''].filter(Boolean).join(' + ');
  const pct = Math.round(o.ratio * 100);
  return `\`#${o.id}\` **Gives** ${side(o.gives_item, o.gives_qty, o.gives_vc)} **for** ${side(o.wants_item, o.wants_qty, o.wants_vc)} — ${FAIR_LABEL[o.fairness as Fairness]} (you get ~${pct}% of fair value)${traded ? ' ✔️ done' : o.stock <= 0 ? ' ❌ sold out' : ''}`;
};

export function view(ctx: Ctx, pid: number): Result {
  const { db } = ctx;
  const p = loadPlayer(ctx, pid);
  ensureCityVisit(ctx, p.city_id);
  if (p.city_id === p.home_city_id) ensureShelterVisit(ctx, pid);
  const now = ctx.now();
  const visits = db.prepare(`SELECT * FROM merchant_visits WHERE status = 'open' AND expires_at > ? AND (
      (kind = 'city' AND city_id = ?) OR (kind = 'shelter' AND player_id = ? AND ? = ?) OR (kind = 'mission' AND player_id = ?))
    ORDER BY expires_at`).all(now, p.city_id, pid, p.city_id, p.home_city_id, pid) as any[];
  if (!visits.length) {
    return result('Wandering Merchant', ['No merchant here right now. 🧳 They roam cities every hour and sometimes knock on shelter doors.', 'Safer cities see them more often.'], { visits: [] });
  }
  const lines: string[] = [];
  const data = [];
  for (const v of visits) {
    const offers = db.prepare("SELECT * FROM merchant_offers WHERE visit_id = ? AND status = 'open' ORDER BY id").all(v.id) as any[];
    const traded = new Set((db.prepare('SELECT offer_id FROM merchant_trades WHERE player_id = ?').all(pid) as any[]).map((t) => t.offer_id));
    lines.push(`**${v.kind === 'city' ? `🧳 Merchant in ${CITY_BY_ID[v.city_id].name}` : v.kind === 'shelter' ? '🧳 Merchant at your shelter door' : '🧳 Merchant met on your mission'}** — leaves in ${Math.max(0, Math.ceil((v.expires_at - now) / MIN))} min`);
    for (const o of offers) lines.push(offerLine(o, traded.has(o.id)));
    lines.push('');
    data.push({ visit: v, offers: offers.map((o) => ({ ...o, traded: traded.has(o.id) })) });
  }
  lines.push('Accept with `/merchant trade <offer id>`. Scams give you far less than fair value — you have been warned.');
  return result('Wandering Merchant', lines, { visits: data });
}

export function trade(ctx: Ctx, pid: number, offerId: number): Result {
  return tx(ctx.db, () => {
    const { db } = ctx;
    const p = loadPlayer(ctx, pid);
    const now = ctx.now();
    const o = db.prepare(`SELECT o.*, v.kind, v.city_id, v.player_id AS owner FROM merchant_offers o JOIN merchant_visits v ON v.id = o.visit_id
      WHERE o.id = ? AND o.status = 'open' AND o.expires_at > ? AND v.status = 'open'`).get(offerId, now) as any;
    if (!o) return fail('That offer is gone.');
    const here = o.kind === 'city' ? p.city_id === o.city_id : o.kind === 'shelter' ? o.owner === pid && p.city_id === p.home_city_id : o.owner === pid;
    if (!here) return fail('That merchant is not here.');
    if (o.stock <= 0) return fail('Sold out.');
    if (db.prepare('SELECT 1 FROM merchant_trades WHERE offer_id = ? AND player_id = ?').get(offerId, pid)) return fail('You already took this deal.');
    const e = economy(db);
    if (o.gives_vc > 0) {
      const earned = (db.prepare("SELECT COALESCE(SUM(delta),0) s FROM void_coin_transactions WHERE player_id = ? AND reason = 'merchant_sell' AND created_at > ?").get(pid, now - 24 * 60 * MIN) as any).s;
      if (earned + o.gives_vc > MERCHANT_DAILY_VC_CAP) return fail(`The merchant won't pay more than ${MERCHANT_DAILY_VC_CAP} 🪙 to you per day.`);
    }
    db.prepare('INSERT INTO merchant_trades (offer_id,player_id,created_at) VALUES (?,?,?)').run(offerId, pid, now);
    db.prepare('UPDATE merchant_offers SET stock = stock - 1 WHERE id = ? AND stock > 0').run(offerId);
    // pay
    if (o.wants_vc) vcApply(ctx, pid, -o.wants_vc, 'merchant_buy', `trade:${offerId}:${pid}:pay`, `offer ${offerId}`);
    if (o.wants_item) {
      takeItem(db, pid, o.wants_item, o.wants_qty);
      db.prepare("INSERT INTO player_spend_log (player_id,category,item_id,quantity,created_at) VALUES (?,'trade',?,?,?)").run(pid, o.wants_item, o.wants_qty, now);
    }
    // receive
    if (o.gives_vc) vcApply(ctx, pid, o.gives_vc, 'merchant_sell', `trade:${offerId}:${pid}:gain`, `offer ${offerId}`);
    if (o.gives_item) {
      if (isEquipment(o.gives_item)) for (let i = 0; i < o.gives_qty; i++) addEquipment(ctx, pid, o.gives_item);
      else addItem(db, pid, o.gives_item, o.gives_qty);
    }
    const warn = o.fairness === 'scam' ? ' You knew it was a scam…' : '';
    return result('Trade done', [`🤝 Deal #${offerId} completed.${warn}`, offerLine(o, true)]);
  });
}

export function voidCoins(ctx: Ctx, pid: number): Result {
  const p = loadPlayer(ctx, pid);
  const e = economy(ctx.db);
  const tx_ = ctx.db.prepare('SELECT delta, balance_after, reason, ref, created_at FROM void_coin_transactions WHERE player_id = ? ORDER BY id DESC LIMIT 10').all(pid) as any[];
  return result('Void Coins', [
    `🪙 Balance: **${p.void_coins}**`,
    `Earn them from rare mission drops and by trading with the Wandering Merchant; spend them on crew expansion and merchant goods.`,
    '', '**Recent transactions**',
    ...(tx_.length ? tx_.map((t) => `${t.delta > 0 ? '➕' : '➖'} ${Math.abs(t.delta)} — ${t.reason}${t.ref ? ` (${t.ref})` : ''} → ${t.balance_after} · <t:${Math.floor(t.created_at / 1000)}:R>`) : ['—']),
  ], { balance: p.void_coins, transactions: tx_, vcValue: e.vc_value });
}

/** Housekeeping: close visits/offers that are over. Safe to run repeatedly. */
export function expireMerchants(db: DB, now: number): void {
  db.prepare("UPDATE merchant_visits SET status = 'expired' WHERE status = 'open' AND expires_at <= ?").run(now);
  db.prepare("UPDATE merchant_offers SET status = 'expired' WHERE status = 'open' AND expires_at <= ?").run(now);
}
