import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const FUB_BASE = 'https://api.followupboss.com/v1';

// Jan 1 2026 in ISO-8601 UTC — used for createdAfter filter
const START_ISO = '2026-01-01T00:00:00Z';
const START_DATE = new Date(START_ISO);

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

function getHeaders() {
  const key = process.env.FUB_API_KEY;
  if (!key) throw new Error('FUB_API_KEY not set');
  return {
    'Authorization': 'Basic ' + Buffer.from(key + ':').toString('base64'),
    'Accept': 'application/json',
    // Registered system key increases rate limit from 125 to 250 req/10s
    // Set FUB_SYSTEM_KEY in Render env vars if you have one, otherwise omit
    ...(process.env.FUB_SYSTEM_KEY ? { 'X-System-Key': process.env.FUB_SYSTEM_KEY } : {}),
  };
}

// ── Rate-aware fetch: respects Retry-After header on 429 ─────────────────────
let lastReqMs = 0;
async function fubFetch(pathOrUrl) {
  const { default: fetch } = await import('node-fetch');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : FUB_BASE + pathOrUrl;

  // Space requests ~300ms apart to stay well under 250/10s limit
  const gap = Date.now() - lastReqMs;
  if (gap < 300) await sleep(300 - gap);
  lastReqMs = Date.now();

  console.log('[FUB]', url.replace(FUB_BASE, '').slice(0, 120));
  const res = await fetch(url, { headers: getHeaders() });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '10', 10);
    console.log(`[FUB] 429 rate limited — waiting ${retryAfter}s`);
    await sleep(retryAfter * 1000 + 500);
    return fubFetch(pathOrUrl); // retry once
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessage || data.message || `HTTP ${res.status}`);
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Paginate using nextLink from _metadata ────────────────────────────────────
// Per docs: default sort is descending by id. We use createdAfter to limit scope.
async function fetchAll(endpoint, extraParams = '') {
  const LIST_KEYS = {
    calls: 'calls', appointments: 'appointments', deals: 'deals', textMessages: 'textMessages',
  };
  let all = [];
  // Use createdAfter (documented filter) to scope to Jan 2026+
  // This dramatically reduces pages needed
  let url = `${FUB_BASE}/${endpoint}?limit=100&createdAfter=${START_ISO}${extraParams}`;
  let page = 0;
  const maxPages = 50;

  while (url && page < maxPages) {
    const data = await fubFetch(url);
    const listKey = LIST_KEYS[endpoint] || Object.keys(data).find(k => Array.isArray(data[k]));
    const batch = listKey ? (data[listKey] || []) : [];
    all = all.concat(batch);
    console.log(`  page ${page + 1}: ${batch.length} records (total: ${all.length})`);
    // Follow nextLink from _metadata per docs
    const nextLink = data._metadata?.nextLink;
    if (!nextLink || batch.length === 0) break;
    url = nextLink;
    page++;
  }
  return all;
}

// Appointments use 'start' not 'created' as their primary date field
// So we fetch without date filter and filter in JS
async function fetchAllAppts(extraParams = '') {
  let all = [];
  let url = `${FUB_BASE}/appointments?limit=100${extraParams}`;
  let page = 0;
  while (url && page < 50) {
    const data = await fubFetch(url);
    const batch = data.appointments || [];
    all = all.concat(batch);
    const nextLink = data._metadata?.nextLink;
    if (!nextLink || batch.length === 0) break;
    url = nextLink;
    page++;
  }
  return all;
}

// ── In-memory cache (10 min TTL) ─────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
function cacheGet(k) {
  const e = cache.get(k);
  if (!e || Date.now() - e.ts > CACHE_TTL) { cache.delete(k); return null; }
  return e.data;
}
function cacheSet(k, v) { cache.set(k, { data: v, ts: Date.now() }); }

// ── Date helpers ──────────────────────────────────────────────────────────────
// FUB confirmed field names: 'created', 'updated', 'start' (appointments)
function callDate(c)  { return c.created || c.updated || null; }
function apptDate(a)  { return a.start   || a.created || null; }
function dealDate(d)  { return d.created || d.updated || null; }

