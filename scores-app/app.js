/* Live College Scores — plain JS, no build step.
   Data comes straight from ESPN's public site API (CORS-enabled). */
(() => {
'use strict';

/* ------------------------------------------------------------------ config */
const API = 'https://site.api.espn.com/apis/site/v2/sports';
const STANDINGS = 'https://site.api.espn.com/apis/v2/sports';

const LEAGUES = {
  cfb:     { key: 'cfb',     label: 'College Football', short: 'CFB',  sport: 'football', slug: 'college-football',    mode: 'week', periods: 4, ranked: true, divisions: [['80', 'FBS'], ['81', 'FCS'], ['all', 'FBS + FCS']] },
  nfl:     { key: 'nfl',     label: 'NFL',              short: 'NFL',  sport: 'football', slug: 'nfl',                 mode: 'week', periods: 4, ranked: false },
  nhl:     { key: 'nhl',     label: 'NHL',              short: 'NHL',  sport: 'hockey',   slug: 'nhl',                 mode: 'day',  periods: 3, ranked: false },
};
const LIVE_INTERVAL = 15;   // seconds when anything is live
const IDLE_INTERVAL = 60;   // seconds otherwise
const STATS_HOCKEY = [
  ['shotsTotal', 'Shots'], ['hits', 'Hits'], ['blockedShots', 'Blocked shots'], ['powerPlayGoals', 'PP goals'],
  ['powerPlayOpportunities', 'PP chances'], ['faceoffPercent', 'Faceoff %'], ['giveaways', 'Giveaways'],
  ['takeaways', 'Takeaways'], ['penaltyMinutes', 'PIM'],
];
const STATS_FOOTBALL = [
  ['totalYards', 'Total yards'], ['netPassingYards', 'Passing'], ['rushingYards', 'Rushing'],
  ['firstDowns', 'First downs'], ['thirdDownEff', '3rd down'], ['turnovers', 'Turnovers'],
  ['totalPenaltiesYards', 'Penalties'], ['possessionTime', 'Possession'],
];

/* ------------------------------------------------------------------- state */
const state = {
  league: 'cfb',
  division: '80',
  conf: '',
  week: null,        // {type, number} or null = current
  date: null,        // YYYYMMDD or null = today
  weekend: false,
  top25: false,
  favOnly: false,
  sort: 'status',
  search: '',
  notify: false,
  density: 'comfortable',
  theme: 'auto',
  game: null,        // event id to open from a deep link
  view: 'scores',    // scores | standings | rankings
  poll: '',          // rankings poll type, '' = default for the league
};
let favorites = new Set();
const confMaps = {};          // league -> { confs:[{id,name,abbr,div}], team:{teamId:confId} }
const urlCache = new Map();   // url -> {ts, data}
const summaryCache = new Map();
let viewEvents = [];          // events in the current view
let viewMeta = null;          // {calendar, week, season}
let stripEvents = [];         // live events across all leagues
const lastScores = new Map(); // "evId:teamId" -> score
const recentDeltas = new Map();
const cardNodes = new Map();  // evId -> element
let drawer = null;            // {league, id}
let timer = null, countdown = 0, interval = IDLE_INTERVAL, refreshing = false;
let viewToken = 0;

/* --------------------------------------------------------------- utilities */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ord = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : (n % 10 < 4 ? n % 10 : 0)]);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const fromYmd = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const L = () => LEAGUES[state.league];

function load(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ } }

async function fetchJSON(url, { ttl = 0, timeout = 12000 } = {}) {
  const hit = urlCache.get(url);
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    urlCache.set(url, { ts: Date.now(), data });
    return data;
  } finally { clearTimeout(t); }
}

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtTime(iso, { withDay = true } = {}) {
  const d = new Date(iso); const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (!withDay || sameDay(d, now)) return time;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, tomorrow)) return `Tomorrow ${time}`;
  const diff = (d - now) / 864e5;
  if (diff > -1 && diff < 6) return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/* ----------------------------------------------------------- game helpers */
const comp = (ev) => ev.competitions[0];
const home = (ev) => comp(ev).competitors.find((c) => c.homeAway === 'home') || comp(ev).competitors[1];
const away = (ev) => comp(ev).competitors.find((c) => c.homeAway === 'away') || comp(ev).competitors[0];
const stateOf = (ev) => comp(ev).status?.type?.state || 'pre';
const isLive = (ev) => stateOf(ev) === 'in';
const score = (c) => (c.score === '' || c.score == null) ? null : Number(c.score);
const rank = (c) => { const r = c.curatedRank?.current; return r && r <= 25 ? r : null; };
const record = (c) => (c.records || []).find((r) => r.type === 'total')?.summary || c.records?.[0]?.summary || '';
const isFav = (c) => favorites.has(String(c.team.id));
const hasFav = (ev) => comp(ev).competitors.some(isFav);
const leagueOf = (ev) => ev.__league || state.league;

function periodLabel(ev, p) {
  const reg = LEAGUES[leagueOf(ev)].periods;
  if (p <= reg) return ord(p);
  if (LEAGUES[leagueOf(ev)].sport === 'hockey') return p === reg + 1 ? 'OT' : 'SO';
  return p === reg + 1 ? 'OT' : `${p - reg}OT`;
}
function periodHeader(ev, p) {
  const reg = LEAGUES[leagueOf(ev)].periods;
  if (p <= reg) return String(p);
  if (LEAGUES[leagueOf(ev)].sport === 'hockey') return p === reg + 1 ? 'OT' : 'SO';
  return p === reg + 1 ? 'OT' : `${p - reg}OT`;
}

