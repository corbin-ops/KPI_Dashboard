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

async function fubFetch(path) {
  const { default: fetch } = await import('node-fetch');
  const url = FUB_BASE + path;
  console.log('[FUB]', url);
  const res = await fetch(url, {
    headers: { Authorization: getFubAuth(), Accept: 'application/json' },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessage || data.message || `HTTP ${res.status}`);
  return data;
}

// Health
app.get('/api/health', (req, res) => {
  const keySet = !!process.env.FUB_API_KEY;
  res.json({ ok: keySet, keySet });
});

// Users
app.get('/api/users', async (req, res) => {
  try {
    const data = await fubFetch('/users');
    res.json({ ok: true, users: data.users || [] });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Debug — inspect raw FUB response for any endpoint + params
app.get('/api/debug/:endpoint', async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const path = `/${req.params.endpoint}${qs ? '?' + qs : ''}`;
    const data = await fubFetch(path);
    const keys = Object.keys(data);
    const listKey = keys.find(k => Array.isArray(data[k]));
    const list = listKey ? data[listKey] : [];
    res.json({
      ok: true,
      path,
      topLevelKeys: keys,
      listKey,
      count: list.length,
      // Show all field names + sample values from first record
      firstRecord: list[0] || null,
      firstRecordKeys: list[0] ? Object.keys(list[0]) : [],
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Probe endpoint (for metric explorer)
app.get('/api/probe/:endpoint', async (req, res) => {
  const ep = req.params.endpoint;
  const ALLOWED = ['people','calls','appointments','deals','tasks','texts','notes','events','smartLists','stages','pipelines','customFields'];
  if (!ALLOWED.includes(ep)) return res.status(400).json({ ok: false, error: 'Unknown endpoint' });
  try {
    const data = await fubFetch(`/${ep}?limit=1`);
    const keys = Object.keys(data);
    const listKey = keys.find(k => Array.isArray(data[k]));
    const sample = listKey && data[listKey][0] ? Object.keys(data[listKey][0]) : [];
    res.json({ ok: true, topLevelKeys: keys, sampleFields: sample });
  } catch (e) { res.status(200).json({ ok: false, error: e.message }); }
});

// ─── Core data fetcher with smart field detection ─────────────────────────────
//
// FUB API filter params vary by endpoint. We try the most common patterns:
//   calls:        ?createdAfter=  ?createdBefore=   &userId=
//   appointments: ?createdAfter=  ?start=           &userId=  (some versions: &assignedUserId=)
//   deals:        ?createdAfter=  &userId=          (some versions: no date filter at all)
//
// We fetch without date filter and filter in JS — most reliable approach.
// FUB free/basic plans cap at 100 records; we paginate via offset.

async function fetchAll(endpoint, extraParams = '') {
  let all = [];
  let offset = 0;
  const limit = 100;
  const listKeys = {
    calls: 'calls', appointments: 'appointments', deals: 'deals',
    texts: 'textMessages', notes: 'notes', events: 'events',
  };

  while (true) {
    const data = await fubFetch(`/${endpoint}?limit=${limit}&offset=${offset}${extraParams}`);
    // Find the array in the response
    const listKey = listKeys[endpoint] || Object.keys(data).find(k => Array.isArray(data[k]));
    const batch = listKey ? (data[listKey] || []) : [];
    all = all.concat(batch);
    if (batch.length < limit) break; // last page
    offset += limit;
    if (offset > 2000) break; // safety cap
  }
  return all;
}

// Filter records to Jan 2026 – present in JS (avoids API date param inconsistencies)
function inRange(dateStr, start = '2026-01-01') {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  return d >= new Date(start) && d <= new Date();
}

function getWeekKey(dateStr) {
  const d = new Date(dateStr);
  // ISO week: Monday-based
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

function ensurePeriod(map, key) {
  if (!map[key]) map[key] = {
    dials:0, connectedCalls:0, talkTimeSec:0,
    appts:0, apptsAttended:0,
    offers:0, verbals:0, contracts:0,
    textsSent:0, textsReceived:0,
  };
  return map[key];
}

function enrichPeriods(map) {
  return Object.entries(map)
    .sort(([a],[b]) => a.localeCompare(b))
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

function aggregateCalls(calls, weeklyMap, monthlyMap) {
  calls.forEach(c => {
    // FUB call date fields: createdAt, updatedAt, completedAt
    const dateStr = c.createdAt || c.completedAt || c.updatedAt;
    if (!inRange(dateStr)) return;
    const w = getWeekKey(dateStr), mo = getMonthKey(dateStr);

    // Direction: FUB uses 'outbound'/'inbound' on type OR direction field
    const isOutbound = (c.type||'').toLowerCase().includes('outbound') ||
                       (c.direction||'').toLowerCase() === 'outbound';
    if (isOutbound) {
      ensurePeriod(weeklyMap, w).dials++;
      ensurePeriod(monthlyMap, mo).dials++;
    }
    // Connected = duration > 0 OR disposition = 'connected'
    const isConnected = (c.duration > 0) || (c.disposition||'').toLowerCase() === 'connected';
    if (isConnected) {
      ensurePeriod(weeklyMap, w).connectedCalls++;
      ensurePeriod(monthlyMap, mo).connectedCalls++;
    }
    ensurePeriod(weeklyMap, w).talkTimeSec += (c.duration || 0);
    ensurePeriod(monthlyMap, mo).talkTimeSec += (c.duration || 0);
  });
}

function aggregateAppts(appts, weeklyMap, monthlyMap) {
  appts.forEach(a => {
    const dateStr = a.start || a.createdAt || a.updatedAt;
    if (!inRange(dateStr)) return;
    const w = getWeekKey(dateStr), mo = getMonthKey(dateStr);
    ensurePeriod(weeklyMap, w).appts++;
    ensurePeriod(monthlyMap, mo).appts++;
    // FUB appointment outcome: 'Attended', 'attended', or attended boolean
    const isAttended = (a.outcome||'').toLowerCase() === 'attended' ||
                       a.attended === true || a.attended === 1;
    if (isAttended) {
      ensurePeriod(weeklyMap, w).apptsAttended++;
      ensurePeriod(monthlyMap, mo).apptsAttended++;
    }
  });
}

function aggregateDeals(deals, weeklyMap, monthlyMap) {
  deals.forEach(d => {
    const dateStr = d.createdAt || d.updatedAt;
    if (!inRange(dateStr)) return;
    const w = getWeekKey(dateStr), mo = getMonthKey(dateStr);
    // FUB stages — match flexibly
    const stage = (d.stage || d.stageId || d.pipelineStage || '').toString().toLowerCase();
    if (stage.includes('offer'))    { ensurePeriod(weeklyMap,w).offers++;    ensurePeriod(monthlyMap,mo).offers++; }
    if (stage.includes('verbal'))   { ensurePeriod(weeklyMap,w).verbals++;   ensurePeriod(monthlyMap,mo).verbals++; }
    if (stage.includes('contract') || stage.includes('sign') || stage.includes('pending')) {
      ensurePeriod(weeklyMap,w).contracts++;
      ensurePeriod(monthlyMap,mo).contracts++;
    }
  });
}

function sumAcrossPeriods(weekly, monthly) {
  const sum = (arr, field) => arr.reduce((s, p) => s + (p[field]||0), 0);
  const w = weekly, m = monthly;
  const dials = sum(w,'dials'), conn = sum(w,'connectedCalls');
  const appts = sum(w,'appts'), att = sum(w,'apptsAttended');
  const talk = sum(w,'talkTimeMin');
  return {
    dials, connectedCalls: conn, talkTimeMin: talk,
    appts, apptsAttended: att,
    showRate: appts ? Math.round((att/appts)*100) : 0,
    dialToConnect: dials ? Math.round((conn/dials)*100) : 0,
    offers: sum(w,'offers'), verbals: sum(w,'verbals'), contracts: sum(w,'contracts'),
  };
}

// KPI for one user or team
app.get('/api/kpi', async (req, res) => {
  const { userId } = req.query;
  try {
    const userParam = userId ? `&userId=${userId}` : '';
    const [calls, appts, deals] = await Promise.all([
      fetchAll('calls', userParam),
      fetchAll('appointments', userParam),
      fetchAll('deals', userParam),
    ]);

    const weeklyMap = {}, monthlyMap = {};
    aggregateCalls(calls, weeklyMap, monthlyMap);
    aggregateAppts(appts, weeklyMap, monthlyMap);
    aggregateDeals(deals, weeklyMap, monthlyMap);

    const weekly  = enrichPeriods(weeklyMap);
    const monthly = enrichPeriods(monthlyMap);

    res.json({
      ok: true, weekly, monthly,
      debug: { totalCalls: calls.length, totalAppts: appts.length, totalDeals: deals.length,
               callSample: calls[0] || null, apptSample: appts[0] || null },
    });
  } catch (e) {
    console.error('/api/kpi error:', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// All agents KPI summary
app.get('/api/kpi/all', async (req, res) => {
  try {
    const usersData = await fubFetch('/users');
    const users = usersData.users || [];

    const results = await Promise.all(users.map(async u => {
      try {
        const [calls, appts, deals] = await Promise.all([
          fetchAll('calls', `&userId=${u.id}`),
          fetchAll('appointments', `&userId=${u.id}`),
          fetchAll('deals', `&userId=${u.id}`),
        ]);

        const callsInRange = calls.filter(c => inRange(c.createdAt || c.completedAt || c.updatedAt));
        const apptsInRange = appts.filter(a => inRange(a.start || a.createdAt || a.updatedAt));
        const dealsInRange = deals.filter(d => inRange(d.createdAt || d.updatedAt));

        const dials     = callsInRange.filter(c =>
          (c.type||'').toLowerCase().includes('outbound') ||
          (c.direction||'').toLowerCase() === 'outbound').length;
        const connected = callsInRange.filter(c => (c.duration||0) > 0 || (c.disposition||'').toLowerCase() === 'connected').length;
        const talkSec   = callsInRange.reduce((s,c) => s + (c.duration||0), 0);
        const attended  = apptsInRange.filter(a =>
          (a.outcome||'').toLowerCase() === 'attended' || a.attended === true).length;

        return {
          userId: u.id, name: u.name, email: u.email,
          dials, connectedCalls: connected,
          talkTimeMin: Math.round(talkSec / 60),
          appts: apptsInRange.length, apptsAttended: attended,
          showRate: apptsInRange.length ? Math.round((attended / apptsInRange.length) * 100) : 0,
          dialToConnect: dials ? Math.round((connected / dials) * 100) : 0,
          offers:    dealsInRange.filter(d => (d.stage||'').toLowerCase().includes('offer')).length,
          verbals:   dealsInRange.filter(d => (d.stage||'').toLowerCase().includes('verbal')).length,
          contracts: dealsInRange.filter(d => {
            const s = (d.stage||'').toLowerCase();
            return s.includes('contract') || s.includes('sign') || s.includes('pending');
          }).length,
          debug: { totalCalls: calls.length, inRange: callsInRange.length },
        };
      } catch(e) {
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
  console.log(`   API key set: ${!!process.env.FUB_API_KEY}`);
  console.log(`\n   Debug endpoints:`);
  console.log(`   /api/debug/calls           — inspect raw call fields`);
  console.log(`   /api/debug/calls?limit=1   — single record`);
  console.log(`   /api/debug/appointments?limit=1`);
  console.log(`   /api/debug/deals?limit=1\n`);
});
