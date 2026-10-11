// Void Scavengers web client: vanilla ES modules, talks to the same game actions as the Discord bot.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let token = localStorage.getItem('vs_token') || '';
let catalog = null, tab = 'status', cache = {};

// ---- tiny markdown-lite for the shared `lines` format (**bold**, `code`, Discord <t:..:R> timestamps)
function md(line) {
  return esc(line)
    .replace(/&lt;t:(\d+):[tR]&gt;/g, (_, t) => new Date(+t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
}
const linesHtml = (lines) => `<div class="lines">${lines.map((l) => (l === '' ? '<hr>' : `<p>${md(l)}</p>`)).join('')}</div>`;

async function api(path, method = 'GET', body) {
  const url = method === 'GET' && body ? `${path}?${new URLSearchParams(body)}` : path;
  const res = await fetch(`/api/${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const j = await res.json().catch(() => ({ ok: false, error: 'Bad response' }));
  if (res.status === 401) { logout(); throw new Error('Session expired'); }
  if (!j.ok) throw new Error(j.error || 'Error');
  return j;
}
function toast(text, bad = false) {
  const el = document.createElement('div');
  el.className = 'msg' + (bad ? ' bad' : '');
  el.innerHTML = md(text);
  $('#toast').prepend(el);
  setTimeout(() => el.remove(), bad ? 6000 : 9000);
}
async function act(path, body, { quiet = false } = {}) {
  try {
    const r = await api(path, 'POST', body);
    if (!quiet) toast([`**${r.title}**`, ...r.lines].join('\n'));
    await render();
    return r;
  } catch (e) { toast(e.message, true); }
}
const btn = (label, cls = '', attrs = '') => `<button class="btn ${cls}" ${attrs}>${label}</button>`;
const bar = (v, max, color) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, (v / max) * 100))}%;background:${color}"></i></div>`;
const itemLabel = (id, n) => { const d = catalog.items[id]; return `${d ? d.emoji + ' ' + d.name : id}${n === undefined ? '' : ' ×' + n}`; };

// ------------------------------------------------------------------ tabs
const TABS = ['status', 'mission', 'shelter', 'craft', 'farm', 'inventory', 'raid', 'crew', 'merchant', 'alerts'];
const views = {
  async status() {
    const r = await api('player/status'); cache.status = r.data;
    const { player: p, shelter: s, city, mission, crew } = r.data;
    return `<div class="grid">
      <div class="card"><h3>${esc(p.name)} · L${p.level}</h3>
        ❤️ HP ${p.hp}/${p.max_hp}${bar(p.hp, p.max_hp, 'var(--bad)')}
        ⚡ Energy ${p.energy}/${p.max_energy}${bar(p.energy, p.max_energy, 'var(--warn)')}
        🍖 Food ${p.food}/${p.max_food}${bar(p.food, p.max_food, 'var(--good)')}
        💧 Water ${p.water}/${p.max_water}${bar(p.water, p.max_water, 'var(--blue)')}
        <p>🪙 <b>${p.void_coins}</b> Void Coins ${p.karma <= -3 ? '· 🏴 <b>criminal</b>' : ''}</p></div>
      <div class="card"><h3>📍 ${esc(city.name)}</h3><p class="muted">${city.region} · danger ${'⚠️'.repeat(city.danger)} · ${city.archetype}</p>
        <p>🏚️ Shelter L${s.level}: ${s.hp}/${s.max_hp} HP · door ${s.door_hp} HP · ⚡ power ${s.power_charge}</p>
        ${crew ? `<p>👥 [${esc(crew.tag)}] ${esc(crew.name)}</p>` : ''}
        ${mission ? `<p>🧭 Mission ${mission.ends_at <= Date.now() ? '<b>ready!</b>' : 'ends ' + new Date(mission.ends_at).toLocaleTimeString()}</p>` : ''}</div>
    </div>
    <div class="card"><h3>Consume</h3><div class="row" id="eat">${await consumables()}</div></div>`;
  },
  async mission() {
    const [c, st] = await Promise.all([api('world/cities'), api('player/status')]);
    const cur = c.data.current, list = c.data.cities;
    const m = st.data.mission;
    return `<div class="card"><h3>Scavenge in ${esc(list.find((x) => x.id === cur).name)}</h3>
      ${m ? `<p>Mission active until ${new Date(m.ends_at).toLocaleTimeString()}.</p>${btn('Report', 'rep')}` : `<div class="row">
        ${btn('Quick (5m, 10⚡)', 'go', 'data-l="quick"')}${btn('Standard (15m, 20⚡)', 'go', 'data-l="standard"')}${btn('Deep (30m, 35⚡)', 'go', 'data-l="deep"')}</div>
        <p class="muted">Missions use food & water bars (and eat from your pack if you're short).</p>${btn('Report', 'rep alt')}`}</div>
      <div class="card"><h3>Travel</h3><div class="row"><select id="dest">${list.map((x) => `<option value="${x.id}" ${x.id === cur ? 'selected' : ''}>${esc(x.name)} — ${x.region}, ${'⚠'.repeat(x.danger)}, ${x.travel}⚡</option>`).join('')}</select>${btn('Travel', 'trav')}</div></div>`;
  },
  async shelter() {
    const [r, d] = await Promise.all([api('shelter/view'), api('shelter/defense')]);
    return `<div class="card">${linesHtml(r.lines)}<div class="row">
      ${['shelter', 'door', 'vault', 'power_bank', 'turret', 'robot'].map((t) => btn(`⬆ ${t}`, 'alt up', `data-t="${t}"`)).join('')}</div>
      <hr><div class="row">${btn('🔧 Repair shelter', 'rp', 'data-t="shelter"')}${btn('🔧 Repair door', 'rp', 'data-t="door"')}
      <input id="bat" type="number" min="1" value="1" style="width:70px">${btn('🔋 Charge', 'chg alt')}${btn('⚡ Power→Energy', 'dis alt')}</div></div>
      <div class="card"><h3>Defenses</h3>${linesHtml(d.lines)}</div>`;
  },
  async craft() {
    const r = await api('craft/list');
    const by = {}; for (const x of r.data.recipes) (by[x.station] ||= []).push(x);
    return Object.entries(by).map(([st, rs]) => `<div class="card"><h3>${st}</h3><table>${rs.map((x) =>
      `<tr><td>${esc(x.name)}</td><td class="muted">${Object.entries(x.inputs).map(([i, n]) => itemLabel(i, n)).join(', ')}${x.power ? ` · ${x.power}⚡` : ''}</td><td>${btn('Craft', 'mk' + (x.canCraft ? '' : ' alt'), `data-r="${x.id}"`)}</td></tr>`).join('')}</table></div>`).join('');
  },
  async farm() {
    const r = await api('planter/list'); const inv = (await api('player/inventory')).data.inventory;
    const seeds = Object.keys(inv).filter((i) => catalog.items[i]?.kind === 'seed');
    return `<div class="card">${r.data.slots.map((s) => `<div class="slot"><span><b>${s.slot}.</b> ${s.state === 'locked' ? '🔒 not built' : s.state === 'empty' ? '🟫 empty' : `${itemLabel(s.crop)} — ${s.state}`}</span><span class="row">
      ${s.state === 'empty' ? `<select id="seed${s.slot}">${seeds.map((x) => `<option value="${x}">${esc(catalog.items[x].name)} (${inv[x]})</option>`).join('')}</select>${btn('Plant', 'pl', `data-s="${s.slot}" ${seeds.length ? '' : 'disabled'}`)}` : ''}
      ${['growing', 'thirsty'].includes(s.state) ? btn('💧 Water', 'wt alt', `data-s="${s.slot}"`) : ''}${s.state === 'ready' ? btn('Harvest', 'hv', `data-s="${s.slot}"`) : ''}</span></div>`).join('<hr>')}</div>
      <p class="muted">Crops need clean water at planting and again halfway. Build planters with the Craft tab (max 6).</p>`;
  },
  async inventory() {
    const r = await api('player/inventory');
    const { inventory, equipment, vault } = r.data;
    return `<div class="grid"><div class="card"><h3>Carried</h3>${Object.entries(inventory).map(([i, n]) => `<div class="slot"><span>${itemLabel(i, n)}</span><span class="row">${btn('Vault', 'alt vd', `data-i="${i}"`)}</span></div>`).join('') || '<p class="muted">Empty</p>'}</div>
      <div class="card"><h3>Gear</h3>${equipment.filter((e) => e.location === 'bag').map((e) => `<div class="slot"><span>#${e.id} ${itemLabel(e.item_id)} ${e.durability}/${e.max_durability} ${e.equipped ? '✅' : ''}</span><span class="row">${catalog.items[e.item_id].weapon ? btn('Equip', 'eq', `data-i="${e.id}"`) : ''}${btn('Repair', 'alt rg', `data-i="${e.id}"`)}</span></div>`).join('') || '<p class="muted">None</p>'}</div>
      <div class="card"><h3>🔒 Vault</h3>${vault.map((v) => `<div class="slot"><span>${itemLabel(v.item_id, v.quantity)}</span>${btn('Take', 'alt vw', `data-i="${v.item_id}"`)}</div>`).join('') || '<p class="muted">Empty</p>'}
      ${equipment.filter((e) => e.location === 'vault').map((e) => `<div class="slot"><span>#${e.id} ${itemLabel(e.item_id)}</span>${btn('Take', 'alt vw', `data-i="${e.id}"`)}</div>`).join('')}</div></div>`;
  },
  async raid() {
    const r = await api('world/players');
    const ps = r.data.players;
    return `<div class="card"><h3>⚔️ Raid shelters</h3><p class="muted">You can only raid scavengers whose shelter is in your current city (travel on the Mission tab). Costs 15⚡. Vault items and Void Coins are safe from raids.</p>
      <table>${ps.map((x) => `<tr><td><b>${esc(x.name)}</b> L${x.level} ${x.crew ? `[${esc(x.crew)}]` : ''} ${x.criminal ? '🏴' : ''}</td><td class="muted">${x.home ? 'shelter here' : 'visiting'}${x.reason ? ' · ' + esc(x.reason) : ''}</td>
      <td>${btn('Raid', 'atk' + (x.raidable ? '' : ' alt'), `data-n="${esc(x.name)}" ${x.raidable ? '' : 'disabled'}`)}</td></tr>`).join('') || '<tr><td class="muted">Nobody else is around.</td></tr>'}</table></div>`;
  },
  async crew() {
    try {
      const r = await api('crew/info');
      return `<div class="card"><h3>${esc(r.title)}</h3>${linesHtml(r.lines)}<div class="row">
        <input id="inv" placeholder="Scavenger name">${btn('Invite', 'ci alt')}${btn('Expand (🪙)', 'cx alt')}${btn('Leave', 'cl alt')}</div></div>`;
    } catch {
      return `<div class="card"><h3>Found a crew</h3><div class="row"><input id="cn" placeholder="Crew name"><input id="ct" placeholder="TAG" maxlength="5" style="width:80px">${btn('Create', 'cc')}</div></div>
        <div class="card"><h3>Join (needs an invite)</h3><div class="row"><input id="jn" placeholder="Crew name or tag">${btn('Join', 'cj')}</div></div>`;
    }
  },
  async merchant() {
    const [r, v] = await Promise.all([api('merchant/view'), api('voidcoins/view')]);
    const visits = r.data.visits || [];
    return `<div class="card"><h3>🪙 ${v.data.balance} Void Coins</h3></div>` + (visits.length ? visits.map((x) => `<div class="card"><h3>🧳 Wandering Merchant</h3>
      <table>${x.offers.map((o) => `<tr><td><span class="badge b-${o.fairness}">${{ good: 'Real deal+', fair: 'Real deal', poor: 'Overpriced', scam: '⚠ POTENTIAL SCAM' }[o.fairness]}</span></td>
      <td>${side(o.gives_item, o.gives_qty, o.gives_vc)} <span class="muted">for</span> ${side(o.wants_item, o.wants_qty, o.wants_vc)}<div class="muted">you get ~${Math.round(o.ratio * 100)}% of fair value</div></td>
      <td>${o.traded ? '✔️' : btn('Trade', 'tr' + (o.fairness === 'scam' ? ' alt' : ''), `data-o="${o.id}" ${o.stock <= 0 ? 'disabled' : ''}`)}</td></tr>`).join('')}</table></div>`).join('') : `<div class="card">${linesHtml(r.lines)}</div>`);
  },
  async alerts() {
    const r = await api('notifications/list');
    return `<div class="card">${r.data.notifications.map((n) => `<p>${md(n.body)} <span class="muted">${new Date(n.created_at).toLocaleString()}</span></p>`).join('') || '<p class="muted">Nothing yet.</p>'}</div>`;
  },
};
const side = (item, n, vc) => [item ? itemLabel(item, n) : '', vc ? `🪙 ${vc}` : ''].filter(Boolean).join(' + ');

async function consumables() {
  const inv = (await api('player/inventory')).data.inventory;
  const usable = Object.keys(inv).filter((i) => { const d = catalog.items[i]; return d && (d.food || d.water || d.hp || d.energy); });
  return usable.map((i) => btn(`${itemLabel(i, inv[i])}`, 'alt use', `data-i="${i}"`)).join('') || '<span class="muted">Nothing edible or drinkable in your pockets.</span>';
}

// ------------------------------------------------------------- wiring
const handlers = {
  '.go': (e) => act('mission/start', { length: e.dataset.l }), '.rep': () => act('mission/report', undefined),
  '.trav': () => act('world/travel', { city: $('#dest').value }),
  '.up': (e) => act('shelter/upgrade', { target: e.dataset.t }), '.rp': (e) => act('shelter/repair', { target: e.dataset.t }),
  '.chg': () => act('shelter/charge', { batteries: +$('#bat').value }), '.dis': () => act('shelter/discharge', {}),
  '.mk': (e) => act('craft/make', { recipe: e.dataset.r }),
  '.pl': (e) => act('planter/plant', { slot: +e.dataset.s, seed: $('#seed' + e.dataset.s).value }), '.wt': (e) => act('planter/water', { slot: +e.dataset.s }), '.hv': (e) => act('planter/harvest', { slot: +e.dataset.s }),
  '.use': (e) => act('player/use', { item: e.dataset.i }), '.eq': (e) => act('player/equip', { item: e.dataset.i }), '.rg': (e) => act('craft/repair', { item: e.dataset.i }),
  '.vd': (e) => act('vault/deposit', { item: e.dataset.i, qty: 1 }), '.vw': (e) => act('vault/withdraw', { item: e.dataset.i, qty: 1 }),
  '.cc': () => act('crew/create', { name: $('#cn').value, tag: $('#ct').value }), '.cj': () => act('crew/join', { name: $('#jn').value }),
  '.ci': () => act('crew/invite', { name: $('#inv').value }), '.cx': () => act('crew/expand', {}), '.cl': () => act('crew/leave', {}),
  '.atk': (e) => act('attack/player', { name: e.dataset.n }),
  '.tr': (e) => act('merchant/trade', { offer: +e.dataset.o }),
};
$('#panel').addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  for (const [sel, fn] of Object.entries(handlers)) if (b.matches(sel)) { fn(b); return; }
});

async function render() {
  if (!token) return;
  try {
    $('#panel').innerHTML = await views[tab]();
    const st = cache.status || (await api('player/status')).data;
    $('#who').textContent = `${st.player.name} · 🪙 ${st.player.void_coins}`;
  } catch (e) { if (token) $('#panel').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
function showApp() {
  $('#login').hidden = true; $('#app').hidden = false;
  $('#tabs').innerHTML = TABS.map((t) => `<button class="${t === tab ? 'on' : ''}" data-t="${t}">${t}</button>`).join('') + '<button data-t="__out">log out</button>';
  render();
}
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.dataset.t; if (!t) return;
  if (t === '__out') { api('auth/logout', 'POST').catch(() => {}); logout(); return; }
  tab = t; cache = {}; showApp();
});
function logout() { token = ''; localStorage.removeItem('vs_token'); $('#app').hidden = true; $('#login').hidden = false; $('#who').textContent = ''; }
async function loginWith(path, body) {
  try { const r = await api(path, 'POST', body); token = r.token; localStorage.setItem('vs_token', token); $('#loginErr').textContent = ''; showApp(); }
  catch (e) { $('#loginErr').textContent = e.message; }
}
$('#codeForm').addEventListener('submit', (e) => { e.preventDefault(); loginWith('auth/exchange', { code: $('#code').value }); });
$('#devForm').addEventListener('submit', (e) => { e.preventDefault(); loginWith('auth/dev-login', { name: $('#devName').value }); });

(async () => {
  catalog = await (await fetch('/api/catalog')).json();
  $('#devBox').hidden = !catalog.devLogin;
  if (token) showApp(); else $('#login').hidden = false;
  setInterval(() => { if (token && ['status', 'mission', 'farm'].includes(tab) && !document.hidden) { cache = {}; render(); } }, 15000);
})();
