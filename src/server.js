import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const FUB_BASE = 'https://api.followupboss.com/v1';

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

function getFubAuth() {
  const key = process.env.FUB_API_KEY;
  if (!key) throw new Error('FUB_API_KEY not set in environment');
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

// ── Rate-limited fetch: max 1 request per 300ms ───────────────────────────────
let lastRequestTime = 0;
async function fubFetch(pathOrUrl) {
  const { default: fetch } = await import('node-fetch');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : FUB_BASE + pathOrUrl;

  // Throttle: wait if last request was < 350ms ago
  const now = Date.now();
  const gap = now - lastRequestTime;
  if (gap < 350) await sleep(350 - gap);
  lastRequestTime = Date.now();

  console.log('[FUB]', url.replace(FUB_BASE, '').slice(0, 80));
  const res = await fetch(url, {
    headers: { Authorization: getFubAuth(), Accept: 'application/json' },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessage || data.message || `HTTP ${res.status}`);
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Cursor pagination (follows nextLink) ──────────────────────────────────────
const LIST_KEYS = {
  calls: 'calls', appointments: 'appointments', deals: 'deals',
  texts: 'textMessages', notes: 'notes', events: 'events',
};

async function fetchAllCursor(endpoint, extraParams = '') {
  let all = [];
  let url = `${FUB_BASE}/${endpoint}?limit=100${extraParams}&sort=id&direction=asc`;
  const maxPages = 30; // 3000 records max per endpoint per user
  let page = 0;

  while (url && page < maxPages) {
    let data;
    try {
      data = await fubFetch(url);
    } catch (e) {
      if (e.message.includes('rate limit')) {
        console.log('[FUB] Rate limited — waiting 5s...');
        await sleep(5000);
        data = await fubFetch(url); // one retry
      } else throw e;
    }

    const listKey = LIST_KEYS[endpoint] || Object.keys(data).find(k => Array.isArray(data[k]));
    const batch = listKey ? (data[listKey] || []) : [];
    all = all.concat(batch);

    const next = data._metadata?.nextLink || data.metadata?.nextLink || data.nextLink;
    if (!next || batch.length === 0) break;
    url = next;
    page++;
  }

  console.log(`[FUB] ${endpoint}${extraParams.slice(0,20)} → ${all.length} total records`);
  return all;
}

// ── In-memory cache (5 min TTL) ───────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── Date helpers ──────────────────────────────────────────────────────────────
const START_DATE = new Date('2026-01-01T00:00:00Z');
function inRange(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !isNaN(d) && d >= START_DATE;
}
function getWeekKey(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - day);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
function getMonthKey(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function ensure(map, key) {
  if (!map[key]) map[key] = { dials:0, connectedCalls:0, talkTimeSec:0, appts:0, apptsAttended:0, offers:0, verbals:0, contracts:0, textsSent:0, textsReceived:0 };
  return map[key];
}
function enrichPeriods(map) {
  return Object.entries(map).sort(([a],[b])=>a.localeCompare(b)).map(([period, m]) => ({
    period,
    dials: m.dials, connectedCalls: m.connectedCalls,
    talkTimeMin: Math.round(m.talkTimeSec / 60),
    appts: m.appts, apptsAttended: m.apptsAttended,
    showRate: m.appts ? Math.round((m.apptsAttended/m.appts)*100) : 0,
    dialToConnect: m.dials ? Math.round((m.connectedCalls/m.dials)*100) : 0,
    connectToAppt: m.connectedCalls ? Math.round((m.appts/m.connectedCalls)*100) : 0,
    offers: m.offers, verbals: m.verbals, contracts: m.contracts,
    textsSent: m.textsSent, textsReceived: m.textsReceived,
    responseRate: m.textsSent ? Math.round((m.textsReceived/m.textsSent)*100) : 0,
  }));
}

function digestCalls(calls, wMap, mMap) {
  let cnt = 0;
  calls.forEach(c => {
    const dateStr = c.createdAt || c.completedAt || c.updatedAt;
    if (!inRange(dateStr)) return;
    cnt++;
    const w = getWeekKey(dateStr), mo = getMonthKey(dateStr);
    const isOut = (c.type||'').toLowerCase()==='outbound'||(c.direction||'').toLowerCase()==='outbound';
    if (isOut) { ensure(wMap,w).dials++; ensure(mMap,mo).dials++; }
    const dur = Number(c.duration)||0;
    if (dur > 0) { ensure(wMap,w).connectedCalls++; ensure(mMap,mo).connectedCalls++; }
    ensure(wMap,w).talkTimeSec += dur;
    ensure(mMap,mo).talkTimeSec += dur;
  });
  return cnt;
}

function digestAppts(appts, wMap, mMap) {
  let cnt = 0;
  appts.forEach(a => {
    const dateStr = a.start || a.createdAt || a.updatedAt;
    if (!inRange(dateStr)) return;
    cnt++;
    const w = getWeekKey(dateStr), mo = getMonthKey(dateStr);
    ensure(wMap,w).appts++; ensure(mMap,mo).appts++;
    if ((a.outcome||'').toLowerCase()==='attended'||a.attended===true) {
      ensure(wMap,w).apptsAttended++; ensure(mMap,mo).apptsAttended++;
    }
  });
  return cnt;
}

function digestDeals(deals, wMap, mMap) {
  let cnt = 0;
  deals.forEach(d => {
    const dateStr = d.createdAt || d.updatedAt;
    if (!inRange(dateStr)) return;
    cnt++;
    const w = getWeekKey(dateStr), mo = getMonthKey(dateStr);
    const stage = (d.stage||'').toLowerCase();
    if (stage.includes('offer'))   { ensure(wMap,w).offers++;    ensure(mMap,mo).offers++; }
    if (stage.includes('verbal'))  { ensure(wMap,w).verbals++;   ensure(mMap,mo).verbals++; }
    if (stage.includes('contract')||stage.includes('sign')||stage.includes('pending')) {
      ensure(wMap,w).contracts++; ensure(mMap,mo).contracts++;
    }
  });
  return cnt;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ ok: !!process.env.FUB_API_KEY, keySet: !!process.env.FUB_API_KEY });
});

app.get('/api/users', async (req, res) => {
  try {
    const cached = cacheGet('users');
    if (cached) return res.json(cached);
    const data = await fubFetch('/users');
    const result = { ok: true, users: data.users || [] };
    cacheSet('users', result);
    res.json(result);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/api/debug/:endpoint', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const path = `/${req.params.endpoint}?limit=3${qs ? '&'+qs : ''}`;
    const data = await fubFetch(path);
    const keys = Object.keys(data);
    const listKey = keys.find(k => Array.isArray(data[k]));
    const list = listKey ? data[listKey] : [];
    res.json({ ok:true, path, topLevelKeys:keys, listKey, count:list.length,
      metadata: data._metadata||null, records: list.slice(0,3) });
  } catch (e) { res.json({ ok:false, error:e.message }); }
});

app.get('/api/probe/:endpoint', async (req, res) => {
  const ep = req.params.endpoint;
  const ALLOWED = ['people','calls','appointments','deals','tasks','texts','notes','events','smartLists','stages'];
  if (!ALLOWED.includes(ep)) return res.status(400).json({ ok:false, error:'Unknown endpoint' });
  try {
    const data = await fubFetch(`/${ep}?limit=1`);
    const keys = Object.keys(data);
    const listKey = keys.find(k => Array.isArray(data[k]));
    const sample = listKey && data[listKey][0] ? Object.keys(data[listKey][0]) : [];
    res.json({ ok:true, topLevelKeys:keys, sampleFields:sample });
  } catch (e) { res.status(200).json({ ok:false, error:e.message }); }
});

// Team-level KPI (no userId filter = all records, then filter by date in JS)
app.get('/api/kpi', async (req, res) => {
  const { userId } = req.query;
  const cacheKey = `kpi_${userId||'all'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const userParam = userId ? `&userId=${userId}` : '';

    // Fetch sequentially to avoid rate limits
    const calls = await fetchAllCursor('calls', userParam);
    const appts = await fetchAllCursor('appointments', userParam);
    const deals = await fetchAllCursor('deals', userParam);

    const wMap = {}, mMap = {};
    const ci = digestCalls(calls, wMap, mMap);
    const ai = digestAppts(appts, wMap, mMap);
    const di = digestDeals(deals, wMap, mMap);

    console.log(`[KPI] userId=${userId||'all'} inRange → calls:${ci} appts:${ai} deals:${di}`);

    const result = {
      ok: true,
      weekly: enrichPeriods(wMap),
      monthly: enrichPeriods(mMap),
      debug: { totalCalls:calls.length, callsInRange:ci, totalAppts:appts.length, apptsInRange:ai,
               totalDeals:deals.length, dealsInRange:di,
               callSample:calls[0]||null, apptSample:appts[0]||null },
    };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (e) {
    console.error('/api/kpi error:', e.message);
    res.status(400).json({ ok:false, error:e.message });
  }
});

// All agents leaderboard — fetches SEQUENTIALLY to respect rate limits
app.get('/api/kpi/all', async (req, res) => {
  const cached = cacheGet('kpi_all_agents');
  if (cached) return res.json(cached);

  try {
    const { users = [] } = await fubFetch('/users');
    const results = [];

    for (const u of users) {
      try {
        console.log(`[KPI/all] fetching agent: ${u.name}`);

        // Sequential per agent, not parallel
        const calls = await fetchAllCursor('calls', `&userId=${u.id}`);
        const appts = await fetchAllCursor('appointments', `&userId=${u.id}`);
        const deals = await fetchAllCursor('deals', `&userId=${u.id}`);

        const cr = calls.filter(c => inRange(c.createdAt||c.completedAt||c.updatedAt));
        const ar = appts.filter(a => inRange(a.start||a.createdAt||a.updatedAt));
        const dr = deals.filter(d => inRange(d.createdAt||d.updatedAt));

        const dials   = cr.filter(c=>(c.type||'').toLowerCase()==='outbound'||(c.direction||'').toLowerCase()==='outbound').length;
        const conn    = cr.filter(c=>(Number(c.duration)||0)>0).length;
        const talkSec = cr.reduce((s,c)=>s+(Number(c.duration)||0),0);
        const att     = ar.filter(a=>(a.outcome||'').toLowerCase()==='attended'||a.attended===true).length;

        results.push({
          userId:u.id, name:u.name, email:u.email,
          dials, connectedCalls:conn,
          talkTimeMin: Math.round(talkSec/60),
          appts:ar.length, apptsAttended:att,
          showRate: ar.length ? Math.round((att/ar.length)*100) : 0,
          dialToConnect: dials ? Math.round((conn/dials)*100) : 0,
          offers:    dr.filter(d=>(d.stage||'').toLowerCase().includes('offer')).length,
          verbals:   dr.filter(d=>(d.stage||'').toLowerCase().includes('verbal')).length,
          contracts: dr.filter(d=>{ const s=(d.stage||'').toLowerCase(); return s.includes('contract')||s.includes('sign')||s.includes('pending'); }).length,
        });

        // Small pause between agents
        await sleep(500);
      } catch (e) {
        console.error(`[KPI/all] error for ${u.name}:`, e.message);
        results.push({ userId:u.id, name:u.name, error:e.message });
      }
    }

    const result = { ok:true, agents:results };
    cacheSet('kpi_all_agents', result);
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message });
  }
});

// Cache status / manual clear
app.get('/api/cache', (req, res) => {
  res.json({ entries: [...cache.keys()], ttlMs: CACHE_TTL });
});
app.delete('/api/cache', (req, res) => {
  cache.clear();
  res.json({ ok:true, message:'Cache cleared' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 FUB KPI Dashboard at http://localhost:${PORT}`);
  console.log(`   API key: ${!!process.env.FUB_API_KEY}`);
  console.log(`\n   Debug:  /api/debug/calls`);
  console.log(`           /api/debug/appointments`);
  console.log(`           /api/cache  (view/clear cache)\n`);
});
