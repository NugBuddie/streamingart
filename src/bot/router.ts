import type { ChatInputCommandInteraction } from 'discord.js';

export interface Route { action: string; args: Record<string, unknown>; ephemeral?: boolean }

/** Maps a slash command (+subcommand) to a game action. The only Discord-specific piece of the action layer. */
export function route(i: ChatInputCommandInteraction): Route {
  const o = i.options;
  const sub = (() => { try { return o.getSubcommand(false); } catch { return null; } })();
  const user = () => ({ discordId: o.getUser('user', true).id });
  switch (i.commandName) {
    case 'register': return { action: 'player/register', args: { name: o.getString('name', true), city: o.getString('city'), discordId: i.user.id } };
    case 'status': return { action: 'player/status', args: {} };
    case 'inventory': return { action: 'player/inventory', args: {}, ephemeral: true };
    case 'use': return { action: 'player/use', args: { item: o.getString('item', true), qty: o.getInteger('qty') ?? 1 } };
    case 'equip': return { action: 'player/equip', args: { item: o.getString('item', true) } };
    case 'world': return { action: 'world/status', args: {} };
    case 'cities': return { action: 'world/cities', args: { region: o.getString('region') ?? undefined }, ephemeral: true };
    case 'players': return { action: 'world/players', args: {} };
    case 'travel': return { action: 'world/travel', args: { city: o.getString('city', true) } };
    case 'mission': return sub === 'start' ? { action: 'mission/start', args: { length: o.getString('length') ?? 'standard' } } : { action: 'mission/report', args: {} };
    case 'shelter':
      switch (sub) {
        case 'upgrade': return { action: 'shelter/upgrade', args: { target: o.getString('target', true) } };
        case 'repair': return { action: 'shelter/repair', args: { target: o.getString('target') ?? 'shelter' } };
        case 'charge': return { action: 'shelter/charge', args: { batteries: o.getInteger('batteries') ?? 1 } };
        case 'recharge': return { action: 'shelter/discharge', args: { times: o.getInteger('times') ?? 1 } };
        default: return { action: 'shelter/view', args: {}, ephemeral: true };
      }
    case 'defend': return { action: 'shelter/defense', args: {}, ephemeral: true };
    case 'vault':
      if (sub === 'deposit') return { action: 'vault/deposit', args: { item: o.getString('item', true), qty: o.getInteger('qty') ?? 1 }, ephemeral: true };
      if (sub === 'withdraw') return { action: 'vault/withdraw', args: { item: o.getString('item', true), qty: o.getInteger('qty') ?? 1 }, ephemeral: true };
      return { action: 'player/inventory', args: {}, ephemeral: true };
    case 'craft':
      if (sub === 'make') return { action: 'craft/make', args: { recipe: o.getString('recipe', true), qty: o.getInteger('qty') ?? 1 } };
      if (sub === 'repair') return { action: 'craft/repair', args: { item: o.getString('item', true) } };
      return { action: 'craft/list', args: { station: o.getString('station') ?? undefined }, ephemeral: true };
    case 'planter':
      if (sub === 'plant') return { action: 'planter/plant', args: { slot: o.getInteger('slot', true), seed: o.getString('seed', true) } };
      if (sub === 'water') return { action: 'planter/water', args: { slot: o.getInteger('slot', true) } };
      if (sub === 'harvest') return { action: 'planter/harvest', args: { slot: o.getInteger('slot') ?? undefined } };
      return { action: 'planter/list', args: {} };
    case 'robot': return { action: sub === 'mode' ? 'robot/mode' : sub === 'repair' ? 'robot/repair' : 'robot/view', args: { mode: o.getString('mode') ?? undefined } };
    case 'attack': return { action: 'attack/player', args: user() };
    case 'crew':
      switch (sub) {
        case 'create': return { action: 'crew/create', args: { name: o.getString('name', true), tag: o.getString('tag', true) } };
        case 'invite': return { action: 'crew/invite', args: user() };
        case 'join': return { action: 'crew/join', args: { name: o.getString('name', true) } };
        case 'leave': return { action: 'crew/leave', args: {} };
        case 'kick': return { action: 'crew/kick', args: user() };
        case 'expand': return { action: 'crew/expand', args: {} };
        case 'vault': return { action: 'crew/vault', args: {}, ephemeral: true };
        case 'deposit': return { action: 'crew/deposit', args: { item: o.getString('item', true), qty: o.getInteger('qty') ?? 1 } };
        case 'reward': { const u = o.getUser('user'); return { action: 'crew/reward', args: { item: o.getString('item', true), qty: o.getInteger('qty') ?? 1, ...(u ? { discordId: u.id } : {}) } }; }
        case 'perms': return { action: 'crew/perms', args: { discordId: o.getUser('user', true).id, vault: o.getBoolean('vault') ?? undefined, raid: o.getBoolean('raid') ?? undefined } };
        default: return { action: 'crew/info', args: {} };
      }
    case 'crewraid': return { action: `crewraid/${sub}`, args: { kind: o.getString('kind') ?? undefined, target: o.getString('target') ?? undefined }, ephemeral: sub === 'targets' };
    case 'merchant': return sub === 'trade' ? { action: 'merchant/trade', args: { offer: o.getInteger('offer', true) } } : { action: 'merchant/view', args: {} };
    case 'voidcoins': return { action: 'voidcoins/view', args: {}, ephemeral: true };
    case 'weblogin': return { action: 'web/linkcode', args: {}, ephemeral: true };
    case 'notifications': return { action: 'notifications/list', args: {}, ephemeral: true };
  }
  throw new Error(`unrouted command ${i.commandName}`);
}
