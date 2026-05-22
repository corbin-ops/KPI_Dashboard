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

async function fubFetch(pathOrUrl) {
  const { default: fetch } = await import('node-fetch');
  // Support full URLs (nextLink) or paths
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : FUB_BASE + pathOrUrl;
  console.log('[FUB]', url);
  const res = await fetch(url, {
    headers: { Authorization: getFubAuth(), Accept: 'application/json' },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessage || data.message || `HTTP ${res.status}`);
  return data;
}

// ── Paginate using FUB's nextLink cursor ──────────────────────────────────────
// FUB returns: { calls: [...], "_metadata": { "nextLink": "https://..." } }
// We follow nextLink until it's absent or empty.
async function fetchAllCursor(endpoint, extraParams = '') {
  const LIST_KEYS = {
    calls: 'calls',
    appointments: 'appointments',
    deals: 'deals',
    texts: 'textMessages',
    notes: 'notes',
    events: 'events',
  };

  let all = [];
  // Start with first page — use createdAfter for Jan 2026 scoping (FUB's real param name)
  let url = `${FUB_BASE}/${endpoint}?limit=100${extraParams}&sort=id&direction=asc`;

  const maxPages = 50; // safety cap ~5000 records
  let page = 0;

  while (url && page < maxPages) {
    const data = await fubFetch(url);

    // Find the list in the response
    const listKey = LIST_KEYS[endpoint] || Object.keys(data).find(k => Array.isArray(data[k]));
    const batch = listKey ? (data[listKey] || []) : [];
    all = all.concat(batch);

    console.log(`[FUB] ${endpoint} page ${page + 1}: ${batch.length} records (total so far: ${all.length})`);

    // Follow nextLink if present
    const next = data._metadata?.nextLink || data.metadata?.nextLink || data.nextLink;
    if (!next || batch.length === 0) break;
    url = next;
    page++;
  }

  return all;
}

// ── Date helpers ──────────────────────────────────────────────────────────────
const START_DATE = new Date('2026-01-01T00:00:00Z');

function inRange(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return !isNaN(d) && d >= START_DATE && d <= new Date();
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
  if (!map[key]) map[key] = {
    dials: 0, connectedCalls: 0, talkTimeSec: 0,
    appts: 0, apptsAttended: 0,
    offers: 0, verbals: 0, contracts: 0,
    textsSent: 0, textsReceived: 0,
  };
  return map[key];
}

function enrichPeriods(map) {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, m]) => ({
      period,
      dials: m.dials,
      connectedCalls: m.connectedCalls,
      talkTimeMin: Math.round(m.talkTimeSec / 60),
      appts: m.appts,
      apptsAttended: m.apptsAttended,
      showRate: m.appts ? Math.round((m.apptsAttended / m.appts) * 100) : 0,
      dialToConnect: m.dials ? Math.round((m.connectedCalls / m.dials) * 100) : 0,
      connectToAppt: m.connectedCalls ? Math.round((m.appts / m.connectedCalls) * 100) : 0,
      offers: m.offers,
      verbals: m.verbals,
      contracts: m.contracts,
      textsSent: m.textsSent,
      textsReceived: m.textsReceived,
      responseRate: m.textsSent ? Math.round((m.textsReceived / m.textsSent) * 100) : 0,
    }));
}

// ── Aggregators ───────────────────────────────────────────────────────────────
function digestCall(c, wMap, mMap) {
  // FUB call date: createdAt or completedAt
  const dateStr = c.createdAt || c.completedAt || c.updatedAt;
  if (!inRange(dateStr)) return false;
  const w = getWeekKey(dateStr), mo = getMonthKey(dateStr);

  // Outbound: type field = 'outbound' (FUB) or direction = 'outbound'
  const isOut = (c.type || '').toLowerCase() === 'outbound' ||
                (c.direction || '').toLowerCase() === 'outbound';
  if (isOut) { ensure(wMap, w).dials++; ensure(mMap, mo).dials++; }

  // Connected: duration > 0 seconds
  const dur = Number(c.duration) || 0;
  if (dur > 0) { ensure(wMap, w).connectedCalls++; ensure(mMap, mo).connectedCalls++; }

  ensure(wMap, w).talkTimeSec += dur;
  ensure(mMap, mo).talkTimeSec += dur;
  return true;
}

function digestAppt(a, wMap, mMap) {
  const dateStr = a.start || a.createdAt || a.updatedAt;
  if (!inRange(dateStr)) return false;
  const w = getWeekKey(dateStr), mo = getMonthKey(dateStr);

  ensure(wMap, w).appts++;
  ensure(mMap, mo).appts++;

  // FUB outcome: 'Attended', 'attended', attended=true
  const isAtt = (a.outcome || '').toLowerCase() === 'attended' || a.attended === true;
  if (isAtt) { ensure(wMap, w).apptsAttended++; ensure(mMap, mo).apptsAttended++; }
  return true;
}

function digestDeal(d, wMap, mMap) {
  const dateStr = d.createdAt || d.updatedAt;
  if (!inRange(dateStr)) return false;
  const w = getWeekKey(dateStr), mo = getMonthKey(dateStr);
  const stage = (d.stage || d.stageId || '').toString().toLowerCase();
  if (stage.includes('offer'))   { ensure(wMap, w).offers++;    ensure(mMap, mo).offers++; }
  if (stage.includes('verbal'))  { ensure(wMap, w).verbals++;   ensure(mMap, mo).verbals++; }
  if (stage.includes('contract') || stage.includes('sign') || stage.includes('pending')) {
    ensure(wMap, w).contracts++; ensure(mMap, mo).contracts++;
  }
  return true;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ ok: !!process.env.FUB_API_KEY, keySet: !!process.env.FUB_API_KEY });
});

