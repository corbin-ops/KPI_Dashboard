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

let lastRequestTime = 0;
async function fubFetch(pathOrUrl) {
  const { default: fetch } = await import('node-fetch');
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : FUB_BASE + pathOrUrl;
  const gap = Date.now() - lastRequestTime;
  if (gap < 350) await sleep(350 - gap);
  lastRequestTime = Date.now();
  console.log('[FUB]', url.replace(FUB_BASE,'').slice(0,100));
  const res = await fetch(url, { headers: { Authorization: getFubAuth(), Accept: 'application/json' } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessage || data.message || `HTTP ${res.status}`);
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const LIST_KEYS = { calls:'calls', appointments:'appointments', deals:'deals', texts:'textMessages' };

async function fetchAllCursor(endpoint, extraParams = '') {
  let all = [];
  let url = `${FUB_BASE}/${endpoint}?limit=100${extraParams}&sort=id&direction=asc`;
  let page = 0;
  while (url && page < 30) {
    let data;
    try { data = await fubFetch(url); }
    catch(e) {
      if (e.message.includes('rate limit')) { await sleep(6000); data = await fubFetch(url); }
      else throw e;
    }
    const listKey = LIST_KEYS[endpoint] || Object.keys(data).find(k => Array.isArray(data[k]));
    const batch = listKey ? (data[listKey]||[]) : [];
    all = all.concat(batch);
    const next = data._metadata?.nextLink || data.metadata?.nextLink || data.nextLink;
    if (!next || batch.length === 0) break;
    url = next; page++;
  }
  console.log(`[FUB] ${endpoint}${extraParams.slice(0,20)} → ${all.length} records`);
  return all;
}

// Cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { cache.set(key, { data, ts: Date.now() }); }

// Date range — Jan 2026 to present
// NOTE: We log the first call's date fields so we can see exactly what FUB sends
const START = new Date('2026-01-01T00:00:00Z');
function inRange(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !isNaN(d) && d >= START;
}

// Extract best date from a call record — try ALL known FUB date field names
function getCallDate(c) {
  // FUB actual field is 'created', not 'createdAt'
  return c.created || c.createdAt || c.startedAt || c.completedAt || c.updatedAt || null;
}
function getApptDate(a) {
  return a.start || a.startDate || a.created || a.createdAt || null;
}
function getDealDate(d) {
  // FUB actual field is 'created', not 'createdAt'
  return d.created || d.createdAt || d.enteredStageAt || d.updatedAt || null;
}

function getWeekKey(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() + 4 - day);
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2,'0')}`;
}
function getMonthKey(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function ensure(map, key) {
  if (!map[key]) map[key] = { dials:0, connectedCalls:0, talkTimeSec:0, appts:0, apptsAttended:0, offers:0, verbals:0, contracts:0 };
  return map[key];
}
function enrichPeriods(map) {
  return Object.entries(map).sort(([a],[b])=>a.localeCompare(b)).map(([period,m])=>({
    period,
    dials: m.dials, connectedCalls: m.connectedCalls,
    talkTimeMin: Math.round(m.talkTimeSec/60),
    appts: m.appts, apptsAttended: m.apptsAttended,
    showRate: m.appts ? Math.round((m.apptsAttended/m.appts)*100) : 0,
    dialToConnect: m.dials ? Math.round((m.connectedCalls/m.dials)*100) : 0,
    offers: m.offers, verbals: m.verbals, contracts: m.contracts,
  }));
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ ok:!!process.env.FUB_API_KEY, keySet:!!process.env.FUB_API_KEY }));

app.get('/api/users', async (req, res) => {
  try {
    const cached = cacheGet('users');
    if (cached) return res.json(cached);
    const data = await fubFetch('/users');
    const result = { ok:true, users: data.users||[] };
    cacheSet('users', result);
    res.json(result);
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

// Full field inspector — shows ALL fields and sample values for first 3 records
app.get('/api/debug/:endpoint', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const path = `/${req.params.endpoint}?limit=3${qs?'&'+qs:''}`;
    const data = await fubFetch(path);
    const keys = Object.keys(data);
    const listKey = keys.find(k => Array.isArray(data[k]));
    const list = listKey ? data[listKey] : [];
    res.json({ ok:true, path, topLevelKeys:keys, listKey, count:list.length,
      metadata: data._metadata||null, records: list });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.get('/api/probe/:endpoint', async (req, res) => {
  const ep = req.params.endpoint;
  const ALLOWED = ['people','calls','appointments','deals','tasks','texts','notes','events','smartLists','stages'];
  if (!ALLOWED.includes(ep)) return res.status(400).json({ ok:false, error:'Unknown' });
  try {
    const data = await fubFetch(`/${ep}?limit=1`);
    const keys = Object.keys(data);
    const listKey = keys.find(k => Array.isArray(data[k]));
    const sample = listKey && data[listKey][0] ? Object.keys(data[listKey][0]) : [];
    res.json({ ok:true, topLevelKeys:keys, sampleFields:sample });
  } catch(e) { res.status(200).json({ ok:false, error:e.message }); }
});

// KPI for team or one agent
app.get('/api/kpi', async (req, res) => {
  const { userId } = req.query;
  const cacheKey = `kpi_${userId||'all'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const userParam = userId ? `&userId=${userId}` : '';
    const calls = await fetchAllCursor('calls', userParam);
    const appts = await fetchAllCursor('appointments', userParam);
    const deals = await fetchAllCursor('deals', userParam);

    // Log first records so we can inspect field names in Render logs
    if (calls.length > 0) console.log('[FIELDS] call[0]:', JSON.stringify(calls[0]));
    if (appts.length > 0) console.log('[FIELDS] appt[0]:', JSON.stringify(appts[0]));
    if (deals.length > 0) console.log('[FIELDS] deal[0]:', JSON.stringify(deals[0]));

    const wMap = {}, mMap = {};
    let ci=0, ai=0, di=0;

    calls.forEach(c => {
      const dateStr = getCallDate(c);
      if (!inRange(dateStr)) return;
      ci++;
      const w = getWeekKey(dateStr), mo = getMonthKey(dateStr);
      // FUB uses isIncoming boolean — outbound = isIncoming false
      const isOut = c.isIncoming === false || c.isIncoming === 0;
      const isIn  = c.isIncoming === true  || c.isIncoming === 1;
      // Count outbound as dials; if field missing count all
      if (isOut || c.isIncoming === undefined) {
        ensure(wMap,w).dials++; ensure(mMap,mo).dials++;
      }
      const dur = Number(c.duration)||Number(c.durationSeconds)||Number(c.length)||0;
      if (dur > 0) { ensure(wMap,w).connectedCalls++; ensure(mMap,mo).connectedCalls++; }
      ensure(wMap,w).talkTimeSec += dur;
      ensure(mMap,mo).talkTimeSec += dur;
    });

    appts.forEach(a => {
      const dateStr = getApptDate(a);
      if (!inRange(dateStr)) return;
      ai++;
      const w = getWeekKey(dateStr), mo = getMonthKey(dateStr);
      ensure(wMap,w).appts++; ensure(mMap,mo).appts++;
      if ((a.outcome||'').toLowerCase()==='attended'||a.attended===true||a.isAttended===true) {
        ensure(wMap,w).apptsAttended++; ensure(mMap,mo).apptsAttended++;
      }
    });

    deals.forEach(d => {
      const dateStr = getDealDate(d);
      if (!inRange(dateStr)) return;
      di++;
      const w = getWeekKey(dateStr), mo = getMonthKey(dateStr);
      // FUB actual field is 'stageName'
      const stage = (d.stageName||d.stage||d.pipelineStage||'').toString().toLowerCase();
      if (stage.includes('offer'))  { ensure(wMap,w).offers++;   ensure(mMap,mo).offers++; }
      if (stage.includes('verbal')) { ensure(wMap,w).verbals++;  ensure(mMap,mo).verbals++; }
      if (stage.includes('contract')||stage.includes('sign')||stage.includes('pending')||stage.includes('pa')) {
        ensure(wMap,w).contracts++; ensure(mMap,mo).contracts++;
      }
    });

    console.log(`[KPI] inRange → calls:${ci}/${calls.length} appts:${ai}/${appts.length} deals:${di}/${deals.length}`);

    const result = {
      ok:true,
      weekly: enrichPeriods(wMap),
      monthly: enrichPeriods(mMap),
      debug: {
        totalCalls:calls.length, callsInRange:ci,
        totalAppts:appts.length, apptsInRange:ai,
        totalDeals:deals.length, dealsInRange:di,
        callFields: calls[0] ? Object.keys(calls[0]) : [],
        apptFields: appts[0] ? Object.keys(appts[0]) : [],
        dealFields: deals[0] ? Object.keys(deals[0]) : [],
        callSample: calls[0]||null,
        apptSample: appts[0]||null,
        dealSample: deals[0]||null,
      },
    };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch(e) {
    console.error('/api/kpi error:', e.message);
    res.status(400).json({ ok:false, error:e.message });
  }
});

