import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync, readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = join(__dirname, '../data');

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// ── Native CSV parser (no dependencies) ──────────────────────────────────────
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];
  // Handle quoted fields
  function splitLine(line) {
    const cols = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  }
  const headers = splitLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = splitLine(lines[i]);
    if (vals.every(v => !v)) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h.trim()] = vals[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}

// ── Talk time parser: "1 day 15 hours" → decimal hours ───────────────────────
function parseTalkHours(s) {
  if (!s || String(s).trim() === '') return 0;
  const str = String(s).toLowerCase();
  const d = str.match(/(\d+)\s*day/);
  const h = str.match(/(\d+)\s*hour/);
  const m = str.match(/(\d+)\s*min/);
  const total = (d ? parseInt(d[1]) * 24 : 0) +
                (h ? parseInt(h[1]) : 0) +
                (m ? parseInt(m[1]) / 60 : 0);
  return Math.round(total * 100) / 100;
}

function safeNum(v) {
  if (v === null || v === undefined || String(v).trim() === '') return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// ── Month ordering ────────────────────────────────────────────────────────────
const MONTH_ORDER = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SHORT_MONTHS = {January:'Jan',February:'Feb',March:'Mar',April:'Apr',May:'May',June:'Jun',July:'Jul',August:'Aug',September:'Sep',October:'Oct',November:'Nov',December:'Dec'};

// ── Load all CSVs and build dataset ──────────────────────────────────────────
function buildDataset() {
  console.log('[DATA] Loading CSVs from:', DATA_DIR);

  if (!existsSync(DATA_DIR)) {
    console.error('[DATA] ERROR: /data directory not found at', DATA_DIR);
    return { records: [], months: [] };
  }

  const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.csv'));
  console.log('[DATA] Files found:', files);

  const callsMap    = {};  // month → rows
  const activityMap = {};  // month → rows

  for (const file of files) {
    const match = file.match(/^([A-Za-z]+)-(calls|agent-activity)-export\.csv$/i);
    if (!match) { console.log('[DATA] skipping:', file); continue; }
    const month = match[1];
    const type  = match[2].toLowerCase();
    const content = readFileSync(join(DATA_DIR, file), 'utf8');
    const rows = parseCSV(content);
    console.log(`[DATA] ${file}: ${rows.length} rows, headers: ${rows[0] ? Object.keys(rows[0]).slice(0,5).join(', ') : 'none'}`);
    if (type === 'calls') callsMap[month] = rows;
    else activityMap[month] = rows;
  }

  const allMonths = [...new Set([...Object.keys(callsMap), ...Object.keys(activityMap)])]
    .sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));

  console.log('[DATA] Months found:', allMonths);

  const records = [];
  for (const month of allMonths) {
    const callRows = callsMap[month] || [];
    const actRows  = activityMap[month] || [];

    // Index by name
    const byName = {};
    for (const r of actRows)  { if (r.Name) byName[r.Name.trim()] = { act: r, call: {} }; }
    for (const r of callRows) { if (r.Name) {
      if (!byName[r.Name.trim()]) byName[r.Name.trim()] = { act: {}, call: r };
      else byName[r.Name.trim()].call = r;
    }}

    for (const [name, { act, call }] of Object.entries(byName)) {
      const callsMade = safeNum(call['Calls Made']);
      const connected = safeNum(call['Connected']);
      const talkHrs   = parseTalkHours(call['Total Talk Time']);
      const apptsSet  = safeNum(act['Appointments Set']);
      const apptsAtt  = safeNum(act['Appointments']);

      records.push({
        month, name,
        // Calls
        callsMade, connected, talkHrs,
        conversations: safeNum(call['Conversations']),
        received:      safeNum(call['Received']),
        callsMissed:   safeNum(call['Calls Missed']),
        // Calculated
        dialToConnect: callsMade > 0 ? Math.round(connected / callsMade * 100) : 0,
        // Activity
        newLeads:       safeNum(act['New Leads']),
        texts:          safeNum(act['Texts']),
        emails:         safeNum(act['Emails']),
        notes:          safeNum(act['Notes']),
        tasksCompleted: safeNum(act['Tasks Completed']),
        apptsSet, apptsAtt,
        showRate: apptsSet > 0 ? Math.round(apptsAtt / apptsSet * 100) : 0,
        // Speed metrics
        avgSpeedFirstCall: safeNum(act['Average Speed to First Call (Minutes)']),
        avgSpeedFirstText: safeNum(act['Average Speed to First Text Message (Minutes)']),
        leadsNotActedOn:   safeNum(act['Leads Not Acted On']),
        pctLeadsResponding: act['% of Leads Responding'] || '',
        conversionRate:     act['Conversion Rate'] || '',
        dealsClosed: safeNum(act['Deals Closed']),
      });
    }
  }

  console.log(`[DATA] Built ${records.length} records across ${allMonths.length} months`);
  // Log sample record
  if (records.length > 0) {
    const sample = records[0];
    console.log('[DATA] Sample:', JSON.stringify({
      name: sample.name, month: sample.month,
      callsMade: sample.callsMade, connected: sample.connected,
      talkHrs: sample.talkHrs, apptsSet: sample.apptsSet,
    }));
  }

  return { records, months: allMonths };
}