app.get('/api/users', async (req, res) => {
  try {
    const data = await fubFetch('/users');
    res.json({ ok: true, users: data.users || [] });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Raw field inspector — open in browser to see exactly what FUB returns
app.get('/api/debug/:endpoint', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const path = `/${req.params.endpoint}?limit=5${qs ? '&' + qs : ''}`;
    const data = await fubFetch(path);
    const keys = Object.keys(data);
    const listKey = keys.find(k => Array.isArray(data[k]));
    const list = listKey ? data[listKey] : [];
    res.json({
      ok: true, path, topLevelKeys: keys, listKey,
      count: list.length,
      metadata: data._metadata || data.metadata || null,
      records: list.slice(0, 3),
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/probe/:endpoint', async (req, res) => {
  const ep = req.params.endpoint;
  const ALLOWED = ['people','calls','appointments','deals','tasks','texts','notes','events','smartLists','stages'];
  if (!ALLOWED.includes(ep)) return res.status(400).json({ ok: false, error: 'Unknown endpoint' });
  try {
    const data = await fubFetch(`/${ep}?limit=1`);
    const keys = Object.keys(data);
    const listKey = keys.find(k => Array.isArray(data[k]));
    const sample = listKey && data[listKey][0] ? Object.keys(data[listKey][0]) : [];
    res.json({ ok: true, topLevelKeys: keys, sampleFields: sample });
  } catch (e) { res.status(200).json({ ok: false, error: e.message }); }
});

// Team or per-user KPI with full cursor pagination
app.get('/api/kpi', async (req, res) => {
  const { userId } = req.query;
  try {
    const userParam = userId ? `&userId=${userId}` : '';

    const [calls, appts, deals] = await Promise.all([
      fetchAllCursor('calls', userParam),
      fetchAllCursor('appointments', userParam),
      fetchAllCursor('deals', userParam),
    ]);

    const wMap = {}, mMap = {};
    let callsInRange = 0, apptsInRange = 0, dealsInRange = 0;

    calls.forEach(c  => { if (digestCall(c,  wMap, mMap)) callsInRange++; });
    appts.forEach(a  => { if (digestAppt(a,  wMap, mMap)) apptsInRange++; });
    deals.forEach(d  => { if (digestDeal(d,  wMap, mMap)) dealsInRange++; });

    console.log(`[KPI] userId=${userId||'all'} inRange → calls:${callsInRange} appts:${apptsInRange} deals:${dealsInRange}`);

    res.json({
      ok: true,
      weekly: enrichPeriods(wMap),
      monthly: enrichPeriods(mMap),
      debug: {
        totalCalls: calls.length, callsInRange,
        totalAppts: appts.length, apptsInRange,
        totalDeals: deals.length, dealsInRange,
        callSample: calls[0] || null,
        apptSample: appts[0] || null,
        dealSample: deals[0] || null,
      },
    });
  } catch (e) {
    console.error('/api/kpi error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// All agents leaderboard
app.get('/api/kpi/all', async (req, res) => {
  try {
    const { users = [] } = await fubFetch('/users');

    const results = await Promise.all(users.map(async u => {
      try {
        const [calls, appts, deals] = await Promise.all([
          fetchAllCursor('calls', `&userId=${u.id}`),
          fetchAllCursor('appointments', `&userId=${u.id}`),
          fetchAllCursor('deals', `&userId=${u.id}`),
        ]);

        const cr = calls.filter(c => inRange(c.createdAt || c.completedAt || c.updatedAt));
        const ar = appts.filter(a => inRange(a.start || a.createdAt || a.updatedAt));
        const dr = deals.filter(d => inRange(d.createdAt || d.updatedAt));

        const dials    = cr.filter(c => (c.type||'').toLowerCase()==='outbound'||(c.direction||'').toLowerCase()==='outbound').length;
        const conn     = cr.filter(c => (Number(c.duration)||0) > 0).length;
        const talkSec  = cr.reduce((s, c) => s + (Number(c.duration) || 0), 0);
        const attended = ar.filter(a => (a.outcome||'').toLowerCase()==='attended'||a.attended===true).length;

        return {
          userId: u.id, name: u.name, email: u.email,
          dials, connectedCalls: conn,
          talkTimeMin: Math.round(talkSec / 60),
          appts: ar.length, apptsAttended: attended,
          showRate: ar.length ? Math.round((attended / ar.length) * 100) : 0,
          dialToConnect: dials ? Math.round((conn / dials) * 100) : 0,
          offers:    dr.filter(d => (d.stage||'').toLowerCase().includes('offer')).length,
          verbals:   dr.filter(d => (d.stage||'').toLowerCase().includes('verbal')).length,
          contracts: dr.filter(d => { const s=(d.stage||'').toLowerCase(); return s.includes('contract')||s.includes('sign')||s.includes('pending'); }).length,
          _debug: { fetched: calls.length, inRange: cr.length },
        };
      } catch (e) {
        return { userId: u.id, name: u.name, error: e.message };
      }
    }));

    res.json({ ok: true, agents: results });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 FUB KPI Dashboard at http://localhost:${PORT}`);
  console.log(`   API key: ${!!process.env.FUB_API_KEY}`);
  console.log(`\n   Diagnose at: /api/debug/calls`);
  console.log(`                /api/debug/appointments`);
  console.log(`                /api/debug/deals\n`);
});