function statusText(ev) {
  const st = comp(ev).status; const t = st.type; const name = t.name || '';
  if (t.state === 'pre') {
    if (name === 'STATUS_POSTPONED' || name === 'STATUS_CANCELED') return t.description;
    if (comp(ev).timeValid === false) return `${new Date(ev.date).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · TBD`;
    return fmtTime(ev.date);
  }
  if (t.state === 'in') {
    if (name === 'STATUS_HALFTIME') return 'Halftime';
    if (name === 'STATUS_END_PERIOD') return `End ${periodLabel(ev, st.period)}`;
    if (name === 'STATUS_DELAYED' || name === 'STATUS_RAIN_DELAY' || name === 'STATUS_SUSPENDED') return t.description;
    if (name === 'STATUS_SHOOTOUT') return 'Shootout';
    return `${st.displayClock} · ${periodLabel(ev, st.period)}`;
  }
  if (name === 'STATUS_POSTPONED' || name === 'STATUS_CANCELED' || name === 'STATUS_SUSPENDED') return t.description;
  const reg = L().periods;
  if (t.detail && /\//.test(t.detail)) return t.detail;
  if (st.period > reg) return `Final/${periodHeader(ev, st.period)}`;
  return 'Final';
}

function broadcast(ev) {
  const c = comp(ev);
  const names = c.broadcasts?.flatMap((b) => b.names || []) || [];
  if (names.length) return names.slice(0, 2).join(' · ');
  return c.geoBroadcasts?.[0]?.media?.shortName || '';
}
function oddsText(ev) {
  const o = comp(ev).odds?.[0]; if (!o) return '';
  const parts = [];
  if (o.details) parts.push(o.details);
  if (o.overUnder != null) parts.push(`O/U ${o.overUnder}`);
  return parts.join(' · ');
}
function diff(ev) { const h = score(home(ev)), a = score(away(ev)); return (h == null || a == null) ? 0 : h - a; }

function tags(ev) {
  if (!isLive(ev)) return [];
  const lg = LEAGUES[leagueOf(ev)]; const p = comp(ev).status.period || 0; const d = Math.abs(diff(ev));
  const out = [];
  const closeThreshold = lg.sport === 'hockey' ? 1 : 8;
  if (p >= lg.periods && d <= closeThreshold) out.push(['close', 'Close']);
  const h = home(ev), a = away(ev); const lead = diff(ev) > 0 ? h : diff(ev) < 0 ? a : null;
  const trail = lead === h ? a : lead === a ? h : null;
  if (lead && trail && p >= Math.ceil(lg.periods / 2) && !rank(lead) && rank(trail)) out.push(['upset', 'Upset watch']);
  return out;
}

/* ----------------------------------------------------- conference mapping */
async function ensureConfMap(league) {
  if (confMaps[league]) return confMaps[league];
  const lg = LEAGUES[league];
  const key = `lcs:conf:v2:${league}`;
  const cached = load(key, null);
  if (cached && Date.now() - cached.ts < 7 * 864e5) { confMaps[league] = cached.map; return cached.map; }
  const map = { confs: [], team: {} };
  const groups = league === 'cfb' ? ['80', '81'] : [''];
  for (const g of groups) {
    try {
      const url = `${STANDINGS}/${lg.sport}/${lg.slug}/standings${g ? `?group=${g}` : ''}`;
      const d = await fetchJSON(url);
      const walk = (node, top) => {
        const entries = node.standings?.entries || [];
        for (const e of entries) if (e.team?.id) map.team[e.team.id] = top.id;
        for (const ch of node.children || []) walk(ch, top);
      };
      for (const c of d.children || []) {
        const top = { id: String(c.id), name: c.name, abbr: c.abbreviation || c.shortName || c.name, div: g };
        map.confs.push(top);
        walk(c, top);
      }
    } catch (e) { console.warn('standings failed', league, g, e); }
  }
  map.confs.sort((a, b) => a.name.localeCompare(b.name));
  confMaps[league] = map;
  if (map.confs.length) save(key, { ts: Date.now(), map });
  return map;
}
function confOf(ev, c) {
  const map = confMaps[leagueOf(ev)];
  return (map && map.team[c.team.id]) || (c.team.conferenceId ? String(c.team.conferenceId) : null);
}

/* ------------------------------------------------------------- data fetch */
function weekendDates(anchor) {
  const d = anchor ? fromYmd(anchor) : new Date();
  const dow = d.getDay(); // 0 Sun .. 6 Sat
  const fri = new Date(d);
  if (dow === 0) fri.setDate(d.getDate() - 2);
  else if (dow === 6) fri.setDate(d.getDate() - 1);
  else if (dow === 5) { /* already friday */ }
  else fri.setDate(d.getDate() + (5 - dow));
  return [0, 1, 2].map((i) => { const x = new Date(fri); x.setDate(fri.getDate() + i); return ymd(x); });
}

function viewUrls(league = state.league, forStrip = false) {
  const lg = LEAGUES[league];
  const base = `${API}/${lg.sport}/${lg.slug}/scoreboard`;
  if (lg.mode === 'week') {
    const wk = (!forStrip && state.week) ? `&week=${state.week.number}&seasontype=${state.week.type}` : '';
    if (!lg.divisions) return [`${base}?limit=400${wk}`];
    const groups = forStrip ? ['80'] : (state.division === 'all' ? ['80', '81'] : [state.division]);
    return groups.map((g) => `${base}?groups=${g}&limit=400${wk}`);
  }
  let dates;
  if (forStrip) dates = [ymd(new Date())];
  else if (state.weekend) dates = weekendDates(state.date);
  else dates = [state.date || ymd(new Date())];
  return dates.map((d) => `${base}?dates=${d}&limit=300`);
}

async function fetchEvents(league, urls, ttl) {
  const results = await Promise.all(urls.map((u) => fetchJSON(u, { ttl })));
  const seen = new Set(); const events = [];
  for (const r of results) for (const ev of r.events || []) {
    if (seen.has(ev.id)) continue; seen.add(ev.id); ev.__league = league; events.push(ev);
  }
  const first = results[0] || {};
  return { events, meta: { calendar: first.leagues?.[0]?.calendar || [], week: first.week, season: first.season, day: first.day } };
}

async function refresh({ manual = false } = {}) {
  if (refreshing) return;
  refreshing = true; $('refreshIndicator').classList.add('busy');
  const token = ++viewToken;
  try {
    await ensureConfMap(state.league);
    const main = await fetchEvents(state.league, viewUrls(), manual ? 0 : 5000);
    if (token !== viewToken) return;
    viewEvents = main.events; viewMeta = main.meta;
    syncControls();
    render();
    $('updatedText').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
    if (drawer) refreshDrawer();
    else if (state.game) { const id = state.game; state.game = null; if (findEvent(state.league, id)) openDrawer(state.league, id); }
    refreshStrip().catch(() => {});
  } catch (e) {
    console.error(e);
    toast(`ESPN didn't answer (${e.message}). Keeping last scores; retrying.`);
    $('statusText').textContent = 'Connection problem — showing last known scores';
  } finally {
    refreshing = false; $('refreshIndicator').classList.remove('busy');
    schedule();
  }
}

async function refreshStrip() {
  const all = await Promise.all(Object.keys(LEAGUES).map(async (lg) => {
    try { return (await fetchEvents(lg, viewUrls(lg, true), 5000)).events; } catch { return []; }
  }));
  stripEvents = all.flat().filter(isLive);
  renderStrip();
}

function schedule() {
  clearInterval(timer);
  const anyLive = viewEvents.some(isLive) || stripEvents.length > 0;
  interval = anyLive ? LIVE_INTERVAL : IDLE_INTERVAL;
  $('intervalText').textContent = interval;
  countdown = interval;
  updateRing();
  timer = setInterval(() => {
    if (document.hidden) return;
    countdown -= 1; updateRing();
    if (countdown <= 0) { clearInterval(timer); refresh(); }
  }, 1000);
}
function updateRing() {
  const frac = Math.max(0, countdown / interval);
  $('ringFg').style.strokeDashoffset = (97.4 * frac).toFixed(1);
}

/* ---------------------------------------------------------------- filters */
function filtered() {
  const q = state.search.trim().toLowerCase();
  return viewEvents.filter((ev) => {
    const cs = comp(ev).competitors;
    if (state.favOnly && !hasFav(ev)) return false;
    if (state.top25 && !cs.some(rank)) return false;
    if (state.conf && !cs.some((c) => confOf(ev, c) === state.conf)) return false;
    if (q) {
      const hay = cs.map((c) => `${c.team.displayName} ${c.team.abbreviation} ${c.team.location} ${c.team.name}`).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function sortEvents(list) {
  const t = (ev) => new Date(ev.date).getTime();
  const favFirst = (a, b) => Number(hasFav(b)) - Number(hasFav(a));
  if (state.sort === 'time') return list.sort((a, b) => favFirst(a, b) || t(a) - t(b));
  if (state.sort === 'close') {
    const key = (ev) => isLive(ev) ? [0, Math.abs(diff(ev)), -(comp(ev).status.period || 0)] : stateOf(ev) === 'pre' ? [1, t(ev), 0] : [2, -t(ev), 0];
    return list.sort((a, b) => { const ka = key(a), kb = key(b); return favFirst(a, b) || ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2]; });
  }
  const order = { in: 0, pre: 1, post: 2 };
  return list.sort((a, b) => favFirst(a, b) || order[stateOf(a)] - order[stateOf(b)] || (stateOf(a) === 'post' ? t(b) - t(a) : t(a) - t(b)));
}

/* --------------------------------------------------------------- rendering */
function teamRow(ev, c, opts) {
  const sc = score(c); const r = rank(c); const st = stateOf(ev);
  const key = `${ev.id}:${c.team.id}`; const delta = recentDeltas.get(key);
  const winner = st === 'post' && c.winner === true; const loser = st === 'post' && comp(ev).competitors.some((x) => x.winner) && !c.winner;
  const poss = opts.possession && String(opts.possession) === String(c.id);
  return `<div class="team ${winner ? 'winner' : ''} ${loser ? 'loser' : ''}">
    <img src="${esc(c.team.logo || `https://a.espncdn.com/i/teamlogos/ncaa/500/${c.team.id}.png`)}" alt="" loading="lazy">
    <div class="name">${r ? `<span class="rank">${r}</span>` : ''}<span class="nm" title="${esc(c.team.displayName)}">${esc(c.team.shortDisplayName || c.team.name)}</span>${poss ? '<span class="poss" title="Possession"></span>' : ''}<span class="rec">${esc(record(c))}</span></div>
    <button class="fav ${isFav(c) ? 'on' : ''}" data-fav="${esc(c.team.id)}" title="${isFav(c) ? 'Unstar' : 'Star'} ${esc(c.team.shortDisplayName)}" aria-label="Favorite ${esc(c.team.displayName)}">&#9733;</button>
    <div class="score ${delta ? 'bump' : ''}" data-score="${key}">${st === 'pre' ? '' : (sc ?? '')}${delta ? `<span class="delta">+${delta.delta}</span>` : ''}</div>
  </div>`;
}

function timeoutsDots(n) { if (n == null) return ''; return `<span class="to">${[0, 1, 2].map((i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`; }

function cardHTML(ev) {
  const c = comp(ev); const st = stateOf(ev); const h = home(ev), a = away(ev);
  const sit = c.situation || {};
  const tg = tags(ev).map(([k, t]) => `<span class="tag ${k}">${t}</span>`).join('');
  const tv = broadcast(ev);
  const statusCls = st === 'in' ? 'live' : st === 'post' ? 'final' : 'pre';
  let body = '';
  if (st === 'in' && L().sport === 'football' && (sit.downDistanceText || sit.shortDownDistanceText)) {
    const txt = sit.downDistanceText || sit.shortDownDistanceText || '';
    body += `<div class="situation"><span>${esc(txt)}</span>${sit.isRedZone ? '<span class="tag close">Red zone</span>' : ''}
      <span class="to" title="Timeouts: ${esc(a.team.abbreviation)} ${sit.awayTimeouts ?? '-'} · ${esc(h.team.abbreviation)} ${sit.homeTimeouts ?? '-'}">${timeoutsDots(sit.awayTimeouts)}<span class="muted">·</span>${timeoutsDots(sit.homeTimeouts)}</span></div>`;
  }
  if (st === 'in' && sit.lastPlay?.text) body += `<div class="lastplay">${esc(sit.lastPlay.text)}</div>`;
  let foot = '';
  if (st === 'pre') {
    const o = oddsText(ev); const v = c.venue;
    foot = `${o ? `<span class="odds">${esc(o)}</span>` : ''}${v ? `<span>${esc(v.fullName)}${v.address?.city ? ` · ${esc(v.address.city)}` : ''}</span>` : ''}${c.neutralSite ? '<span>Neutral site</span>' : ''}`;
  } else if (st === 'post') {
    const hl = c.headlines?.[0]?.shortLinkText; if (hl) foot = `<span class="headline">${esc(hl)}</span>`;
  }
  return `<div class="card-head"><span class="status ${statusCls}">${st === 'in' ? '<span class="live-dot"></span>' : ''}${esc(statusText(ev))}</span>${tg}${tv ? `<span class="tv">${esc(tv)}</span>` : ''}</div>
    ${teamRow(ev, a, { possession: sit.possession })}
    ${teamRow(ev, h, { possession: sit.possession })}
    ${body}${foot ? `<div class="card-foot">${foot}</div>` : ''}`;
}

function signature(ev) {
  const c = comp(ev); const s = c.status;
  return JSON.stringify([s.type?.name, s.displayClock, s.period, c.competitors.map((x) => [x.score, x.winner, rank(x), record(x), isFav(x)]),
    c.situation?.downDistanceText, c.situation?.possession, c.situation?.lastPlay?.text, c.situation?.homeTimeouts, c.situation?.awayTimeouts, broadcast(ev), oddsText(ev), c.headlines?.[0]?.shortLinkText, state.density]);
}

function detectScoreChanges(events) {
  const changed = [];
  for (const ev of events) for (const c of comp(ev).competitors) {
    const key = `${ev.id}:${c.team.id}`; const s = score(c);
    const prev = lastScores.get(key);
    if (s != null) lastScores.set(key, s);
    if (prev != null && s != null && s !== prev && stateOf(ev) !== 'pre') {
      if (s > prev) recentDeltas.set(key, { delta: s - prev, at: Date.now() });
      changed.push({ ev, c, prev, now: s });
    }
  }
  for (const [k, v] of recentDeltas) if (Date.now() - v.at > 90000) recentDeltas.delete(k);
  return changed;
}

function notifyChanges(changed) {
  if (!state.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  for (const { ev, c } of changed) {
    if (!hasFav(ev)) continue;
    const h = home(ev), a = away(ev);
    const body = `${a.team.abbreviation} ${score(a)} – ${h.team.abbreviation} ${score(h)} · ${statusText(ev)}`;
    try { new Notification(`${c.team.shortDisplayName} scores`, { body, tag: `lcs-${ev.id}`, silent: false }); } catch { /* ignore */ }
  }
}

function render() {
  const board = $('board');
  const list = sortEvents(filtered());
  const changed = detectScoreChanges(viewEvents);
  notifyChanges(changed);
  const changedCards = new Set(changed.map((x) => x.ev.id));

  const liveN = viewEvents.filter(isLive).length;
  const byes = (viewMeta?.week?.teamsOnBye || []).map((t) => t.abbreviation);
  $('statusText').textContent = `${list.length} game${list.length === 1 ? '' : 's'}${list.length !== viewEvents.length ? ` of ${viewEvents.length}` : ''}${liveN ? ` · ${liveN} live` : ''}${byes.length ? ` · Bye: ${byes.join(', ')}` : ''}`;

  if (!list.length) {
    board.replaceChildren(Object.assign(document.createElement('div'), { className: 'empty', textContent: viewEvents.length ? 'No games match these filters.' : 'No games scheduled for this selection.' }));
    cardNodes.clear(); return;
  }

  const groups = state.sort === 'status'
    ? [['in', 'Live'], ['pre', 'Upcoming'], ['post', 'Final']].map(([k, t]) => [t, list.filter((e) => stateOf(e) === k)]).filter(([, l]) => l.length)
    : [['', list]];

  const frag = document.createDocumentFragment(); const used = new Set();
  for (const [title, evs] of groups) {
    if (title) {
      const h = document.createElement('div'); h.className = `group-title ${title === 'Live' ? 'live' : ''}`;
      h.innerHTML = `${title === 'Live' ? '<span class="live-dot"></span>' : ''}${title} <span class="count">${evs.length}</span>`;
      frag.appendChild(h);
    }
    const grid = document.createElement('div'); grid.className = 'grid';
    for (const ev of evs) {
      let el = cardNodes.get(ev.id);
      const sig = signature(ev);
      if (!el) { el = document.createElement('article'); el.dataset.id = ev.id; cardNodes.set(ev.id, el); }
      if (el.dataset.sig !== sig) { el.innerHTML = cardHTML(ev); el.dataset.sig = sig; }
      const st = stateOf(ev);
      el.className = `card ${st} ${st === 'in' ? 'is-live' : ''} ${hasFav(ev) ? 'is-fav' : ''} ${comp(ev).situation?.isRedZone ? 'redzone' : ''}`;
      if (changedCards.has(ev.id)) { el.classList.add('scored'); setTimeout(() => el.classList.remove('scored'), 1500); }
      used.add(ev.id); grid.appendChild(el);
    }
    frag.appendChild(grid);
  }
  for (const id of [...cardNodes.keys()]) if (!used.has(id)) cardNodes.delete(id);
  board.replaceChildren(frag);
}

function renderStrip() {
  const el = $('liveStrip');
  const items = stripEvents.filter((ev) => !(ev.__league === state.league && viewEvents.some((v) => v.id === ev.id && isLive(v))) || state.sort !== 'status');
  const show = stripEvents.length > 0;
  el.hidden = !show; if (!show) return;
  el.innerHTML = stripEvents.map((ev) => {
    const h = home(ev), a = away(ev);
    return `<div class="strip-item" data-open="${ev.__league}:${ev.id}"><span class="lg">${esc(LEAGUES[ev.__league].short)}</span>
      <span>${rank(a) ? `<b>${rank(a)}</b> ` : ''}${esc(a.team.abbreviation)} <span class="sc">${score(a) ?? ''}</span></span>
      <span>${rank(h) ? `<b>${rank(h)}</b> ` : ''}${esc(h.team.abbreviation)} <span class="sc">${score(h) ?? ''}</span></span>
      <span class="clk">${esc(statusText(ev))}</span></div>`;
  }).join('');
  void items;
}

/* ------------------------------------------------------------- controls UI */
function renderControls() {
  const lg = L();
  document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.league === state.league)));
  $('divisionSelect').hidden = !lg.divisions;
  if (lg.divisions) {
    $('divisionSelect').innerHTML = lg.divisions.map(([v, t]) => `<option value="${v}" ${v === state.division ? 'selected' : ''}>${t}</option>`).join('');
  }
  $('weekendBtn').hidden = lg.mode !== 'day';
  $('weekendBtn').setAttribute('aria-pressed', String(state.weekend));
  $('top25Btn').hidden = !lg.ranked;
  if (!lg.ranked) state.top25 = false;
  $('top25Btn').setAttribute('aria-pressed', String(state.top25));
  $('favOnlyBtn').setAttribute('aria-pressed', String(state.favOnly));
  $('sortSelect').value = state.sort;
  $('notifyBtn').setAttribute('aria-pressed', String(state.notify));
  $('densityBtn').setAttribute('aria-pressed', String(state.density === 'compact'));
  document.documentElement.dataset.density = state.density;
  if (state.theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = state.theme;

  // conference select
  const map = confMaps[state.league]; const sel = $('confSelect');
  const confs = (map?.confs || []).filter((c) => state.league !== 'cfb' || state.division === 'all' || c.div === state.division);
  sel.hidden = confs.length === 0;
  sel.innerHTML = `<option value="">All conferences</option>` + confs.map((c) => `<option value="${esc(c.id)}" ${c.id === state.conf ? 'selected' : ''}>${esc(state.league === 'nfl' ? c.abbr : c.name)}</option>`).join('');
  if (map && state.conf && !confs.some((c) => c.id === state.conf)) { state.conf = ''; sel.value = ''; }

  // period select
  const ps = $('periodSelect');
  if (lg.mode === 'week') {
    const cal = viewMeta?.calendar || []; const cur = viewMeta?.week?.number; const curType = viewMeta?.season?.type;
    const selected = state.week ? `${state.week.type}:${state.week.number}` : (cur ? `${curType}:${cur}` : '');
    ps.innerHTML = cal.map((st) => `<optgroup label="${esc(st.label)}">${(st.entries || []).map((e) => {
      const v = `${st.value}:${e.value}`; return `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(e.label)} · ${esc(e.detail || '')}</option>`;
    }).join('')}</optgroup>`).join('') || `<option>${cur ? `Week ${cur}` : 'This week'}</option>`;
  } else {
    const today = ymd(new Date());
    const days = (viewMeta?.calendar || []).map((s) => s.slice(0, 10).replace(/-/g, ''));
    const set = new Set(days); set.add(state.date || today); set.add(today);
    const all = [...set].sort();
    if (state.weekend) {
      const anchor = weekendDates(state.date)[0];
      const fridays = [...new Set(all.map((d) => weekendDates(d)[0]))].sort();
      if (!fridays.includes(anchor)) fridays.push(anchor), fridays.sort();
      ps.innerHTML = fridays.map((f) => `<option value="${f}" ${f === anchor ? 'selected' : ''}>Weekend of ${fromYmd(f).toLocaleDateString([], { month: 'short', day: 'numeric' })}</option>`).join('');
    } else {
      const d = state.date || today;
      ps.innerHTML = all.map((x) => `<option value="${x}" ${x === d ? 'selected' : ''}>${x === today ? 'Today · ' : ''}${fromYmd(x).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</option>`).join('');
    }
  }

  // view-specific visibility
  const v = state.view;
  document.querySelectorAll('.vtab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  $('rankingsTab').hidden = !lg.ranked;
  $('navGroup').hidden = v !== 'scores';
  $('sortSelect').hidden = v !== 'scores';
  $('favOnlyBtn').hidden = v !== 'scores';
  if (v !== 'scores') $('top25Btn').hidden = true;
  if (v === 'rankings') sel.hidden = true;
  const polls = pollsFor(state.league); const pollSel = $('pollSelect'); const cur = currentPollType();
  pollSel.hidden = v !== 'rankings' || polls.length < 2;
  pollSel.innerHTML = polls.map((r) => `<option value="${esc(r.type)}" ${r.type === cur ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  writeHash();
}

/* ------------------------------------------------- standings & rankings */
const rankingsCache = {};   // league -> {ts, data}
let panelToken = 0;
const STAND_COLS = {
  cfb:     [['Conf', ['vsconf']], ['Overall', ['total']], ['PF', ['pointsfor']], ['PA', ['pointsagainst']], ['Diff', ['pointdifferential']], ['Strk', ['streak']]],
  nfl:     [['W-L-T', ['total', 'overall']], ['Pct', ['winpercent', 'winPercent']], ['PF', ['pointsfor', 'pointsFor']], ['PA', ['pointsagainst', 'pointsAgainst']], ['Diff', ['pointdifferential', 'pointDifferential']], ['Home', ['homerecord', 'Home']], ['Road', ['roadrecord', 'Road']], ['Div', ['vsdiv', 'vs. Div.']], ['Conf', ['vsconf', 'vs. Conf.']], ['Strk', ['streak']]],
  nhl:     [['GP', ['gamesplayed']], ['W', ['wins']], ['L', ['losses']], ['OTL', ['otlosses']], ['PTS', ['points']], ['GF', ['pointsfor']], ['GA', ['pointsagainst']], ['Diff', ['pointdifferential']], ['Home', ['home']], ['Road', ['road']], ['L10', ['lasttengames']], ['Strk', ['streak']]],
};

function pollsFor(league) { return rankingsCache[league]?.data?.rankings || []; }
function currentPollType() {
  const polls = pollsFor(state.league); if (!polls.length) return '';
  if (state.poll && polls.some((r) => r.type === state.poll)) return state.poll;
  const want = state.league === 'cfb' ? (state.division === '81' ? 'fcs' : 'ap') : polls[0].type;
  return (polls.find((r) => r.type === want) || polls[0]).type;
}
async function ensureRankings(league) {
  const lg = LEAGUES[league]; if (!lg.ranked) return null;
  const c = rankingsCache[league]; if (c && Date.now() - c.ts < 30 * 60000) return c.data;
  const data = await fetchJSON(`${API}/${lg.sport}/${lg.slug}/rankings`, { ttl: 30 * 60000 });
  rankingsCache[league] = { ts: Date.now(), data }; return data;
}
function rankMapFor(league, pollType) {
  const polls = pollsFor(league); const poll = polls.find((r) => r.type === pollType) || polls[0];
  const m = {}; for (const r of poll?.ranks || []) m[r.team.id] = r.current; return m;
}
function statOf(entry, keys) {
  const stats = entry.stats || [];
  for (const k of keys) {
    const s = stats.find((x) => x.type === k) || stats.find((x) => x.name === k);
    if (s && (s.displayValue != null || s.value != null)) return s.displayValue ?? String(s.value);
  }
  return '';
}

function showView(v) {
  state.view = v;
  $('board').hidden = v !== 'scores'; $('panel').hidden = v === 'scores';
  renderControls();
  if (v !== 'scores') loadPanel();
}

async function loadPanel() {
  const lg = L();
  if (state.view === 'rankings' && !lg.ranked) { state.view = 'standings'; renderControls(); }
  const token = ++panelToken; const panel = $('panel');
  panel.innerHTML = '<div class="panel-grid">' + '<div class="skeleton"></div>'.repeat(4) + '</div>';
  try {
    if (state.view === 'rankings') {
      await ensureRankings(state.league); if (token !== panelToken) return;
      renderControls(); renderRankings();
    } else {
      const groups = state.league === 'cfb' ? (state.division === 'all' ? ['80', '81'] : [state.division]) : [''];
      const urls = groups.map((g) => { const q = new URLSearchParams(); if (g) q.set('group', g); if (state.league === 'nfl' || state.league === 'nhl') q.set('level', '3'); const s = q.toString(); return `${STANDINGS}/${lg.sport}/${lg.slug}/standings${s ? `?${s}` : ''}`; });
      const [datas] = await Promise.all([Promise.all(urls.map((u) => fetchJSON(u, { ttl: 5 * 60000 }))), ensureRankings(state.league).catch(() => null)]);
      if (token !== panelToken) return;
      renderStandings(datas);
    }
  } catch (e) {
    console.error(e);
    if (token === panelToken) panel.innerHTML = `<div class="empty">Could not load (${esc(e.message)}).</div>`;
  }
}

function renderStandings(datas) {
  const lg = L(); const cols = STAND_COLS[state.league] || STAND_COLS.nfl;
  const rk = rankMapFor(state.league, currentPollType());
  const confs = datas.flatMap((d) => d.children || []).filter((c) => !state.conf || String(c.id) === state.conf);
  const cell = (label, v) => {
    v = String(v).replace(/,\s*\d+ PTS$/, '');
    let cls = '';
    if (label === 'Diff') cls = v.startsWith('+') ? 'pos-diff' : v.startsWith('-') ? 'neg' : '';
    if (label === 'Strk') cls = v.startsWith('W') ? 'strk-w' : v.startsWith('L') ? 'strk-l' : '';
    return `<td class="${cls}">${esc(v || '–')}</td>`;
  };
  const row = (e, i) => {
    const t = e.team;
    return `<tr data-team="${esc(t.id)}" data-name="${esc(t.displayName)}" class="${favorites.has(String(t.id)) ? 'fav' : ''}"><td class="pos">${i + 1}</td><td class="tm"><img src="${esc(t.logos?.[0]?.href || `https://a.espncdn.com/i/teamlogos/ncaa/500/${t.id}.png`)}" alt="" loading="lazy"><span class="nm">${esc(t.shortDisplayName || t.displayName)}</span>${rk[t.id] ? `<span class="rk">#${rk[t.id]}</span>` : ''}${e.note ? `<span class="note" style="background:${esc(e.note.color || '#888')}" title="${esc(e.note.description || '')}"></span>` : ''}</td>${cols.map(([label, keys]) => cell(label, statOf(e, keys))).join('')}</tr>`;
  };
  const table = (entries) => `<table class="stable"><thead><tr><th></th><th class="tm">Team</th>${cols.map(([l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>${entries.map(row).join('')}</tbody></table>`;
  const block = (c) => {
    const kids = (c.children || []).filter((k) => k.standings?.entries?.length);
    const body = kids.length ? kids.map((k) => `<h4>${esc(k.name)}</h4>${table(k.standings.entries)}`).join('') : table(c.standings?.entries || []);
    return `<section class="stand-conf"><h3>${esc(c.name)}</h3>${body}</section>`;
  };
  const div = state.league === 'cfb' ? ` · ${state.division === 'all' ? 'FBS + FCS' : state.division === '81' ? 'FCS' : 'FBS'}` : '';
  $('panel').innerHTML = `<div class="panel-head"><h2>${esc(lg.label)} standings${div}</h2><span class="poll-meta">Click a team to find its game</span></div><div class="panel-grid">${confs.map(block).join('') || '<div class="empty">No standings available.</div>'}</div>`;
  applyPanelFilter();
}

function renderRankings() {
  const polls = pollsFor(state.league); const type = currentPollType();
  const poll = polls.find((r) => r.type === type);
  if (!poll) { $('panel').innerHTML = '<div class="empty">No rankings available for this league.</div>'; return; }
  const trend = (r) => {
    const t = String(r.trend || '-');
    if (!r.previous) return '<span class="trend new">NEW</span>';
    if (t === '-' || t === '0' || t === '') return '<span class="trend flat">–</span>';
    const up = t.startsWith('+');
    return `<span class="trend ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${esc(t.replace(/^[+-]/, ''))}</span>`;
  };
  const name = (t) => t.location || t.nickname || t.name || '';
  const row = (r) => {
    const t = r.team;
    return `<tr data-team="${esc(t.id)}" data-name="${esc(`${t.location || ''} ${t.name || ''}`.trim())}" class="${favorites.has(String(t.id)) ? 'fav' : ''}"><td class="rnk">${r.current}</td><td class="tm"><img src="${esc(t.logo || t.logos?.[0]?.href || '')}" alt="" loading="lazy"><span class="nm">${esc(name(t))}</span><span class="rec">${esc(r.recordSummary || '')}</span></td><td>${trend(r)}</td><td>${r.points ? Math.round(r.points).toLocaleString() : '–'}</td><td>${r.firstPlaceVotes ? `(${r.firstPlaceVotes})` : ''}</td></tr>`;
  };
  const others = (poll.others || []).filter((o) => o.points > 0).map((o) => `${esc(name(o.team))} <b>${Math.round(o.points)}</b>`).join(', ');
  const dropped = (poll.droppedOut || []).map((o) => `${esc(name(o.team))} (was ${o.previous})`).join(', ');
  const hasFpv = (poll.ranks || []).some((r) => r.firstPlaceVotes);
  const when = poll.date ? new Date(poll.date).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
  $('panel').innerHTML = `<div class="panel-head"><h2>${esc(poll.name)}</h2><span class="poll-meta">${esc(poll.occurrence?.displayValue || '')}${when ? ` · ${when}` : ''} · trend vs. last poll · click a team to find its game</span></div>
    <div class="stand-conf" style="max-width:760px"><table class="stable rank-table"><thead><tr><th></th><th class="tm">Team</th><th>Trend</th><th>Pts</th><th>${hasFpv ? '1st votes' : ''}</th></tr></thead><tbody>${(poll.ranks || []).map(row).join('')}</tbody></table>
    ${others ? `<div class="votes"><b>Others receiving votes:</b> ${others}</div>` : ''}${dropped ? `<div class="votes"><b>Dropped out:</b> ${dropped}</div>` : ''}</div>`;
  applyPanelFilter();
}

function applyPanelFilter() {
  const q = state.search.trim().toLowerCase();
  $('panel').querySelectorAll('tr[data-team]').forEach((tr) => tr.classList.toggle('hide', !!q && !tr.dataset.name.toLowerCase().includes(q)));
}

let controlsKey = '';
function syncControls() {
  const key = JSON.stringify([state.league, state.division, viewMeta?.week?.number, viewMeta?.season?.type, (viewMeta?.calendar || []).length, confMaps[state.league]?.confs.length || 0]);
  if (key === controlsKey) return;
  controlsKey = key; renderControls();
}

function step(dir) {
  const lg = L();
  if (lg.mode === 'week') {
    const opts = [...$('periodSelect').options]; const i = opts.findIndex((o) => o.selected);
    const next = opts[i + dir]; if (!next) return;
    const [type, number] = next.value.split(':').map(Number); state.week = { type, number };
  } else if (state.weekend) {
    const d = fromYmd(weekendDates(state.date)[0]); d.setDate(d.getDate() + 7 * dir); state.date = ymd(d);
  } else {
    const opts = [...$('periodSelect').options]; const i = opts.findIndex((o) => o.selected);
    const next = opts[i + dir];
    if (next) state.date = next.value;
    else { const d = fromYmd(state.date || ymd(new Date())); d.setDate(d.getDate() + dir); state.date = ymd(d); }
  }
  changeView();
}

function changeView() {
  viewEvents = []; cardNodes.clear();
  $('board').innerHTML = '<div class="grid">' + '<div class="skeleton"></div>'.repeat(6) + '</div>';
  $('statusText').textContent = 'Loading…';
  renderControls();
  clearInterval(timer);
  if (state.view !== 'scores') loadPanel();
  refresh({ manual: true });
}

function writeHash() {
  const p = new URLSearchParams();
  p.set('league', state.league);
  if (state.league === 'cfb' && state.division !== '80') p.set('div', state.division);
  if (state.conf) p.set('conf', state.conf);
  if (state.week) { p.set('week', state.week.number); p.set('st', state.week.type); }
  if (state.date) p.set('date', state.date);
  if (state.weekend) p.set('weekend', '1');
  if (state.top25) p.set('top25', '1');
  if (state.sort !== 'status') p.set('sort', state.sort);
  if (state.view !== 'scores') p.set('view', state.view);
  if (state.poll) p.set('poll', state.poll);
  if (drawer && drawer.league === state.league) p.set('game', drawer.id);
  try { history.replaceState(null, '', `${location.pathname}${location.search}#${p.toString()}`); } catch { /* ignore */ }
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('league') && LEAGUES[p.get('league')]) state.league = p.get('league');
  if (p.get('div')) state.division = p.get('div');
  if (p.get('conf')) state.conf = p.get('conf');
  if (p.get('week')) state.week = { number: +p.get('week'), type: +(p.get('st') || 2) };
  if (p.get('date')) state.date = p.get('date');
  if (p.get('weekend')) state.weekend = true;
  if (p.get('top25')) state.top25 = true;
  if (p.get('sort')) state.sort = p.get('sort');
  if (p.get('game')) state.game = p.get('game');
  if (['standings', 'rankings'].includes(p.get('view'))) state.view = p.get('view');
  if (p.get('poll')) state.poll = p.get('poll');
}

/* ------------------------------------------------------------------ drawer */
function findEvent(league, id) {
  return viewEvents.find((e) => e.id === id && e.__league === league) || stripEvents.find((e) => e.id === id && e.__league === league);
}
async function openDrawer(league, id) {
  drawer = { league, id };
  $('drawer').hidden = false; $('scrim').hidden = false; document.body.style.overflow = 'hidden';
  writeHash();
  renderDrawer(); await refreshDrawer();
}
function closeDrawer() { drawer = null; $('drawer').hidden = true; $('scrim').hidden = true; document.body.style.overflow = ''; writeHash(); }

async function refreshDrawer() {
  if (!drawer) return;
  const ev = findEvent(drawer.league, drawer.id); if (!ev) return;
  const lg = LEAGUES[drawer.league];
  const cached = summaryCache.get(ev.id);
  const ttl = stateOf(ev) === 'in' ? 10000 : 5 * 60000;
  if (cached && Date.now() - cached.ts < ttl) { renderDrawer(); return; }
  try {
    const data = await fetchJSON(`${API}/${lg.sport}/${lg.slug}/summary?event=${ev.id}`);
    summaryCache.set(ev.id, { ts: Date.now(), data });
  } catch (e) { console.warn('summary failed', e); }
  if (drawer && drawer.id === ev.id) renderDrawer();
}

function linescoreTable(ev) {
  const h = home(ev), a = away(ev);
  const ls = (c) => c.linescores || [];
  const n = Math.max(ls(h).length, ls(a).length, LEAGUES[leagueOf(ev)].periods);
  if (!ls(h).length && !ls(a).length) return '';
  const cols = [...Array(n)].map((_, i) => periodHeader(ev, i + 1));
  const row = (c) => `<tr><td><img src="${esc(c.team.logo)}" alt="" style="width:18px;height:18px;vertical-align:middle;margin-right:6px">${esc(c.team.abbreviation)}</td>${cols.map((_, i) => `<td>${esc(ls(c)[i]?.displayValue ?? '')}</td>`).join('')}<td class="tot">${score(c) ?? ''}</td></tr>`;
  return `<table class="linescore"><thead><tr><th></th>${cols.map((c) => `<th>${c}</th>`).join('')}<th>T</th></tr></thead><tbody>${row(a)}${row(h)}</tbody></table>`;
}

function winProbChart(ev, sum) {
  const wp = sum?.winprobability; if (!wp || wp.length < 2) return '';
  const h = home(ev), a = away(ev);
  const W = 600, H = 120, padL = 4, padR = 4, top = 10, bot = 10;
  const n = wp.length; const x = (i) => padL + (i / (n - 1)) * (W - padL - padR); const y = (p) => top + (1 - p) * (H - top - bot);
  const pts = wp.map((w, i) => `${x(i).toFixed(1)},${y(w.homeWinPercentage).toFixed(1)}`);
  const last = wp[n - 1].homeWinPercentage;
  const playIndex = {}; const drives = [...(sum.drives?.previous || []), ...(sum.drives?.current ? [sum.drives.current] : [])];
  for (const d of drives) for (const p of d.plays || []) playIndex[p.id] = p;
  const meta = wp.map((w) => { const p = playIndex[w.playId]; return p ? `${periodLabel(ev, p.period?.number || 0)} ${p.clock?.displayValue || ''} · ${a.team.abbreviation} ${p.awayScore} – ${h.team.abbreviation} ${p.homeScore}` : ''; });
  return `<div class="d-sec"><h3>Win probability</h3><div class="wp" data-meta='${esc(JSON.stringify(meta))}' data-wp='${esc(JSON.stringify(wp.map((w) => +w.homeWinPercentage.toFixed(3))))}' data-home="${esc(h.team.abbreviation)}" data-away="${esc(a.team.abbreviation)}">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Home win probability over the game">
      <line class="mid" x1="${padL}" x2="${W - padR}" y1="${y(0.5)}" y2="${y(0.5)}"/>
      <line class="axis" x1="${padL}" x2="${W - padR}" y1="${H - bot}" y2="${H - bot}"/>
      <path class="area" d="M${x(0)},${y(0.5)} L${pts.join(' L')} L${x(n - 1)},${y(0.5)} Z"/>
      <polyline class="line" points="${pts.join(' ')}"/>
      <line class="cross" x1="0" x2="0" y1="${top}" y2="${H - bot}" style="display:none"/>
      <circle class="dot" r="4" cx="${x(n - 1)}" cy="${y(last)}"/>
    </svg>
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:4px"><span>↑ ${esc(h.team.abbreviation)} favored</span><span><b style="color:var(--text)">${Math.round(last * 100)}%</b> ${esc(h.team.abbreviation)} now</span><span>↓ ${esc(a.team.abbreviation)} favored</span></div>
    <div class="tip" hidden></div></div></div>`;
}

function statsSection(ev, sum) {
  const teams = sum?.boxscore?.teams; if (!teams?.length) return '';
  const h = home(ev), a = away(ev);
  const tH = teams.find((t) => t.homeAway === 'home' || String(t.team.id) === String(h.team.id)) || teams[1];
  const tA = teams.find((t) => t !== tH) || teams[0];
  const get = (t, k) => (t?.statistics || []).find((s) => s.name === k);
  const keys = LEAGUES[leagueOf(ev)].sport === 'football' ? STATS_FOOTBALL : STATS_HOCKEY;
  const rows = keys.map(([k, label]) => {
    const sa = get(tA, k), sh = get(tH, k); if (!sa && !sh) return '';
    const na = parseFloat(String(sa?.displayValue ?? '').split(/[-/:]/)[0]), nh = parseFloat(String(sh?.displayValue ?? '').split(/[-/:]/)[0]);
    const tot = (na || 0) + (nh || 0);
    const bar = tot > 0 && !isNaN(na) && !isNaN(nh) ? `<div class="statbar"><div class="half"><i class="a" style="width:${(na / tot * 100).toFixed(0)}%"></i></div><div class="half"><i class="h" style="width:${(nh / tot * 100).toFixed(0)}%"></i></div></div>` : '';
    return `<div class="statrow"><span class="v">${esc(sa?.displayValue ?? '–')}</span><div><div class="lbl">${esc(label)}</div>${bar}</div><span class="v r">${esc(sh?.displayValue ?? '–')}</span></div>`;
  }).join('');
  if (!rows.trim()) return '';
  return `<div class="d-sec"><h3>Team stats</h3><div class="statrow"><span class="v">${esc(a.team.abbreviation)}</span><span></span><span class="v r">${esc(h.team.abbreviation)}</span></div>${rows}</div>`;
}

function scoringSection(ev, sum) {
  let plays = sum?.scoringPlays;
  if (!plays?.length && sum?.plays?.length) plays = sum.plays.filter((p) => p.scoringPlay);
  if (!plays?.length) return '';
  const h = home(ev), a = away(ev);
  const logoOf = (p) => p.team?.logo || comp(ev).competitors.find((c) => String(c.team.id) === String(p.team?.id))?.team.logo || '';
  return `<div class="d-sec"><h3>Scoring</h3><ul class="plays">${plays.slice().reverse().map((p) => `<li><img src="${esc(logoOf(p))}" alt=""><div>${p.type?.abbreviation ? `<span class="pt">${esc(p.type.abbreviation)}</span>` : ''}${esc(p.text)}<div class="when">${esc(periodLabel(ev, p.period?.number || 0))} ${esc(p.clock?.displayValue || '')}</div></div><span class="sc">${esc(a.team.abbreviation)} ${p.awayScore} · ${esc(h.team.abbreviation)} ${p.homeScore}</span></li>`).join('')}</ul></div>`;
}

function recentPlaysSection(ev, sum) {
  if (stateOf(ev) !== 'in') return '';
  let plays = [];
  if (sum?.drives) { const d = sum.drives.current || sum.drives.previous?.slice(-1)[0]; plays = d?.plays || []; }
  else if (sum?.plays) plays = sum.plays;
  if (!plays.length) return '';
  return `<div class="d-sec"><h3>Recent plays</h3><ul class="plays">${plays.slice(-6).reverse().map((p) => `<li><span class="when">${esc(periodLabel(ev, p.period?.number || 0))}<br>${esc(p.clock?.displayValue || '')}</span><div>${esc(p.text)}</div><span></span></li>`).join('')}</ul></div>`;
}

function leadersSection(ev, sum) {
  const ld = sum?.leaders; if (!ld?.length) return '';
  const h = home(ev), a = away(ev);
  const col = (c) => {
    const t = ld.find((x) => String(x.team?.id) === String(c.team.id)); if (!t) return '<div></div>';
    return `<div><div class="cat" style="margin-bottom:6px;font-weight:700">${esc(c.team.abbreviation)}</div>${(t.leaders || []).slice(0, 3).map((cat) => { const l = cat.leaders?.[0]; if (!l) return ''; return `<div class="ld">${l.athlete?.headshot ? `<img src="${esc(l.athlete.headshot)}" alt="" loading="lazy">` : '<span style="width:28px"></span>'}<div><div class="cat">${esc(cat.shortDisplayName || cat.displayName)}</div><div class="who">${esc(l.athlete?.shortName || l.athlete?.displayName || '')}</div><div class="val">${esc(l.displayValue)}</div></div></div>`; }).join('')}</div>`;
  };
  const html = col(a) + col(h);
  if (!/class="ld"/.test(html)) return '';
  return `<div class="d-sec"><h3>Leaders</h3><div class="leaders">${html}</div></div>`;
}

function infoSection(ev, sum) {
  const c = comp(ev); const v = sum?.gameInfo?.venue || c.venue; const rows = [];
  if (v) rows.push(['Venue', `${v.fullName}${v.address?.city ? ` · ${v.address.city}${v.address.state ? `, ${v.address.state}` : ''}` : ''}`]);
  if (sum?.gameInfo?.attendance) rows.push(['Attendance', sum.gameInfo.attendance.toLocaleString()]);
  const tv = broadcast(ev); if (tv) rows.push(['TV', tv]);
  const o = oddsText(ev) || (sum?.pickcenter?.[0] ? `${sum.pickcenter[0].details || ''}${sum.pickcenter[0].overUnder != null ? ` · O/U ${sum.pickcenter[0].overUnder}` : ''}` : '');
  if (o) rows.push(['Line', o]);
  if (ev.weather?.displayValue) rows.push(['Weather', `${ev.weather.displayValue}${ev.weather.temperature != null ? ` · ${ev.weather.temperature}°` : ''}`]);
  if (c.neutralSite) rows.push(['Site', 'Neutral']);
  if (c.conferenceCompetition) rows.push(['Game', 'Conference']);
  if (!rows.length) return '';
  return `<div class="d-sec"><h3>Game info</h3><dl class="kv">${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl></div>`;
}

function renderDrawer() {
  if (!drawer) return;
  const ev = findEvent(drawer.league, drawer.id);
  const body = $('drawerBody');
  if (!ev) { body.innerHTML = '<p class="muted">Game is no longer in this view.</p>'; return; }
  const sum = summaryCache.get(ev.id)?.data; const st = stateOf(ev); const h = home(ev), a = away(ev); const sit = comp(ev).situation;
  const team = (c) => `<div class="d-team"><img src="${esc(c.team.logo)}" alt=""><div class="nm">${rank(c) ? `<span class="rank muted">${rank(c)} </span>` : ''}${esc(c.team.shortDisplayName)}</div><div class="rec">${esc(record(c))}</div></div>`;
  const hl = comp(ev).headlines?.[0];
  body.innerHTML = `
    <div class="d-head">${team(a)}<div class="d-score">${st === 'pre' ? '<span class="muted" style="font-size:18px">vs</span>' : `${score(a) ?? ''} – ${score(h) ?? ''}`}</div>${team(h)}</div>
    <div class="d-status ${st === 'in' ? 'live' : ''}">${esc(statusText(ev))}${tags(ev).map(([k, t]) => ` <span class="tag ${k}">${t}</span>`).join('')}</div>
    ${st === 'in' && sit?.downDistanceText ? `<div class="situation" style="justify-content:center">${esc(sit.downDistanceText)}${sit.isRedZone ? ' <span class="tag close">Red zone</span>' : ''}</div>` : ''}
    ${st === 'in' && sit?.lastPlay?.text ? `<p class="lastplay" style="text-align:center;margin:6px 0 0">${esc(sit.lastPlay.text)}</p>` : ''}
    ${hl?.description ? `<div class="d-sec"><h3>${esc(hl.type || 'Recap')}</h3><p style="margin:0;font-size:13px">${esc(hl.description.replace(/^[^A-Za-z0-9]+/, ''))}</p></div>` : ''}
    ${st !== 'pre' ? `<div class="d-sec"><h3>Scoring by ${LEAGUES[drawer.league].sport === 'hockey' ? 'period' : 'quarter'}</h3>${linescoreTable(ev) || '<p class="muted" style="margin:0">Not available yet.</p>'}</div>` : ''}
    ${winProbChart(ev, sum)}
    ${recentPlaysSection(ev, sum)}
    ${scoringSection(ev, sum)}
    ${statsSection(ev, sum)}
    ${leadersSection(ev, sum)}
    ${infoSection(ev, sum)}
    ${!sum && st !== 'pre' ? '<p class="muted">Loading details…</p>' : ''}
    <div class="d-links">${(ev.links || []).filter((l) => /summary|boxscore|gamecast|recap/i.test((l.rel || []).join(' ') + l.text)).slice(0, 3).map((l) => `<a href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.text)} ↗</a>`).join(' · ')}</div>`;
  wireChart(body.querySelector('.wp'));
}

function wireChart(wp) {
  if (!wp) return;
  const svg = wp.querySelector('svg'); const cross = svg.querySelector('.cross'); const dot = svg.querySelector('.dot'); const tip = wp.querySelector('.tip');
  const probs = JSON.parse(wp.dataset.wp); const meta = JSON.parse(wp.dataset.meta); const n = probs.length;
  const W = 600, H = 120, padL = 4, padR = 4, top = 10, bot = 10;
  const x = (i) => padL + (i / (n - 1)) * (W - padL - padR); const y = (p) => top + (1 - p) * (H - top - bot);
  const endCx = dot.getAttribute('cx'), endCy = dot.getAttribute('cy');
  const move = (clientX) => {
    const r = svg.getBoundingClientRect(); const i = Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left) / r.width) * (n - 1))));
    cross.style.display = ''; cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(probs[i]));
    const p = probs[i]; const fav = p >= 0.5 ? wp.dataset.home : wp.dataset.away; const pct = Math.round((p >= 0.5 ? p : 1 - p) * 100);
    tip.innerHTML = `<b>${esc(fav)} ${pct}%</b>${meta[i] ? `<br><span class="muted">${esc(meta[i])}</span>` : ''}`; tip.hidden = false;
    const px = (x(i) / W) * r.width; tip.style.left = `${Math.max(60, Math.min(r.width - 60, px))}px`; tip.style.top = `${(y(p) / H) * r.height}px`;
  };
  const leave = () => { cross.style.display = 'none'; tip.hidden = true; dot.setAttribute('cx', endCx); dot.setAttribute('cy', endCy); };
  svg.addEventListener('mousemove', (e) => move(e.clientX));
  svg.addEventListener('touchmove', (e) => { move(e.touches[0].clientX); }, { passive: true });
  svg.addEventListener('mouseleave', leave); svg.addEventListener('touchend', leave);
}

