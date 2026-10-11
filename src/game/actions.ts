/**
 * The single game API. Discord slash commands and the REST endpoints both dispatch here,
 * so rules live in exactly one place. Action names double as REST paths: POST /api/<name>.
 */
import { type Ctx, GameError, fail, result, type Result } from './ctx.js';
import { loadPlayer, playerByDiscord, playerByName, economy, type PlayerRow } from './store.js';
import * as players from './players.js';
import * as missions from './missions.js';
import * as shelter from './shelter.js';
import * as crafting from './crafting.js';
import * as farming from './farming.js';
import * as crews from './crews.js';
import * as merchant from './merchant.js';
import * as raids from './raids.js';
import * as auth from './auth.js';
import { tick, worldStatus } from './world.js';
import { CITY_BY_ID } from '../data/world.js';

type Args = Record<string, any>;
interface ActionDef { method: 'GET' | 'POST'; player: boolean; run: (ctx: Ctx, pid: number, a: Args) => Result }

function target(ctx: Ctx, a: Args): PlayerRow {
  const p = a.discordId ? playerByDiscord(ctx, String(a.discordId)) : a.playerId ? loadPlayer(ctx, Number(a.playerId)) : a.name || a.target ? playerByName(ctx, String(a.name ?? a.target)) : fail('Specify a target player.');
  return p ?? fail('That scavenger has not registered.');
}
const str = (v: any, what: string): string => (typeof v === 'string' && v.trim() ? v.trim() : fail(`Missing ${what}.`));
const num = (v: any, d?: number) => (v === undefined || v === '' || v === null ? d : Number(v));