// ── Pre-compute everything at startup ─────────────────────────────────────────
const { records, months } = buildDataset();

function sumF(arr, f) { return arr.reduce((s, r) => s + (r[f] || 0), 0); }

function toSeries(records, groupBy = 'month') {
  const map = {};
  for (const r of records) {
    const key = r[groupBy];
    if (!map[key]) map[key] = {
      period: key, callsMade:0, connected:0, talkHrs:0,
      apptsSet:0, apptsAtt:0, texts:0, newLeads:0, tasksCompleted:0,
      dealsClosed:0, notes:0, emails:0,
    };
    const b = map[key];
    b.callsMade     += r.callsMade;
    b.connected     += r.connected;
    b.talkHrs       += r.talkHrs;
    b.apptsSet      += r.apptsSet;
    b.apptsAtt      += r.apptsAtt;
    b.texts         += r.texts;
    b.newLeads      += r.newLeads;
    b.tasksCompleted+= r.tasksCompleted;
    b.dealsClosed   += r.dealsClosed;
    b.notes         += r.notes;
    b.emails        += r.emails;
  }
  return Object.values(map)
    .sort((a, b) => MONTH_ORDER.indexOf(a.period) - MONTH_ORDER.indexOf(b.period))
    .map(p => ({
      period:         SHORT_MONTHS[p.period] || p.period,
      dials:          p.callsMade,
      connectedCalls: p.connected,
      talkTimeHrs:    Math.round(p.talkHrs * 10) / 10,
      talkTimeSec:    Math.round(p.talkHrs * 3600),
      apptsSet:       p.apptsSet,
      apptsAttended:  p.apptsAtt,
      showRate:       p.apptsSet ? Math.round(p.apptsAtt / p.apptsSet * 100) : 0,
      dialToConnect:  p.callsMade ? Math.round(p.connected / p.callsMade * 100) : 0,
      texts:          p.texts,
      newLeads:       p.newLeads,
      tasksCompleted: p.tasksCompleted,
      dealsClosed:    p.dealsClosed,
    }));
}

// Pre-build team + per-agent data
const teamMonthly   = toSeries(records);
const agentNames    = [...new Set(records.map(r => r.name))].sort();

const agentData = {};
for (const name of agentNames) {
  const agRecs = records.filter(r => r.name === name);
  const monthly = toSeries(agRecs);
  const sum = f => monthly.reduce((s, p) => s + (p[f] || 0), 0);
  const sumHrs = monthly.reduce((s, p) => s + (p.talkTimeSec || 0), 0);
  agentData[name] = {
    monthly,
    totals: {
      dials:          sum('dials'),
      connectedCalls: sum('connectedCalls'),
      talkTimeHrs:    Math.round(sumHrs / 3600 * 10) / 10,
      apptsSet:       sum('apptsSet'),
      apptsAttended:  sum('apptsAttended'),
      showRate:       sum('apptsSet') ? Math.round(sum('apptsAttended') / sum('apptsSet') * 100) : 0,
      dialToConnect:  sum('dials') ? Math.round(sum('connectedCalls') / sum('dials') * 100) : 0,
      texts:          sum('texts'),
      newLeads:       sum('newLeads'),
      tasksCompleted: sum('tasksCompleted'),
      dealsClosed:    sum('dealsClosed'),
    }
  };
}

console.log('[DATA] Pre-computed agents:', agentNames);

// ── Routes ─────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: records.length > 0, source: 'csv', recordCount: records.length, months });
});

app.get('/api/users', (req, res) => {
  const users = agentNames.map(name => ({ id: name, name, email: '' }));
  res.json({ ok: true, users });
});

// Team or per-agent KPI — instant response from pre-computed data
app.get('/api/kpi', (req, res) => {
  const { userId } = req.query;
  if (userId && agentData[userId]) {
    const d = agentData[userId];
    res.json({ ok: true, monthly: d.monthly, weekly: d.monthly, source: 'csv' });
  } else {
    res.json({ ok: true, monthly: teamMonthly, weekly: teamMonthly, source: 'csv' });
  }
});

// Leaderboard
app.get('/api/kpi/all', (req, res) => {
  const agents = agentNames.map(name => ({
    userId: name, name, email: '',
    ...agentData[name].totals,
    appts: agentData[name].totals.apptsSet,
    apptsAttended: agentData[name].totals.apptsAttended,
  }));
  res.json({ ok: true, agents, source: 'csv' });
});

// Debug — inspect raw records
app.get('/api/debug', (req, res) => {
  const { name } = req.query;
  const filtered = name ? records.filter(r => r.name === name) : records.slice(0, 10);
  res.json({ ok: true, count: records.length, months, agents: agentNames, sample: filtered });
});

// Hot reload (just restarts the data build — useful after adding new CSVs)
app.get('/api/reload', (req, res) => {
  res.json({ ok: false, message: 'Restart the server to reload CSV files (Render: manual deploy)' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 FUB KPI Dashboard (CSV) — http://localhost:${PORT}`);
  console.log(`   Records: ${records.length} | Months: ${months.join(', ')} | Agents: ${agentNames.length}`);
  console.log(`   Data dir: ${DATA_DIR}`);
  console.log(`\n   Debug: /api/debug`);
  console.log(`   Sample agent: /api/debug?name=Marie+Emara\n`);
});
