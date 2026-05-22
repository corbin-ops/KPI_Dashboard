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
  const res = await fetch(FUB_BASE + path, {
    headers: { Authorization: getFubAuth(), Accept: 'application/json' },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errorMessage || data.message || res.statusText);
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

// Probe endpoint
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

// KPI data for dashboard — Jan 2026 to present, per user, by week
app.get('/api/kpi', async (req, res) => {
  const { userId, start, end } = req.query;
  const startDate = start || '2026-01-01';
  const endDate = end || new Date().toISOString().split('T')[0];

  try {
    const userFilter = userId ? `&userId=${userId}` : '';
    const dateFilter = `&created[gte]=${startDate}&created[lte]=${endDate}`;

    const [callsData, apptData, dealsData, textsData] = await Promise.all([
      fubFetch(`/calls?limit=500${userFilter}${dateFilter}`),
      fubFetch(`/appointments?limit=500${userFilter.replace('userId','assignedTo')}&start[gte]=${startDate}&start[lte]=${endDate}`),
      fubFetch(`/deals?limit=500${userFilter.replace('userId','assignedTo')}${dateFilter}`),
      fubFetch(`/texts?limit=500${userFilter}${dateFilter}`).catch(() => ({ texts: [] })),
    ]);

    const calls = callsData.calls || callsData._embedded?.calls || [];
    const appts = apptData.appointments || apptData._embedded?.appointments || [];
    const deals = dealsData.deals || dealsData._embedded?.deals || [];
    const texts = textsData.texts || textsData._embedded?.texts || [];

    // Aggregate by week
    function getWeek(dateStr) {
      const d = new Date(dateStr);
      const jan1 = new Date(d.getFullYear(), 0, 1);
      const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      return `${d.getFullYear()}-W${String(week).padStart(2,'0')}`;
    }

    function getMonth(dateStr) {
      const d = new Date(dateStr);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    }

    const weeklyMap = {};
    const monthlyMap = {};

    function ensure(map, key) {
      if (!map[key]) map[key] = { dials:0, connectedCalls:0, talkTimeSec:0, appts:0, apptsAttended:0, offers:0, verbals:0, contracts:0, textsSent:0, textsReceived:0 };
      return map[key];
    }

    calls.forEach(c => {
      const d = c.createdAt || c.updatedAt;
      if (!d) return;
      const w = getWeek(d), m = getMonth(d);
      const isOutbound = c.type === 'outbound' || c.direction === 'outbound' || !c.direction;
      if (isOutbound) { ensure(weeklyMap,w).dials++; ensure(monthlyMap,m).dials++; }
      if (c.duration > 0) { ensure(weeklyMap,w).connectedCalls++; ensure(monthlyMap,m).connectedCalls++; }
      ensure(weeklyMap,w).talkTimeSec += (c.duration||0);
      ensure(monthlyMap,m).talkTimeSec += (c.duration||0);
    });

    appts.forEach(a => {
      const d = a.start || a.createdAt;
      if (!d) return;
      const w = getWeek(d), m = getMonth(d);
      ensure(weeklyMap,w).appts++;
      ensure(monthlyMap,m).appts++;
      if (a.outcome === 'attended' || a.attended) {
        ensure(weeklyMap,w).apptsAttended++;
        ensure(monthlyMap,m).apptsAttended++;
      }
    });

    deals.forEach(deal => {
      const d = deal.createdAt || deal.updatedAt;
      if (!d) return;
      const w = getWeek(d), m = getMonth(d);
      const stage = (deal.stage||'').toLowerCase();
      if (stage.includes('offer')) { ensure(weeklyMap,w).offers++; ensure(monthlyMap,m).offers++; }
      if (stage.includes('verbal')) { ensure(weeklyMap,w).verbals++; ensure(monthlyMap,m).verbals++; }
      if (stage.includes('contract') || stage.includes('sign')) { ensure(weeklyMap,w).contracts++; ensure(monthlyMap,m).contracts++; }
    });

    texts.forEach(t => {
      const d = t.createdAt;
      if (!d) return;
      const w = getWeek(d), m = getMonth(d);
      if (t.direction === 'outbound') { ensure(weeklyMap,w).textsSent++; ensure(monthlyMap,m).textsSent++; }
      else { ensure(weeklyMap,w).textsReceived++; ensure(monthlyMap,m).textsReceived++; }
    });

    // Computed metrics
    function enrich(map) {
      return Object.entries(map).sort(([a],[b])=>a.localeCompare(b)).map(([period, m]) => ({
        period,
        dials: m.dials,
        connectedCalls: m.connectedCalls,
        talkTimeMin: Math.round(m.talkTimeSec/60),
        appts: m.appts,
        apptsAttended: m.apptsAttended,
        showRate: m.appts ? Math.round((m.apptsAttended/m.appts)*100) : 0,
        dialToConnect: m.dials ? Math.round((m.connectedCalls/m.dials)*100) : 0,
        connectToAppt: m.connectedCalls ? Math.round((m.appts/m.connectedCalls)*100) : 0,
        offers: m.offers,
        verbals: m.verbals,
        contracts: m.contracts,
        textsSent: m.textsSent,
        textsReceived: m.textsReceived,
        responseRate: m.textsSent ? Math.round((m.textsReceived/m.textsSent)*100) : 0,
      }));
    }

    res.json({
      ok: true,
      weekly: enrich(weeklyMap),
      monthly: enrich(monthlyMap),
      totals: {
        calls: calls.length,
        appts: appts.length,
        deals: deals.length,
        texts: texts.length,
      }
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// All agents KPI summary (for homepage leaderboard)
app.get('/api/kpi/all', async (req, res) => {
  try {
    const usersData = await fubFetch('/users');
    const users = usersData.users || [];
    const startDate = '2026-01-01';
    const endDate = new Date().toISOString().split('T')[0];

    const results = await Promise.all(users.map(async u => {
      try {
        const [callsData, apptData, dealsData] = await Promise.all([
          fubFetch(`/calls?limit=500&userId=${u.id}&created[gte]=${startDate}&created[lte]=${endDate}`),
          fubFetch(`/appointments?limit=500&assignedTo=${u.id}&start[gte]=${startDate}&start[lte]=${endDate}`),
          fubFetch(`/deals?limit=500&assignedTo=${u.id}&created[gte]=${startDate}&created[lte]=${endDate}`),
        ]);
        const calls = callsData.calls || [];
        const appts = apptData.appointments || [];
        const deals = dealsData.deals || [];
        const attended = appts.filter(a => a.outcome==='attended'||a.attended).length;
        const dials = calls.filter(c => c.type==='outbound'||c.direction==='outbound'||!c.direction).length;
        const connected = calls.filter(c => c.duration>0).length;
        const talkSec = calls.reduce((s,c)=>s+(c.duration||0),0);
        return {
          userId: u.id, name: u.name, email: u.email,
          dials, connectedCalls: connected,
          talkTimeMin: Math.round(talkSec/60),
          appts: appts.length, apptsAttended: attended,
          showRate: appts.length ? Math.round((attended/appts.length)*100) : 0,
          dialToConnect: dials ? Math.round((connected/dials)*100) : 0,
          offers: deals.filter(d=>(d.stage||'').toLowerCase().includes('offer')).length,
          verbals: deals.filter(d=>(d.stage||'').toLowerCase().includes('verbal')).length,
          contracts: deals.filter(d=>(d.stage||'').toLowerCase().includes('contract')||((d.stage||'').toLowerCase().includes('sign'))).length,
        };
      } catch { return { userId: u.id, name: u.name, error: true }; }
    }));

    res.json({ ok: true, agents: results });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`\n🚀 FUB KPI Dashboard running at http://localhost:${PORT}`);
  console.log(`   API key configured: ${!!process.env.FUB_API_KEY}\n`);
});