export const ACTIONS: Record<string, ActionDef> = {
  'player/register': { method: 'POST', player: false, run: (c, _p, a) => players.register(c, { name: str(a.name, 'name'), discordId: a.discordId, city: a.city }) },
  'player/status': { method: 'GET', player: true, run: (c, p) => players.status(c, p) },
  'player/inventory': { method: 'GET', player: true, run: (c, p) => players.inventoryView(c, p) },
  'player/use': { method: 'POST', player: true, run: (c, p, a) => players.use(c, p, str(a.item, 'item'), num(a.qty, 1)) },
  'player/equip': { method: 'POST', player: true, run: (c, p, a) => players.equip(c, p, str(String(a.item ?? ''), 'item')) },

  'vault/deposit': { method: 'POST', player: true, run: (c, p, a) => players.vaultMove(c, p, 'deposit', str(String(a.item ?? ''), 'item'), num(a.qty, 1)) },
  'vault/withdraw': { method: 'POST', player: true, run: (c, p, a) => players.vaultMove(c, p, 'withdraw', str(String(a.item ?? ''), 'item'), num(a.qty, 1)) },

  'world/cities': { method: 'GET', player: true, run: (c, p, a) => players.cities(c, p, a.region) },
  'world/travel': { method: 'POST', player: true, run: (c, p, a) => players.travel(c, p, str(a.city, 'city')) },
  'world/status': { method: 'GET', player: true, run: (c, p) => {
    const w = worldStatus(c), me = loadPlayer(c, p);
    merchant.ensureCityVisit(c, me.city_id);
    const here = c.db.prepare("SELECT COUNT(*) n FROM merchant_visits WHERE kind = 'city' AND city_id = ? AND status = 'open' AND expires_at > ?").get(me.city_id, c.now()) as any;
    return result('World', [
      `🌪️ Next storm <t:${Math.floor(w.nextStormAt / 1000)}:R> (${['', 'mild', 'strong', 'violent'][w.stormSeverity]}). Storm factor here ×${CITY_BY_ID[me.city_id].stormFactor}.`,
      here.n ? `🧳 The Wandering Merchant is in ${CITY_BY_ID[me.city_id].name} right now!` : `🧳 No merchant in ${CITY_BY_ID[me.city_id].name} at the moment.`,
      `🪙 1 Void Coin ≈ ${economy(c.db).vc_value} value units.`,
    ], { ...w, merchantHere: !!here.n });
  } },

  'mission/start': { method: 'POST', player: true, run: (c, p, a) => missions.start(c, p, a.length ?? 'standard') },
  'mission/report': { method: 'POST', player: true, run: (c, p) => missions.report(c, p) },

  'shelter/view': { method: 'GET', player: true, run: (c, p) => shelter.view(c, p) },
  'shelter/upgrade': { method: 'POST', player: true, run: (c, p, a) => shelter.upgrade(c, p, str(a.target, 'target')) },
  'shelter/repair': { method: 'POST', player: true, run: (c, p, a) => shelter.repair(c, p, a.target === 'door' ? 'door' : 'shelter') },
  'shelter/charge': { method: 'POST', player: true, run: (c, p, a) => shelter.charge(c, p, num(a.batteries, 1)!) },
  'shelter/discharge': { method: 'POST', player: true, run: (c, p, a) => shelter.discharge(c, p, num(a.times, 1)!) },
  'shelter/defense': { method: 'GET', player: true, run: (c, p) => raids.defenseView(c, p) },

  'craft/list': { method: 'GET', player: true, run: (c, p, a) => crafting.list(c, p, a.station) },
  'craft/make': { method: 'POST', player: true, run: (c, p, a) => crafting.make(c, p, str(a.recipe, 'recipe'), num(a.qty, 1)!) },
  'craft/repair': { method: 'POST', player: true, run: (c, p, a) => crafting.repairItem(c, p, str(String(a.item ?? ''), 'item')) },

  'planter/list': { method: 'GET', player: true, run: (c, p) => farming.list(c, p) },
  'planter/plant': { method: 'POST', player: true, run: (c, p, a) => farming.plant(c, p, num(a.slot)!, str(a.seed, 'seed')) },
  'planter/water': { method: 'POST', player: true, run: (c, p, a) => farming.water(c, p, num(a.slot)!) },
  'planter/harvest': { method: 'POST', player: true, run: (c, p, a) => farming.harvest(c, p, num(a.slot)) },

  'robot/view': { method: 'GET', player: true, run: (c, p) => crafting.robotView(c, p) },
  'robot/mode': { method: 'POST', player: true, run: (c, p, a) => crafting.robotMode(c, p, str(a.mode, 'mode')) },
  'robot/repair': { method: 'POST', player: true, run: (c, p) => crafting.robotRepair(c, p) },

  'crew/info': { method: 'GET', player: true, run: (c, p) => crews.info(c, p) },
  'crew/create': { method: 'POST', player: true, run: (c, p, a) => crews.create(c, p, str(a.name, 'name'), str(a.tag, 'tag')) },
  'crew/invite': { method: 'POST', player: true, run: (c, p, a) => crews.invite(c, p, target(c, a).id) },
  'crew/join': { method: 'POST', player: true, run: (c, p, a) => crews.join(c, p, str(a.name, 'crew name')) },
  'crew/leave': { method: 'POST', player: true, run: (c, p) => crews.leave(c, p) },
  'crew/kick': { method: 'POST', player: true, run: (c, p, a) => crews.kick(c, p, target(c, a).id) },
  'crew/expand': { method: 'POST', player: true, run: (c, p) => crews.expand(c, p) },

  'attack/player': { method: 'POST', player: true, run: (c, p, a) => raids.raid(c, p, target(c, a)) },

  'merchant/view': { method: 'GET', player: true, run: (c, p) => merchant.view(c, p) },
  'merchant/trade': { method: 'POST', player: true, run: (c, p, a) => merchant.trade(c, p, num(a.offer)!) },
  'voidcoins/view': { method: 'GET', player: true, run: (c, p) => merchant.voidCoins(c, p) },

  'web/linkcode': { method: 'POST', player: true, run: (c, p) => auth.createLinkCode(c, p) },
  'notifications/list': { method: 'GET', player: true, run: (c, p) => {
    const rows = c.db.prepare('SELECT id, kind, body, created_at, read_at FROM notifications WHERE player_id = ? ORDER BY id DESC LIMIT 20').all(p) as any[];
    c.db.prepare('UPDATE notifications SET read_at = ? WHERE player_id = ? AND read_at IS NULL').run(c.now(), p);
    return result('Notifications', rows.map((r) => `${r.read_at ? '' : '🔴 '}${r.body}`), { notifications: rows });
  } },
};

/** Run an action by name. Applies due world events first so every response reflects current state. */
export function run(ctx: Ctx, name: string, playerId: number | null, args: Args = {}): Result {
  const def = ACTIONS[name];
  if (!def) throw new GameError(`Unknown action "${name}".`);
  tick(ctx);
  if (def.player) {
    if (playerId === null) throw new GameError('You are not registered yet. Use /register first.');
    return def.run(ctx, playerId, args);
  }
  return def.run(ctx, 0, args);
}