function inRange(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !isNaN(d) && d >= START_DATE;
}

function weekKey(ds) {
  const d = new Date(ds);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - day);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const w = Math.ceil(((d - jan1) / 86400000 + 1) / 7);
  return `${d.getFullYear()}-W${String(w).padStart(2,'0')}`;
}
function monthKey(ds) {
  const d = new Date(ds);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function ensure(map, k) {
  if (!map[k]) map[k] = { dials:0, connectedCalls:0, talkSec:0, appts:0, apptsAttended:0, offers:0, verbals:0, contracts:0 };
  return map[k];
}
function enrich(map) {
  return Object.entries(map).sort(([a],[b])=>a.localeCompare(b)).map(([period,m])=>({
    period,
    dials: m.dials,
    connectedCalls: m.connectedCalls,
    talkTimeHrs: Math.round(m.talkSec / 3600 * 10) / 10,
    appts: m.appts,
    apptsAttended: m.apptsAttended,
    showRate: m.appts ? Math.round(m.apptsAttended/m.appts*100) : 0,
    dialToConnect: m.dials ? Math.round(m.connectedCalls/m.dials*100) : 0,
    offers: m.offers, verbals: m.verbals, contracts: m.contracts,
  }));
}

// ── Aggregation ───────────────────────────────────────────────────────────────
// Per docs: isIncoming=false means outbound (agent-initiated = "Calls Made" in FUB reporting)
// duration = seconds of talk time (confirmed from OpenAPI example)
function addCalls(calls, wMap, mMap) {
  let n = 0;
  for (const c of calls) {
    const ds = callDate(c);
    if (!inRange(ds)) continue;
    n++;
    const w = weekKey(ds), mo = monthKey(ds);
    const dur = Number(c.duration) || 0;
    // isIncoming=false = outbound = "Calls Made" in FUB reporting
    // isIncoming=true  = inbound  = "Received" in FUB reporting
    // isIncoming=null  = unknown  — exclude from dials to avoid overcounting
    if (c.isIncoming === false) {
      ensure(wMap,w).dials++;
      ensure(mMap,mo).dials++;
      // Connected = outbound call with duration > 0
      if (dur > 0) {
        ensure(wMap,w).connectedCalls++;
        ensure(mMap,mo).connectedCalls++;
      }
    }
    // Talk time = all calls with duration regardless of direction
    ensure(wMap,w).talkSec += dur;
    ensure(mMap,mo).talkSec += dur;
  }
  return n;
}

function addAppts(appts, wMap, mMap) {
  let n = 0;
  for (const a of appts) {
    const ds = apptDate(a);
    if (!inRange(ds)) continue;
    n++;
    const w = weekKey(ds), mo = monthKey(ds);
    ensure(wMap,w).appts++; ensure(mMap,mo).appts++;
    if ((a.outcome||'').toLowerCase() === 'attended' || a.attended === true) {
      ensure(wMap,w).apptsAttended++; ensure(mMap,mo).apptsAttended++;
    }
  }
  return n;
}

function addDeals(deals, wMap, mMap) {
  let n = 0;
  for (const d of deals) {
    const ds = dealDate(d);
    if (!inRange(ds)) continue;
    n++;
    const w = weekKey(ds), mo = monthKey(ds);
    // FUB confirmed field: stageName
    const stage = (d.stageName || d.stage || '').toLowerCase();
    if (stage.includes('offer'))   { ensure(wMap,w).offers++;    ensure(mMap,mo).offers++; }
    if (stage.includes('verbal'))  { ensure(wMap,w).verbals++;   ensure(mMap,mo).verbals++; }
    if (stage.includes('contract')||stage.includes('sign')||stage.includes('pending')||stage.includes('win')) {
      ensure(wMap,w).contracts++; ensure(mMap,mo).contracts++;
    }
  }
  return n;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/health', (req,res) => res.json({ ok:!!process.env.FUB_API_KEY, keySet:!!process.env.FUB_API_KEY }));

app.get('/api/users', async (req,res) => {
  try {
    const c = cacheGet('users');
    if (c) return res.json(c);
    const data = await fubFetch('/users');
    const result = { ok:true, users: data.users||[] };
    cacheSet('users', result);
    res.json(result);
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

// Raw field inspector — open in browser to verify exact FUB field names
app.get('/api/debug/:endpoint', async (req,res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const path = `/${req.params.endpoint}?limit=3${qs?'&'+qs:''}`;
    const data = await fubFetch(path);
    const keys = Object.keys(data);
    const listKey = keys.find(k => Array.isArray(data[k]));
    const list = listKey ? data[listKey] : [];
    res.json({ ok:true, path, topLevelKeys:keys, listKey, count:list.length, metadata:data._metadata||null, records:list });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.get('/api/probe/:endpoint', async (req,res) => {
  const ep = req.params.endpoint;
  const ALLOWED = ['people','calls','appointments','deals','tasks','textMessages','notes','events','smartLists','stages'];
  if (!ALLOWED.includes(ep)) return res.status(400).json({ ok:false, error:'Unknown endpoint' });
  try {
    const data = await fubFetch(`/${ep}?limit=1`);
    const keys = Object.keys(data);
    const listKey = keys.find(k => Array.isArray(data[k]));
    const sample = listKey && data[listKey][0] ? Object.keys(data[listKey][0]) : [];
    res.json({ ok:true, topLevelKeys:keys, sampleFields:sample });
  } catch(e) { res.status(200).json({ ok:false, error:e.message }); }
});

// KPI: per-agent (userId param) or team (no param — loops per user)
app.get('/api/kpi', async (req,res) => {
  const { userId } = req.query;
  const cKey = userId ? `kpi_u_${userId}` : 'kpi_team';
  const cached = cacheGet(cKey);
  if (cached) return res.json(cached);

  try {
    const wMap = {}, mMap = {};
    let ci=0, ai=0, di=0;

    if (userId) {
      // Single agent
      const [calls, appts, deals] = await Promise.all([
        fetchAll('calls', `&userId=${userId}`),
        fetchAllAppts(`&userId=${userId}`),
        fetchAll('deals', `&userId=${userId}`),
      ]);
      ci = addCalls(calls, wMap, mMap);
      ai = addAppts(appts, wMap, mMap);
      di = addDeals(deals, wMap, mMap);
      console.log(`[KPI user:${userId}] calls:${ci}/${calls.length} appts:${ai}/${appts.length} deals:${di}/${deals.length}`);
    } else {
      // Team — fetch per user sequentially to avoid rate limits
      const { users=[] } = await fubFetch('/users');
      for (const u of users) {
        try {
          console.log(`[KPI team] → ${u.name}`);
          const calls = await fetchAll('calls', `&userId=${u.id}`);
          const appts = await fetchAllAppts(`&userId=${u.id}`);
          const deals = await fetchAll('deals', `&userId=${u.id}`);
          const uc = addCalls(calls, wMap, mMap);
          const ua = addAppts(appts, wMap, mMap);
          const ud = addDeals(deals, wMap, mMap);
          ci+=uc; ai+=ua; di+=ud;
          console.log(`  ${u.name}: calls:${uc} appts:${ua} deals:${ud}`);
          await sleep(200);
        } catch(e) { console.error(`  error for ${u.name}:`, e.message); }
      }
      console.log(`[KPI team] TOTAL inRange → calls:${ci} appts:${ai} deals:${di}`);
    }

    const result = { ok:true, weekly:enrich(wMap), monthly:enrich(mMap),
      debug:{ callsInRange:ci, apptsInRange:ai, dealsInRange:di } };
    cacheSet(cKey, result);
    res.json(result);
  } catch(e) {
    console.error('/api/kpi error:', e.message);
    res.status(400).json({ ok:false, error:e.message });
  }
});

// All-agent leaderboard — each agent fetched independently with own wMap/mMap
app.get('/api/kpi/all', async (req,res) => {
  const cached = cacheGet('kpi_all');
  if (cached) return res.json(cached);
  try {
    const { users=[] } = await fubFetch('/users');
    const agents = [];

    for (const u of users) {
      // Check if we already have this user's full KPI cached
      const userCached = cacheGet(`kpi_u_${u.id}`);
      if (userCached) {
        // Derive summary from cached weekly data
        const weekly = userCached.weekly || [];
        const dials   = weekly.reduce((s,p)=>s+p.dials,0);
        const conn    = weekly.reduce((s,p)=>s+p.connectedCalls,0);
        const talkHrs = weekly.reduce((s,p)=>s+p.talkTimeHrs,0);
        const appts   = weekly.reduce((s,p)=>s+p.appts,0);
        const att     = weekly.reduce((s,p)=>s+p.apptsAttended,0);
        const offers  = weekly.reduce((s,p)=>s+p.offers,0);
        const verbals = weekly.reduce((s,p)=>s+p.verbals,0);
        const contracts= weekly.reduce((s,p)=>s+p.contracts,0);
        agents.push({
          userId:u.id, name:u.name, email:u.email,
          dials, connectedCalls:conn,
          talkTimeHrs: Math.round(talkHrs*10)/10,
          appts, apptsAttended:att,
          showRate: appts ? Math.round(att/appts*100):0,
          dialToConnect: dials ? Math.round(conn/dials*100):0,
          offers, verbals, contracts,
        });
        continue;
      }

      try {
        console.log(`[KPI/all] → ${u.name}`);
        // Each user gets their own independent maps
        const uWMap = {}, uMMap = {};
        const calls = await fetchAll('calls', `&userId=${u.id}`);
        const appts = await fetchAllAppts(`&userId=${u.id}`);
        const deals = await fetchAll('deals', `&userId=${u.id}`);

        addCalls(calls, uWMap, uMMap);
        addAppts(appts, uWMap, uMMap);
        addDeals(deals, uWMap, uMMap);

        const weekly  = enrich(uWMap);
        const monthly = enrich(uMMap);

        // Cache the full trend data for this user
        cacheSet(`kpi_u_${u.id}`, { ok:true, weekly, monthly });

        // Derive totals from weekly periods
        const dials    = weekly.reduce((s,p)=>s+p.dials,0);
        const conn     = weekly.reduce((s,p)=>s+p.connectedCalls,0);
        const talkHrs  = weekly.reduce((s,p)=>s+p.talkTimeHrs,0);
        const apptCnt  = weekly.reduce((s,p)=>s+p.appts,0);
        const att      = weekly.reduce((s,p)=>s+p.apptsAttended,0);

        agents.push({
          userId:u.id, name:u.name, email:u.email,
          dials, connectedCalls:conn,
          talkTimeHrs: Math.round(talkHrs*10)/10,
          appts:apptCnt, apptsAttended:att,
          showRate: apptCnt ? Math.round(att/apptCnt*100):0,
          dialToConnect: dials ? Math.round(conn/dials*100):0,
          offers:   weekly.reduce((s,p)=>s+p.offers,0),
          verbals:  weekly.reduce((s,p)=>s+p.verbals,0),
          contracts:weekly.reduce((s,p)=>s+p.contracts,0),
        });
        await sleep(200);
      } catch(e) {
        console.error(`  error for ${u.name}:`, e.message);
        agents.push({ userId:u.id, name:u.name, error:e.message });
      }
    }

    const result = { ok:true, agents };
    cacheSet('kpi_all', result);
    res.json(result);
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

app.get('/api/cache', (req,res) => res.json({ entries:[...cache.keys()], ttlMs:CACHE_TTL }));
app.delete('/api/cache', (req,res) => { cache.clear(); res.json({ ok:true, cleared:true }); });

// Clear cache on every startup so stale data never persists across deploys
cache.clear();

app.listen(PORT, () => {
  console.log(`\n🚀 FUB KPI Dashboard at http://localhost:${PORT}`);
  console.log(`   API key: ${!!process.env.FUB_API_KEY}`);
  console.log(`   System key: ${!!process.env.FUB_SYSTEM_KEY} (increases rate limit)`);
  console.log(`\n   createdAfter filter: ${START_ISO}`);
  console.log(`   Debug: /api/debug/calls  /api/debug/appointments  /api/debug/deals\n`);
});
