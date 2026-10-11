import { Client, EmbedBuilder, Events, GatewayIntentBits, type ChatInputCommandInteraction, type AutocompleteInteraction } from 'discord.js';
import { config } from '../config.js';
import type { Ctx, Result } from '../game/ctx.js';
import { GameError } from '../game/ctx.js';
import { run } from '../game/actions.js';
import { playerByDiscord } from '../game/store.js';
import { route } from './router.js';
import { CITIES } from '../data/world.js';
import { ITEMS } from '../data/items.js';
import { RECIPES } from '../data/recipes.js';

const COLORS: Record<string, number> = { mission: 0x3b82f6, attack: 0xdc2626, merchant: 0xf59e0b, crew: 0x8b5cf6, planter: 0x16a34a, craft: 0x64748b };

export function toEmbed(r: Result, action: string): EmbedBuilder {
  let text = r.lines.join('\n');
  if (text.length > 4000) text = text.slice(0, 3990) + '\n…';
  return new EmbedBuilder().setTitle(r.title.slice(0, 256)).setDescription(text || '—').setColor(COLORS[action.split('/')[0]] ?? 0x475569);
}

// Light per-user throttle so a button-masher can't hammer SQLite (Discord itself rate-limits the REST side).
const lastUse = new Map<string, number>();

async function handle(ctx: Ctx, i: ChatInputCommandInteraction): Promise<void> {
  const now = Date.now();
  if (now - (lastUse.get(i.user.id) ?? 0) < 800) { await i.reply({ content: '⏳ Slow down a little.', ephemeral: true }); return; }
  lastUse.set(i.user.id, now);
  const r = route(i);
  await i.deferReply({ ephemeral: r.ephemeral });
  try {
    const me = playerByDiscord(ctx, i.user.id);
    const res = run(ctx, r.action, me?.id ?? null, r.args);
    await i.editReply({ embeds: [toEmbed(res, r.action)] });
  } catch (e) {
    if (e instanceof GameError) await i.editReply({ content: `❌ ${e.message}` });
    else { console.error(`[bot] ${i.commandName} failed`, e); await i.editReply({ content: '💥 Something went wrong in the wasteland. Try again.' }); }
  }
}

function autocomplete(i: AutocompleteInteraction): void {
  const f = i.options.getFocused(true);
  const q = String(f.value).toLowerCase();
  let pool: { name: string; value: string }[] = [];
  if (f.name === 'city') pool = CITIES.map((c) => ({ name: `${c.name} (${c.region}, ${'⚠'.repeat(c.danger)})`, value: c.id }));
  else if (f.name === 'recipe') pool = RECIPES.map((r) => ({ name: `${r.name} [${r.station}]`, value: r.id }));
  else if (f.name === 'seed') pool = Object.values(ITEMS).filter((x) => x.kind === 'seed').map((x) => ({ name: x.name, value: x.id }));
  else if (f.name === 'item') pool = Object.values(ITEMS).map((x) => ({ name: `${x.emoji} ${x.name}`, value: x.id }));
  i.respond(pool.filter((p) => p.name.toLowerCase().includes(q) || p.value.includes(q)).slice(0, 25)).catch(() => {});
}

/** Deliver queued notifications (raids, storms, finished missions...) as DMs. Failures retry up to 3 times. */
async function deliverNotifications(ctx: Ctx, client: Client): Promise<void> {
  const rows = ctx.db.prepare(`SELECT n.id, n.body, p.discord_id FROM notifications n JOIN players p ON p.id = n.player_id
    WHERE n.delivered_at IS NULL AND n.attempts < 3 AND p.discord_id IS NOT NULL ORDER BY n.id LIMIT 20`).all() as any[];
  for (const n of rows) {
    try {
      const user = await client.users.fetch(n.discord_id);
      await user.send({ content: n.body });
      ctx.db.prepare('UPDATE notifications SET delivered_at = ? WHERE id = ?').run(Date.now(), n.id);
    } catch {
      ctx.db.prepare('UPDATE notifications SET attempts = attempts + 1 WHERE id = ?').run(n.id); // DMs closed, etc.
    }
    await new Promise((r) => setTimeout(r, 400)); // be gentle with Discord's DM rate limits
  }
}

export async function startBot(ctx: Ctx): Promise<Client> {
  if (!config.discordToken) throw new Error('DISCORD_TOKEN is not set');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on(Events.InteractionCreate, (i) => {
    if (i.isChatInputCommand()) handle(ctx, i).catch((e) => console.error('[bot] handler crashed', e));
    else if (i.isAutocomplete()) autocomplete(i);
  });
  client.on(Events.Error, (e) => console.error('[bot] client error', e));
  client.once(Events.ClientReady, (c) => {
    console.log(`[bot] logged in as ${c.user.tag}`);
    let busy = false;
    setInterval(async () => { if (busy) return; busy = true; try { await deliverNotifications(ctx, client); } catch (e) { console.error('[bot] notify loop', e); } finally { busy = false; } }, 15_000);
  });
  await client.login(config.discordToken);
  return client;
}
