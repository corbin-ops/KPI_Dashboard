import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const FUB_BASE = 'https://api.followupboss.com/v1';
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
    ...(process.env.FUB_SYSTEM_KEY ? { 'X-System-Key': process.env.FUB_SYSTEM_KEY } : {}),
  };
}

let lastReqMs = 0;
async function fubFetch(pathOrUrl) {
  const { default: fetch } = await import('node-fetch');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : FUB_BASE + pathOrUrl;
  const gap = Date.now() - lastReqMs;
  if (gap < 300) await sleep(300 - gap);
  lastReqMs = Date.now();
  console.log('[FUB]', url.replace(FUB_BASE, '').slice(0, 100));
  const res = await fetch(url, { headers: getHeaders() });
  if (res.status === 429) {
    const wait = parseInt(res.headers.get('Retry-After') || '10', 10) * 1000 + 500;
    console.log(`[429] waiting ${wait}ms`);
    await sleep(wait);
    return fubFetch(pathOrUrl);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessage || data.message || `HTTP ${res.status}`);
  return data;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Paginate via nextLink — the only reliable FUB pagination method
async function paginate(endpoint, params = '') {
  const listKeys = { calls:'calls', appointments:'appointments', deals:'deals', textMessages:'textMessages' };
  let all = [];
  let url = `${FUB_BASE}/${endpoint}?limit=100&createdAfter=${START_ISO}${params}`;
  let page = 0;
  while (url && page < 60) {
    const data = await fubFetch(url);
    const key = listKeys[endpoint] || Object.keys(data).find(k => Array.isArray(data[k]));
    const batch = key ? (data[key] || []) : [];
    all = all.concat(batch);
    const next = data._metadata?.nextLink;
    if (!next || batch.length === 0) break;
    url = next;
    page++;
  }
  console.log(`  [${endpoint}] fetched ${all.length} records`);
  return all;
}

// Appointments: filter by start date in JS since start != created
async function paginateAppts(params = '') {
  let all = [], url = `${FUB_BASE}/appointments?limit=100${params}`, page = 0;
  while (url && page < 60) {
    const data = await fubFetch(url);
    const batch = data.appointments || [];
    all = all.concat(batch);
    const next = data._metadata?.nextLink;
    if (!next || batch.length === 0) break;
    url = next; page++;
  }
  const filtered = all.filter(a => {
    const d = new Date(a.start || a.created);
    return !isNaN(d) && d >= START_DATE;
  });
  console.log(`  [appointments] fetched ${all.length}, in range: ${filtered.length}`);
  return filtered;
}

// Cache
const cache = new Map();
const TTL = 10 * 60 * 1000;
const cacheGet = k => { const e = cache.get(k); if (!e || Date.now()-e.ts > TTL) { cache.delete(k); return null; } return e.data; };
const cacheSet = (k, v) => cache.set(k, { data:v, ts:Date.now() });

// Date/period helpers
const inRange = ds => { if (!ds) return false; const d = new Date(ds); return !isNaN(d) && d >= START_DATE; };
function weekKey(ds) {
  const d = new Date(ds), day = d.getDay()||7;
  d.setDate(d.getDate()+4-day);
  const jan1 = new Date(d.getFullYear(),0,1);
  return `${d.getFullYear()}-W${String(Math.ceil(((d-jan1)/86400000+1)/7)).padStart(2,'0')}`;
}
function monthKey(ds) { const d = new Date(ds); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function bucket(map, k) {
  if (!map[k]) map[k] = { dials:0, connected:0, talkSec:0, appts:0, apptsAttended:0, offers:0, verbals:0, contracts:0 };
  return map[k];
}
function toSeries(map) {
  return Object.entries(map).sort(([a],[b])=>a.localeCompare(b)).map(([period, m]) => ({
    period,
    dials:          m.dials,
    connectedCalls: m.connected,
    talkTimeSec:    m.talkSec,
    talkTimeHrs:    Math.round(m.talkSec / 3600 * 10) / 10,
    appts:          m.appts,
    apptsAttended:  m.apptsAttended,
    showRate:       m.appts    ? Math.round(m.apptsAttended / m.appts    * 100) : 0,
    dialToConnect:  m.dials    ? Math.round(m.connected     / m.dials    * 100) : 0,
    offers:         m.offers,
    verbals:        m.verbals,
    contracts:      m.contracts,
  }));
}

// Account metadata (outcome IDs, stage IDs) — loaded at boot
let outcomeNames = {};  // id → name
let stageNames   = {};  // id → name

async function loadMeta() {
  try {
    const ao = await fubFetch('/appointmentOutcomes?limit=100');
    (ao.appointmentOutcomes || []).forEach(o => { outcomeNames[o.id] = o.name; });
    console.log('[META] outcomes:', Object.entries(outcomeNames).map(([id,n])=>`${id}:${n}`).join(', '));
  } catch(e) { console.log('[META] outcomes error:', e.message); }
  try {
    const st = await fubFetch('/stages?limit=100');
    (st.stages || []).forEach(s => { stageNames[s.id] = s.name; });
    console.log('[META] stages:', Object.entries(stageNames).map(([id,n])=>`${id}:${n}`).join(', '));
  } catch(e) { console.log('[META] stages error:', e.message); }
}

function isAttended(a) {
  // Check by outcomeId first (most reliable)
  if (a.outcomeId && outcomeNames[a.outcomeId]) {
    const n = outcomeNames[a.outcomeId].toLowerCase();
    return n.includes('attend') || n.includes('met') || n.includes('show') || n.includes('complet');
  }
  // Fallback to outcome string
  const o = (a.outcome || '').toLowerCase().trim();
  return o === 'attended' || o === 'met' || o === 'showed' || o === 'completed';
}

function dealBucket(d) {
  // Check stageId first
  const sname = (d.stageId && stageNames[d.stageId]
    ? stageNames[d.stageId]
    : (d.stageName || d.stage || '')).toLowerCase();
  if (sname.includes('offer') || sname.includes('loi'))                          return 'offers';
  if (sname.includes('verbal') || sname.includes('accept'))                      return 'verbals';
  if (sname.includes('contract') || sname.includes('sign') || sname.includes('pending') ||
      sname.includes('win') || sname.includes('clos') || sname.includes('execut') ||
      sname.includes('under') || sname.includes(' pa'))                           return 'contracts';
  return null;
}

// ── Core aggregation ──────────────────────────────────────────────────────────
// KEY INSIGHT: FUB's call report counts ALL calls in the account regardless of
// which inbox. We match this by fetching WITHOUT userId filter for team totals,
// and WITH userId for per-agent breakdowns. isIncoming=false = outbound = "Calls Made".
function aggregateCalls(calls, wMap, mMap) {
  let n = 0;
  for (const c of calls) {
    const ds = c.created;
    if (!inRange(ds)) continue;
    n++;
    const w = weekKey(ds), mo = monthKey(ds);
    const dur = Number(c.duration) || 0;
    if (c.isIncoming === false) {
      // Outbound = "Calls Made" in FUB report
      bucket(wMap, w).dials++;   bucket(mMap, mo).dials++;
      if (dur > 0) { bucket(wMap, w).connected++; bucket(mMap, mo).connected++; }
    }
    // Talk time = all calls with duration
    bucket(wMap, w).talkSec += dur;
    bucket(mMap, mo).talkSec += dur;
  }
  return n;
}

function aggregateAppts(appts, wMap, mMap) {
  for (const a of appts) {
    const ds = a.start || a.created;
    const w = weekKey(ds), mo = monthKey(ds);
    bucket(wMap, w).appts++;   bucket(mMap, mo).appts++;
    if (isAttended(a)) { bucket(wMap, w).apptsAttended++; bucket(mMap, mo).apptsAttended++; }
  }
}

function aggregateDeals(deals, wMap, mMap) {
  let n = 0;
  for (const d of deals) {
    const ds = d.created;
    if (!inRange(ds)) continue;
    n++;
    const w = weekKey(ds), mo = monthKey(ds);
    const b = dealBucket(d);
    if (b) { bucket(wMap, w)[b]++; bucket(mMap, mo)[b]++; }
  }
  return n;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req,res) => res.json({ ok:!!process.env.FUB_API_KEY, keySet:!!process.env.FUB_API_KEY }));

app.get('/api/users', async (req,res) => {
  try {
    const c = cacheGet('users'); if (c) return res.json(c);
    const data = await fubFetch('/users');
    const result = { ok:true, users:data.users||[] };
    cacheSet('users', result); res.json(result);
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

app.get('/api/debug/:endpoint', async (req,res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const data = await fubFetch(`/${req.params.endpoint}?limit=3${qs?'&'+qs:''}`);
    const keys = Object.keys(data);
    const listKey = keys.find(k => Array.isArray(data[k]));
    res.json({ ok:true, topLevelKeys:keys, listKey,
      metadata: data._metadata||null,
      records: listKey ? data[listKey].slice(0,3) : [],
      accountMeta: { outcomeNames, stageNames } });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.get('/api/probe/:endpoint', async (req,res) => {
  const ALLOWED = ['people','calls','appointments','deals','textMessages','notes','events','smartLists','stages','appointmentOutcomes','pipelines'];
  if (!ALLOWED.includes(req.params.endpoint)) return res.status(400).json({ ok:false, error:'Unknown' });
  try {
    const data = await fubFetch(`/${req.params.endpoint}?limit=1`);
    const keys = Object.keys(data);
    const listKey = keys.find(k => Array.isArray(data[k]));
    res.json({ ok:true, topLevelKeys:keys, sampleFields: listKey && data[listKey][0] ? Object.keys(data[listKey][0]) : [] });
  } catch(e) { res.status(200).json({ ok:false, error:e.message }); }
});

app.get('/api/meta', (req,res) => res.json({ outcomeNames, stageNames }));

// ── KPI endpoint ──────────────────────────────────────────────────────────────
// Team view: no userId filter → matches FUB's own report totals exactly
// Per-user:  userId filter   → per-agent breakdown
app.get('/api/kpi', async (req,res) => {
  const { userId } = req.query;
  const cKey = userId ? `kpi_u_${userId}` : 'kpi_team';
  const cached = cacheGet(cKey);
  if (cached) return res.json(cached);

  try {
    const userParam = userId ? `&userId=${userId}` : '';
    const wMap = {}, mMap = {};

    // Fetch sequentially — parallel hits rate limit
    const calls = await paginate('calls', userParam);
    const appts = await paginateAppts(userParam);
    const deals = await paginate('deals', userParam);

    const ci = aggregateCalls(calls, wMap, mMap);
    aggregateAppts(appts, wMap, mMap);
    const di = aggregateDeals(deals, wMap, mMap);

    console.log(`[KPI ${userId||'team'}] outbound calls: ${ci}, appts: ${appts.length}, deals in range: ${di}`);
    // Log a sample call to verify isIncoming field
    const sample = calls.find(c => c.isIncoming === false) || calls[0];
    if (sample) console.log('[SAMPLE call]', JSON.stringify({ id:sample.id, isIncoming:sample.isIncoming, duration:sample.duration, created:sample.created }));

    const result = { ok:true, weekly:toSeries(wMap), monthly:toSeries(mMap),
      debug:{ totalCalls:calls.length, inRangeCalls:ci, totalAppts:appts.length, totalDeals:deals.length, dealsInRange:di }};
    cacheSet(cKey, result);
    res.json(result);
  } catch(e) {
    console.error('[KPI error]', e.message);
    res.status(400).json({ ok:false, error:e.message });
  }
});

// Leaderboard — per user, sequential
app.get('/api/kpi/all', async (req,res) => {
  const cached = cacheGet('kpi_all');
  if (cached) return res.json(cached);
  try {
    const { users=[] } = await fubFetch('/users');
    const agents = [];
    for (const u of users) {
      const cKey = `kpi_u_${u.id}`;
      let r = cacheGet(cKey);
      if (!r) {
        console.log(`[KPI/all] → ${u.name}`);
        const wMap = {}, mMap = {};
        const calls = await paginate('calls', `&userId=${u.id}`);
        const appts = await paginateAppts(`&userId=${u.id}`);
        const deals = await paginate('deals', `&userId=${u.id}`);
        aggregateCalls(calls, wMap, mMap);
        aggregateAppts(appts, wMap, mMap);
        aggregateDeals(deals, wMap, mMap);
        r = { ok:true, weekly:toSeries(wMap), monthly:toSeries(mMap) };
        cacheSet(cKey, r);
        await sleep(150);
      }
      const w = r.weekly || [];
      const sum = f => w.reduce((s,p) => s+(p[f]||0), 0);
      const dials = sum('dials'), conn = sum('connectedCalls'), talkSec = sum('talkTimeSec');
      const appts = sum('appts'), att = sum('apptsAttended');
      agents.push({
        userId:u.id, name:u.name, email:u.email,
        dials, connectedCalls:conn,
        talkTimeHrs: Math.round(talkSec/3600*10)/10,
        appts, apptsAttended:att,
        showRate:      appts ? Math.round(att/appts*100)  : 0,
        dialToConnect: dials ? Math.round(conn/dials*100) : 0,
        offers:    sum('offers'),
        verbals:   sum('verbals'),
        contracts: sum('contracts'),
      });
    }
    const result = { ok:true, agents };
    cacheSet('kpi_all', result);
    res.json(result);
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

app.get('/api/cache', (req,res) => res.json({ entries:[...cache.keys()], ttlMs:TTL }));
app.delete('/api/cache', (req,res) => { cache.clear(); res.json({ ok:true }); });

cache.clear();
app.listen(PORT, async () => {
  console.log(`\n🚀  http://localhost:${PORT}`);
  console.log(`    API key: ${!!process.env.FUB_API_KEY}`);
  console.log(`    Date range: ${START_ISO} → now\n`);
  await loadMeta();
});
