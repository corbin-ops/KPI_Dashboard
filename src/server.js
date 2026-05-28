import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Papa = require('papaparse');

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = join(__dirname, '../data');

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// ── Parse talk time string → decimal hours ────────────────────────────────────
// Handles: "1 day 15 hours", "14 hours 37 minutes", "2 days", "19 hours 56 min"
function parseTalkHours(s) {
  if (!s || s === '' || s === null) return 0;
  const str = String(s).toLowerCase();
  const days  = str.match(/(\d+)\s*day/);
  const hours = str.match(/(\d+)\s*hour/);
  const mins  = str.match(/(\d+)\s*min/);
  return Math.round(
    ((days  ? parseInt(days[1])  * 24 : 0) +
     (hours ? parseInt(hours[1])     : 0) +
     (mins  ? parseInt(mins[1]) / 60 : 0)) * 100
  ) / 100;
}

function safeNum(v) {
  if (v === null || v === undefined || v === '' || v !== v) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// ── Load all CSV data from /data directory ────────────────────────────────────
// File naming convention: {Month}-calls-export.csv  and  {Month}-agent-activity-export.csv
function loadAllData() {
  const callsMap    = {};  // month → [{Name, Calls Made, Connected, ...}]
  const activityMap = {};  // month → [{Name, Appointments Set, ...}]

  if (!existsSync(DATA_DIR)) {
    console.error('[DATA] /data directory not found');
    return { callsMap, activityMap };
  }

  const files = readdirSync(DATA_DIR);
  for (const file of files) {
    if (!file.endsWith('.csv')) continue;
    const content = readFileSync(join(DATA_DIR, file), 'utf8');
    const parsed = Papa.parse(content, { header: true, skipEmptyLines: true });
    const rows = parsed.data;

    // Extract month name from filename: January-calls-export.csv → January
    const monthMatch = file.match(/^([A-Za-z]+)-(calls|agent-activity)-export\.csv$/);
    if (!monthMatch) { console.log('[DATA] skipping unrecognised file:', file); continue; }
    const month = monthMatch[1];
    const type  = monthMatch[2];

    if (type === 'calls') {
      callsMap[month] = rows;
    } else {
      activityMap[month] = rows;
    }
    console.log(`[DATA] loaded ${month} ${type} — ${rows.length} rows`);
  }
  return { callsMap, activityMap };
}

// ── Build consolidated records ────────────────────────────────────────────────
const MONTH_ORDER = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function buildRecords() {
  const { callsMap, activityMap } = loadAllData();
  const allMonths = [...new Set([...Object.keys(callsMap), ...Object.keys(activityMap)])]
    .sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));

  const records = [];
  for (const month of allMonths) {
    const callRows = callsMap[month] || [];
    const actRows  = activityMap[month] || [];

    // Build lookup by name
    const actByName = {};
    for (const row of actRows) {
      if (row.Name) actByName[row.Name.trim()] = row;
    }
    const callByName = {};
    for (const row of callRows) {
      if (row.Name) callByName[row.Name.trim()] = row;
    }

    const allNames = new Set([...Object.keys(actByName), ...Object.keys(callByName)]);
    for (const name of allNames) {
      const c = callByName[name] || {};
      const a = actByName[name] || {};
      const callsMade = safeNum(c['Calls Made']);
      const connected = safeNum(c['Connected']);
      const talkHrs   = parseTalkHours(c['Total Talk Time']);
      const apptsSet  = safeNum(a['Appointments Set']);
      const apptsAtt  = safeNum(a['Appointments']);

      records.push({
        month,
        name,
        // Calls (direct from FUB Calls report)
        callsMade,
        connected,
        conversations:  safeNum(c['Conversations']),
        received:       safeNum(c['Received']),
        callsMissed:    safeNum(c['Calls Missed']),
        talkHrs,
        // Calculated
        dialToConnect:  callsMade > 0 ? Math.round(connected / callsMade * 100) : 0,
        // Agent Activity (direct from FUB Agent Activity report)
        newLeads:       safeNum(a['New Leads']),
        initAssigned:   safeNum(a['Initially Assigned Leads']),
        currAssigned:   safeNum(a['Currently Assigned Leads']),
        callsActivity:  safeNum(a['Calls']),
        emails:         safeNum(a['Emails']),
        texts:          safeNum(a['Texts']),
        notes:          safeNum(a['Notes']),
        tasksCompleted: safeNum(a['Tasks Completed']),
        apptsSet,
        apptsAttended:  apptsAtt,
        // Calculated
        showRate:       apptsSet > 0 ? Math.round(apptsAtt / apptsSet * 100) : 0,
        // Speed metrics
        avgSpeedAction:    safeNum(a['Average Speed to Action (Minutes)']),
        avgSpeedFirstCall: safeNum(a['Average Speed to First Call (Minutes)']),
        avgSpeedFirstText: safeNum(a['Average Speed to First Text Message (Minutes)']),
        // Lead quality
        leadsNotActedOn: safeNum(a['Leads Not Acted On']),
        leadsNotCalled:  safeNum(a['Leads Not Called']),
        pctLeadsResponding:      a['% of Leads Responding'] || '',
        pctLeadsRespondingPhone: a['% of Leads Responding by Phone'] || '',
        conversionRate:          a['Conversion Rate'] || '',
        dealsClosed:    safeNum(a['Deals Closed'] || 0),
      });
    }
  }

  return { records, months: allMonths };
}

