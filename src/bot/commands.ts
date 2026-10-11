import { SlashCommandBuilder, type SlashCommandSubcommandBuilder } from 'discord.js';

import { MISSION_LENGTHS, missionLabel } from '../data/progression.js';
import { START_CITIES, CITY_BY_ID } from '../data/world.js';

const LENGTHS = Object.values(MISSION_LENGTHS).map((l) => ({ name: `${l.id} (${missionLabel(l)}, ${l.energy}⚡)`, value: l.id }));

const sub = (name: string, desc: string, f?: (s: SlashCommandSubcommandBuilder) => SlashCommandSubcommandBuilder) =>
  (s: SlashCommandSubcommandBuilder) => { s.setName(name).setDescription(desc); return f ? f(s) : s; };

export const commandBuilders = [
  new SlashCommandBuilder().setName('register').setDescription('Join the game as a scavenger')
    .addStringOption((o) => o.setName('name').setDescription('Your scavenger name (3-24 chars)').setRequired(true))
    .addStringOption((o) => o.setName('city').setDescription('Where you wake up (safe starter towns)').setRequired(true)
      .addChoices(...START_CITIES.map((c) => ({ name: `${CITY_BY_ID[c].name} — ${CITY_BY_ID[c].archetype}`, value: c })))),
  new SlashCommandBuilder().setName('gather').setDescription('Pick up, chop or mine materials (no shelter needed)')
    .addStringOption((o) => o.setName('target').setDescription('What to gather').setRequired(true).addChoices(
      { name: '🌿 branches (by hand)', value: 'branches' }, { name: '🪨 small stones (by hand)', value: 'stones' }, { name: '🧵 rags / cloth (by hand)', value: 'rags' },
      { name: '🪓 chop wood (needs an axe)', value: 'chop' }, { name: '⛏️ mine stone & ore (needs a pickaxe)', value: 'mine' })),
  new SlashCommandBuilder().setName('status').setDescription('Energy, food, water, shelter and mission status'),
  new SlashCommandBuilder().setName('inventory').setDescription('List your items, gear and vault'),
  new SlashCommandBuilder().setName('use').setDescription('Eat, drink or heal with an item')
    .addStringOption((o) => o.setName('item').setDescription('Item to use').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('qty').setDescription('How many').setMinValue(1).setMaxValue(50)),
  new SlashCommandBuilder().setName('equip').setDescription('Equip a weapon')
    .addStringOption((o) => o.setName('item').setDescription('Weapon name or #id').setRequired(true).setAutocomplete(true)),
  new SlashCommandBuilder().setName('world').setDescription('Storm timer and merchant presence'),
  new SlashCommandBuilder().setName('cities').setDescription('List the 50 cities')
    .addStringOption((o) => o.setName('region').setDescription('Filter by region').addChoices(
      ...['ashfall', 'rustbelt', 'glasslands', 'deadmarsh', 'ironcoast'].map((r) => ({ name: r, value: r })))),
  new SlashCommandBuilder().setName('players').setDescription('Who is in your city and who you can raid'),
  new SlashCommandBuilder().setName('travel').setDescription('Travel to a city')
    .addStringOption((o) => o.setName('city').setDescription('Destination').setRequired(true).setAutocomplete(true)),

  new SlashCommandBuilder().setName('mission').setDescription('Scavenging missions')
    .addSubcommand(sub('start', 'Start a scavenging mission in your current city', (s) =>
      s.addStringOption((o) => o.setName('length').setDescription('Mission length').addChoices(...LENGTHS))))
    .addSubcommand(sub('report', 'Collect / view your mission outcome')),

  new SlashCommandBuilder().setName('shelter').setDescription('Your shelter')
    .addSubcommand(sub('view', 'Shelter status, structures and upgrades'))
    .addSubcommand(sub('build', 'Build your starter shelter (wood, stone, cloth)'))
    .addSubcommand(sub('upgrade', 'Upgrade shelter, door, vault, power bank, turrets or robot', (s) =>
      s.addStringOption((o) => o.setName('target').setDescription('What to upgrade').setRequired(true).addChoices(
        ...['shelter', 'door', 'vault', 'power_bank', 'turret', 'robot'].map((v) => ({ name: v, value: v }))))))
    .addSubcommand(sub('repair', 'Repair storm/raid damage with scrap', (s) =>
      s.addStringOption((o) => o.setName('target').setDescription('shelter (default) or door').addChoices({ name: 'shelter', value: 'shelter' }, { name: 'door', value: 'door' }))))
    .addSubcommand(sub('charge', 'Charge the power bank with batteries', (s) =>
      s.addIntegerOption((o) => o.setName('batteries').setDescription('Batteries to use').setMinValue(1).setMaxValue(20))))
    .addSubcommand(sub('recharge', 'Turn stored power into energy (10 power = 25⚡)', (s) =>
      s.addIntegerOption((o) => o.setName('times').setDescription('Times').setMinValue(1).setMaxValue(4)))),
  new SlashCommandBuilder().setName('defend').setDescription('Turrets, traps, door and recent attacks on your shelter'),

  new SlashCommandBuilder().setName('vault').setDescription('Raid-proof storage')
    .addSubcommand(sub('view', 'Show vault contents'))
    .addSubcommand(sub('deposit', 'Move an item into the vault', (s) =>
      s.addStringOption((o) => o.setName('item').setDescription('Item name or gear #id').setRequired(true).setAutocomplete(true))
        .addIntegerOption((o) => o.setName('qty').setDescription('Quantity').setMinValue(1))))
    .addSubcommand(sub('withdraw', 'Take an item out of the vault', (s) =>
      s.addStringOption((o) => o.setName('item').setDescription('Item name or gear #id').setRequired(true).setAutocomplete(true))
        .addIntegerOption((o) => o.setName('qty').setDescription('Quantity').setMinValue(1)))),

  new SlashCommandBuilder().setName('craft').setDescription('Crafting & repairs')
    .addSubcommand(sub('list', 'Show recipes', (s) => s.addStringOption((o) => o.setName('station').setDescription('Filter by station').addChoices(
      ...['hand', 'workbench', 'furnace', 'purifier', 'stove'].map((v) => ({ name: v, value: v }))))))
    .addSubcommand(sub('make', 'Craft something', (s) =>
      s.addStringOption((o) => o.setName('recipe').setDescription('Recipe').setRequired(true).setAutocomplete(true))
        .addIntegerOption((o) => o.setName('qty').setDescription('Times').setMinValue(1).setMaxValue(50))))
    .addSubcommand(sub('repair', 'Repair a weapon/tool at the repair bench', (s) =>
      s.addStringOption((o) => o.setName('item').setDescription('Item name or #id').setRequired(true).setAutocomplete(true)))),

  new SlashCommandBuilder().setName('planter').setDescription('Roof farming')
    .addSubcommand(sub('list', 'Show your planters'))
    .addSubcommand(sub('plant', 'Plant a seed (uses 1 clean water)', (s) =>
      s.addIntegerOption((o) => o.setName('slot').setDescription('Planter 1-6').setRequired(true).setMinValue(1).setMaxValue(6))
        .addStringOption((o) => o.setName('seed').setDescription('Seed').setRequired(true).setAutocomplete(true))))
    .addSubcommand(sub('water', 'Give the second watering (uses 1 clean water)', (s) =>
      s.addIntegerOption((o) => o.setName('slot').setDescription('Planter 1-6').setRequired(true).setMinValue(1).setMaxValue(6))))
    .addSubcommand(sub('harvest', 'Harvest ready crops', (s) => s.addIntegerOption((o) => o.setName('slot').setDescription('Planter (omit = all)').setMinValue(1).setMaxValue(6)))),

  new SlashCommandBuilder().setName('robot').setDescription('Your Scav-Bot companion')
    .addSubcommand(sub('view', 'Robot status'))
    .addSubcommand(sub('mode', 'Mission companion or home defender', (s) =>
      s.addStringOption((o) => o.setName('mode').setDescription('Mode').setRequired(true).addChoices({ name: 'mission companion', value: 'mission' }, { name: 'home defender', value: 'home' }))))
    .addSubcommand(sub('repair', 'Repair at the repair bench')),

  new SlashCommandBuilder().setName('attack').setDescription('PvP')
    .addSubcommand(sub('player', "Raid another scavenger's shelter (you must be in their city)", (s) =>
      s.addUserOption((o) => o.setName('user').setDescription('Target').setRequired(true)))),

  new SlashCommandBuilder().setName('crew').setDescription('Crews (5 members, expandable to 10)')
    .addSubcommand(sub('create', 'Found a crew', (s) =>
      s.addStringOption((o) => o.setName('name').setDescription('Crew name').setRequired(true))
        .addStringOption((o) => o.setName('tag').setDescription('2-5 char tag').setRequired(true))))
    .addSubcommand(sub('invite', 'Invite a scavenger (owner)', (s) => s.addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))))
    .addSubcommand(sub('join', 'Accept an invite', (s) => s.addStringOption((o) => o.setName('name').setDescription('Crew name or tag').setRequired(true))))
    .addSubcommand(sub('leave', 'Leave your crew'))
    .addSubcommand(sub('kick', 'Remove a member (owner)', (s) => s.addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))))
    .addSubcommand(sub('expand', 'Buy one more crew slot with Void Coins (owner)'))
    .addSubcommand(sub('info', 'Crew roster and perks'))
    .addSubcommand(sub('vault', 'Open the crew vault (leader / trusted members)'))
    .addSubcommand(sub('deposit', 'Put items from your inventory into the crew vault', (s) =>
      s.addStringOption((o) => o.setName('item').setDescription('Item').setRequired(true).setAutocomplete(true))
        .addIntegerOption((o) => o.setName('qty').setDescription('Quantity').setMinValue(1))))
    .addSubcommand(sub('reward', 'Give items from the crew vault to a member (leader / trusted)', (s) =>
      s.addStringOption((o) => o.setName('item').setDescription('Item').setRequired(true).setAutocomplete(true))
        .addIntegerOption((o) => o.setName('qty').setDescription('Quantity').setMinValue(1))
        .addUserOption((o) => o.setName('user').setDescription('Recipient (default: yourself)'))))
    .addSubcommand(sub('perms', 'Leader: grant or revoke vault access / raid command', (s) =>
      s.addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
        .addBooleanOption((o) => o.setName('vault').setDescription('Can open the vault, withdraw and reward'))
        .addBooleanOption((o) => o.setName('raid').setDescription('Can open and launch crew raids')))),

  new SlashCommandBuilder().setName('crewraid').setDescription('Group raids on monsters, abandoned buildings and rival crews')
    .addSubcommand(sub('targets', 'What can your crew raid in this city?'))
    .addSubcommand(sub('start', 'Open a raid lobby (leader / trusted)', (s) =>
      s.addStringOption((o) => o.setName('kind').setDescription('Raid type').setRequired(true).addChoices(
        { name: 'monster nest', value: 'monster' }, { name: 'abandoned building', value: 'building' }, { name: 'rival crew', value: 'crew' }))
        .addStringOption((o) => o.setName('target').setDescription('Monster id or rival crew name (see /crewraid targets)'))))
    .addSubcommand(sub('join', 'Join your crew\'s open raid lobby (costs energy, food, water)'))
    .addSubcommand(sub('leave', 'Leave the lobby and get refunded'))
    .addSubcommand(sub('launch', 'Launch the raid (organiser / leader)'))
    .addSubcommand(sub('cancel', 'Cancel the lobby and refund everyone'))
    .addSubcommand(sub('status', 'Lobby status and last raid result')),

  new SlashCommandBuilder().setName('merchant').setDescription('The Wandering Merchant')
    .addSubcommand(sub('view', 'See who is here and their offers'))
    .addSubcommand(sub('trade', 'Accept an offer', (s) => s.addIntegerOption((o) => o.setName('offer').setDescription('Offer id').setRequired(true)))),
  new SlashCommandBuilder().setName('voidcoins').setDescription('Void Coin balance and recent transactions'),
  new SlashCommandBuilder().setName('weblogin').setDescription('Get a one-time code to log in to the web client'),
  new SlashCommandBuilder().setName('notifications').setDescription('Recent shelter alerts'),
];

export const commandJson = () => commandBuilders.map((c) => c.toJSON());