/* ------------------------------------------------------------------ events */
function wire() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { if (state.league === b.dataset.league) return; state.league = b.dataset.league; state.week = null; state.date = null; state.conf = ''; state.poll = ''; changeView(); }));
  document.querySelectorAll('.vtab').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('pollSelect').addEventListener('change', (e) => { state.poll = e.target.value; renderRankings(); writeHash(); });
  $('panel').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-team]'); if (!tr) return;
    state.search = tr.dataset.name; $('searchInput').value = state.search; showView('scores'); render();
  });
  $('divisionSelect').addEventListener('change', (e) => { state.division = e.target.value; state.conf = ''; state.poll = ''; changeView(); });
  $('confSelect').addEventListener('change', (e) => { state.conf = e.target.value; render(); writeHash(); if (state.view === 'standings') loadPanel(); });
  $('top25Btn').addEventListener('click', () => { state.top25 = !state.top25; renderControls(); render(); });
  $('favOnlyBtn').addEventListener('click', () => { state.favOnly = !state.favOnly; renderControls(); render(); });
  $('sortSelect').addEventListener('change', (e) => { state.sort = e.target.value; render(); writeHash(); });
  $('searchInput').addEventListener('input', (e) => { state.search = e.target.value; render(); applyPanelFilter(); });
  $('prevBtn').addEventListener('click', () => step(-1));
  $('nextBtn').addEventListener('click', () => step(1));
  $('todayBtn').addEventListener('click', () => { state.week = null; state.date = null; changeView(); });
  $('weekendBtn').addEventListener('click', () => { state.weekend = !state.weekend; changeView(); });
  $('periodSelect').addEventListener('change', (e) => {
    if (L().mode === 'week') { const [type, number] = e.target.value.split(':').map(Number); state.week = { type, number }; }
    else state.date = e.target.value;
    changeView();
  });
  $('refreshBtn').addEventListener('click', () => { clearInterval(timer); refresh({ manual: true }); });
  $('densityBtn').addEventListener('click', () => { state.density = state.density === 'compact' ? 'comfortable' : 'compact'; persist(); renderControls(); cardNodes.clear(); render(); });
  $('themeBtn').addEventListener('click', () => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const cur = state.theme === 'auto' ? (dark ? 'dark' : 'light') : state.theme;
    state.theme = cur === 'dark' ? 'light' : 'dark'; persist(); renderControls();
  });
  $('notifyBtn').addEventListener('click', async () => {
    if (!state.notify) {
      if (!('Notification' in window)) return toast('This browser does not support notifications.');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return toast('Notifications blocked by the browser.');
      state.notify = true; toast(favorites.size ? 'You will be alerted when a starred team scores.' : 'Alerts on. Star a team to get notified when it scores.');
    } else { state.notify = false; toast('Alerts off.'); }
    persist(); renderControls();
  });

  $('board').addEventListener('click', (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) { e.stopPropagation(); toggleFav(fav.dataset.fav); return; }
    const card = e.target.closest('.card'); if (card) openDrawer(state.league, card.dataset.id);
  });
  $('liveStrip').addEventListener('click', (e) => {
    const it = e.target.closest('[data-open]'); if (!it) return;
    const [lg, id] = it.dataset.open.split(':');
    if (lg !== state.league) { state.league = lg; state.week = null; state.date = null; state.conf = ''; changeView(); }
    openDrawer(lg, id);
  });
  $('drawerClose').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.key === 'Escape') closeDrawer();
    else if (e.key === '/') { e.preventDefault(); $('searchInput').focus(); }
    else if (e.key === 'r' || e.key === 'R') { clearInterval(timer); refresh({ manual: true }); }
    else if (e.key === '[') step(-1);
    else if (e.key === ']') step(1);
    else if (e.key === 's' || e.key === 'S') showView('scores');
    else if (e.key === 't' || e.key === 'T') showView('standings');
    else if ((e.key === 'p' || e.key === 'P') && L().ranked) showView('rankings');
    else if (['1', '2', '3'].includes(e.key)) document.querySelectorAll('.tab')[+e.key - 1].click();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearInterval(timer); refresh(); } });
  window.addEventListener('online', () => refresh());
}

function toggleFav(id) {
  id = String(id);
  if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
  save('lcs:favs', [...favorites]);
  cardNodes.clear(); render(); if (drawer) renderDrawer();
}
function persist() { save('lcs:settings', { notify: state.notify, density: state.density, theme: state.theme, division: state.division, sort: state.sort, weekend: state.weekend }); }

/* -------------------------------------------------------------------- boot */
function boot() {
  const s = load('lcs:settings', {});
  Object.assign(state, { notify: !!s.notify && ('Notification' in window) && Notification.permission === 'granted', density: s.density || 'comfortable', theme: s.theme || 'auto', division: s.division || '80', sort: s.sort || 'status', weekend: !!s.weekend });
  favorites = new Set((load('lcs:favs', []) || []).map(String));
  readHash();
  wire();
  $('board').hidden = state.view !== 'scores'; $('panel').hidden = state.view === 'scores';
  renderControls();
  changeView();
}
boot();
})();