// ── Aggregate helpers ─────────────────────────────────────────────────────────
function sumField(records, field) {
  return records.reduce((s, r) => s + (r[field] || 0), 0);
}

function periodKey(month, period) {
  if (period === 'monthly') return month;
  return month; // weekly not available in CSV exports — use monthly
}

function aggregateByPeriod(records, groupField) {
  const map = {};
  for (const r of records) {
    const key = r[groupField] || r.month;
    if (!map[key]) map[key] = {
      period: key, callsMade:0, connected:0, talkHrs:0,
      apptsSet:0, apptsAttended:0, offers:0, verbals:0, contracts:0,
      texts:0, newLeads:0, tasksCompleted:0, dealsClosed:0,
    };
    const b = map[key];
    b.callsMade     += r.callsMade;
    b.connected     += r.connected;
    b.talkHrs       += r.talkHrs;
    b.apptsSet      += r.apptsSet;
    b.apptsAttended += r.apptsAttended;
    b.texts         += r.texts;
    b.newLeads      += r.newLeads;
    b.tasksCompleted+= r.tasksCompleted;
    b.dealsClosed   += r.dealsClosed;
  }
  return Object.values(map)
    .sort((a, b) => MONTH_ORDER.indexOf(a.period) - MONTH_ORDER.indexOf(b.period))
    .map(p => ({
      ...p,
      dialToConnect: p.callsMade > 0 ? Math.round(p.connected / p.callsMade * 100) : 0,
      showRate:      p.apptsSet  > 0 ? Math.round(p.apptsAttended / p.apptsSet * 100) : 0,
      talkTimeHrs:   Math.round(p.talkHrs * 10) / 10,
      // Alias for frontend compatibility
      dials:          p.callsMade,
      connectedCalls: p.connected,
    }));
}

// ── Cache ─────────────────────────────────────────────────────────────────────
let _cache = null;
function getData() {
  if (!_cache) { _cache = buildRecords(); console.log('[DATA] cache built'); }
  return _cache;
}
// Reload data (call when new CSVs are added)
function reloadData() { _cache = null; return getData(); }

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const { records, months } = getData();
  res.json({ ok: true, source: 'csv', recordCount: records.length, months });
});

app.get('/api/reload', (req, res) => {
  const d = reloadData();
  res.json({ ok: true, recordCount: d.records.length, months: d.months });
});

app.get('/api/users', (req, res) => {
  const { records } = getData();
  const names = [...new Set(records.map(r => r.name))].sort();
  const users = names.map((name, i) => ({ id: name, name, email: '' }));
  res.json({ ok: true, users });
});

// Team or per-agent KPI (monthly periods — CSV has no weekly data)
app.get('/api/kpi', (req, res) => {
  const { userId } = req.query;
  const { records } = getData();
  const filtered = userId ? records.filter(r => r.name === userId) : records;
  const monthly = aggregateByPeriod(filtered, 'month');
  res.json({ ok: true, weekly: monthly, monthly, source: 'csv' });
});

// All agents leaderboard
app.get('/api/kpi/all', (req, res) => {
  const { records } = getData();
  const names = [...new Set(records.map(r => r.name))].sort();
  const agents = names.map(name => {
    const ag = records.filter(r => r.name === name);
    const callsMade  = sumField(ag, 'callsMade');
    const connected  = sumField(ag, 'connected');
    const talkSec    = sumField(ag, 'talkHrs');
    const apptsSet   = sumField(ag, 'apptsSet');
    const apptsAtt   = sumField(ag, 'apptsAttended');
    return {
      userId: name, name, email: '',
      dials:          callsMade,
      connectedCalls: connected,
      talkTimeHrs:    Math.round(talkSec * 10) / 10,
      appts:          apptsSet,
      apptsAttended:  apptsAtt,
      showRate:       apptsSet > 0 ? Math.round(apptsAtt / apptsSet * 100) : 0,
      dialToConnect:  callsMade > 0 ? Math.round(connected / callsMade * 100) : 0,
      texts:          sumField(ag, 'texts'),
      newLeads:       sumField(ag, 'newLeads'),
      tasksCompleted: sumField(ag, 'tasksCompleted'),
      dealsClosed:    sumField(ag, 'dealsClosed'),
      offers:   0,  // not in standard FUB export
      verbals:  0,
      contracts:0,
    };
  });
  res.json({ ok: true, agents });
});

// Raw records (for debugging)
app.get('/api/records', (req, res) => {
  const { records, months } = getData();
  res.json({ ok: true, months, count: records.length, records: records.slice(0, 20) });
});

app.listen(PORT, () => {
  console.log(`\n🚀 FUB KPI Dashboard (CSV mode) at http://localhost:${PORT}`);
  console.log(`   Data dir: ${DATA_DIR}`);
  console.log(`   Add new CSVs to /data/ and hit /api/reload to refresh\n`);
  getData(); // pre-load on startup
});