// All agents leaderboard — sequential to avoid rate limits
app.get('/api/kpi/all', async (req, res) => {
  const cached = cacheGet('kpi_all_agents');
  if (cached) return res.json(cached);

  try {
    const { users=[] } = await fubFetch('/users');
    const results = [];

    for (const u of users) {
      try {
        console.log(`[KPI/all] → ${u.name}`);
        const calls = await fetchAllCursor('calls', `&userId=${u.id}`);
        const appts = await fetchAllCursor('appointments', `&userId=${u.id}`);
        const deals = await fetchAllCursor('deals', `&userId=${u.id}`);

        const cr = calls.filter(c => inRange(getCallDate(c)));
        const ar = appts.filter(a => inRange(getApptDate(a)));
        const dr = deals.filter(d => inRange(getDealDate(d)));
        console.log(`[${u.name}] inRange → calls:${cr.length}/${calls.length} appts:${ar.length}/${appts.length} deals:${dr.length}/${deals.length}`);

        const dials = cr.filter(c => c.isIncoming === false || c.isIncoming === 0 || c.isIncoming === undefined).length;
        const conn = cr.filter(c => (Number(c.duration)||0)>0).length;
        const talkSec = cr.reduce((s,c)=>s+(Number(c.duration)||0),0);
        const att = ar.filter(a=>(a.outcome||'').toLowerCase()==='attended'||a.attended===true).length;

        results.push({
          userId:u.id, name:u.name, email:u.email,
          dials, connectedCalls:conn,
          talkTimeMin: Math.round(talkSec/60),
          appts:ar.length, apptsAttended:att,
          showRate: ar.length ? Math.round((att/ar.length)*100):0,
          dialToConnect: dials ? Math.round((conn/dials)*100):0,
          offers:    dr.filter(d=>(d.stageName||d.stage||'').toLowerCase().includes('offer')).length,
          verbals:   dr.filter(d=>(d.stageName||d.stage||'').toLowerCase().includes('verbal')).length,
          contracts: dr.filter(d=>{ const s=(d.stageName||d.stage||'').toLowerCase(); return s.includes('contract')||s.includes('sign')||s.includes('pending')||s.includes('pa')||s.includes('win'); }).length,
        });
        await sleep(300);
      } catch(e) {
        console.error(`error for ${u.name}:`, e.message);
        results.push({ userId:u.id, name:u.name, error:e.message });
      }
    }

    const result = { ok:true, agents:results };
    cacheSet('kpi_all_agents', result);
    res.json(result);
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

app.get('/api/cache', (req,res) => res.json({ entries:[...cache.keys()], ttlMs:CACHE_TTL }));
app.delete('/api/cache', (req,res) => { cache.clear(); res.json({ ok:true }); });

app.listen(PORT, () => {
  console.log(`\n🚀 FUB KPI Dashboard at http://localhost:${PORT}`);
  console.log(`   API key: ${!!process.env.FUB_API_KEY}`);
  console.log(`\n   FIELD INSPECTOR (open in browser after deploy):`);
  console.log(`   /api/debug/calls        — see exact call field names + values`);
  console.log(`   /api/debug/deals        — see exact deal field names + values`);
  console.log(`   /api/debug/appointments — see exact appt field names\n`);
});
