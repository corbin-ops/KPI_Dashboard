import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync, readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Try multiple possible data directory locations
function findDataDir() {
  const candidates = [
    join(__dirname, '../data'),
    join(process.cwd(), 'data'),
    join(__dirname, 'data'),
    '/opt/render/project/src/data',
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      console.log('[DATA] Found data dir:', p);
      return p;
    }
    console.log('[DATA] Not found:', p);
  }
  return null;
}

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// ── CSV parser (no deps) ──────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];
  function splitLine(line) {
    const cols = []; let cur = '', inQ = false;
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
    const row = {};
    headers.forEach((h, idx) => { row[h.trim()] = (vals[idx] ?? '').trim(); });
    if (row[headers[0].trim()]) rows.push(row);  // skip empty name rows
  }
  return rows;
}

function parseTalkHours(s) {
  if (!s || String(s).trim() === '') return 0;
  const str = String(s).toLowerCase();
  const d = str.match(/(\d+)\s*day/);
  const h = str.match(/(\d+)\s*hour/);
  const m = str.match(/(\d+)\s*min/);
  return Math.round(((d ? parseInt(d[1]) * 24 : 0) + (h ? parseInt(h[1]) : 0) + (m ? parseInt(m[1]) / 60 : 0)) * 100) / 100;
}

function safeNum(v) {
  if (!v && v !== 0) return 0;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

const MONTH_ORDER = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SHORT = {January:'Jan',February:'Feb',March:'Mar',April:'Apr',May:'May',June:'Jun',July:'Jul',August:'Aug',September:'Sep',October:'Oct',November:'Nov',December:'Dec'};

// ── Load CSVs ─────────────────────────────────────────────────────────────────
function loadCSVs() {
  const dataDir = findDataDir();
  if (!dataDir) {
    console.error('[DATA] CRITICAL: No data directory found');
    return { records: [], months: [], agents: [] };
  }

  let files;
  try { files = readdirSync(dataDir).filter(f => f.endsWith('.csv')); }
  catch (e) { console.error('[DATA] Cannot read dir:', e.message); return { records: [], months: [], agents: [] }; }

  console.log('[DATA] CSV files:', files);

  const callsMap = {}, actMap = {};
  for (const file of files) {
    const m = file.match(/^([A-Za-z]+)-(calls|agent-activity)-export\.csv$/i);
    if (!m) continue;
    const month = m[1], type = m[2].toLowerCase();
    try {
      const rows = parseCSV(readFileSync(join(dataDir, file), 'utf8'));
      console.log(`[DATA] ${file} → ${rows.length} rows, cols: ${rows[0] ? Object.keys(rows[0]).join('|') : 'none'}`);
      if (type === 'calls') callsMap[month] = rows;
      else actMap[month] = rows;
    } catch(e) { console.error('[DATA] Error reading', file, e.message); }
  }

  const months = [...new Set([...Object.keys(callsMap), ...Object.keys(actMap)])]
    .sort((a, b) => MONTH_ORDER.indexOf(a) - MONTH_ORDER.indexOf(b));

  const records = [];
  for (const month of months) {
    const callRows = callsMap[month] || [];
    const actRows  = actMap[month]   || [];
    const byName = {};
    actRows.forEach(r  => { if(r.Name) byName[r.Name.trim()] = { a: r, c: null }; });
    callRows.forEach(r => {
      const n = r.Name?.trim();
      if (!n) return;
      if (!byName[n]) byName[n] = { a: {}, c: r };
      else byName[n].c = r;
    });
    for (const [name, { a, c }] of Object.entries(byName)) {
      if (!name) continue;
      const callsMade = safeNum(c?.['Calls Made']);
      const connected = safeNum(c?.['Connected']);
      const talkHrs   = parseTalkHours(c?.['Total Talk Time']);
      const apptsSet  = safeNum(a?.['Appointments Set']);
      const apptsAtt  = safeNum(a?.['Appointments']);
      records.push({
        month, name, callsMade, connected, talkHrs,
        apptsSet, apptsAtt,
        texts:          safeNum(a?.['Texts']),
        emails:         safeNum(a?.['Emails']),
        notes:          safeNum(a?.['Notes']),
        newLeads:       safeNum(a?.['New Leads']),
        tasksCompleted: safeNum(a?.['Tasks Completed']),
        dealsClosed:    safeNum(a?.['Deals Closed']),
        leadsNotActedOn:safeNum(a?.['Leads Not Acted On']),
        avgSpeedCall:   safeNum(a?.['Average Speed to First Call (Minutes)']),
        avgSpeedText:   safeNum(a?.['Average Speed to First Text Message (Minutes)']),
        pctResponding:  a?.['% of Leads Responding'] || '',
        convRate:       a?.['Conversion Rate'] || '',
      });
    }
  }

  const agents = [...new Set(records.map(r => r.name))].sort();
  console.log(`[DATA] ✓ ${records.length} records | months: ${months} | agents: ${agents}`);
  return { records, months, agents };
}

// ── Pre-compute ───────────────────────────────────────────────────────────────
const { records, months, agents } = loadCSVs();

function buildSeries(recs) {
  const map = {};
  for (const r of recs) {
    const k = r.month;
    if (!map[k]) map[k] = { p:k, cm:0, co:0, th:0, as:0, aa:0, tx:0, nl:0, tc:0, dc:0 };
    const b = map[k];
    b.cm += r.callsMade; b.co += r.connected; b.th += r.talkHrs;
    b.as += r.apptsSet;  b.aa += r.apptsAtt;
    b.tx += r.texts;     b.nl += r.newLeads;
    b.tc += r.tasksCompleted; b.dc += r.dealsClosed;
  }
  return Object.values(map)
    .sort((a, b) => MONTH_ORDER.indexOf(a.p) - MONTH_ORDER.indexOf(b.p))
    .map(p => ({
      period:         SHORT[p.p] || p.p,
      dials:          p.cm,
      connectedCalls: p.co,
      talkTimeHrs:    Math.round(p.th * 10) / 10,
      talkTimeSec:    Math.round(p.th * 3600),
      apptsSet:       p.as,
      apptsAttended:  p.aa,
      showRate:       p.as ? Math.round(p.aa / p.as * 100) : 0,
      dialToConnect:  p.cm ? Math.round(p.co / p.cm * 100) : 0,
      texts: p.tx, newLeads: p.nl, tasksCompleted: p.tc, dealsClosed: p.dc,
    }));
}

function buildTotals(series) {
  const sum = f => series.reduce((s, p) => s + (p[f] || 0), 0);
  const talkSec = sum('talkTimeSec');
  const dials = sum('dials'), conn = sum('connectedCalls');
  const aSet = sum('apptsSet'), aAtt = sum('apptsAttended');
  return {
    dials, connectedCalls: conn,
    talkTimeHrs: Math.round(talkSec / 3600 * 10) / 10,
    apptsSet: aSet, apptsAttended: aAtt,
    showRate:      aSet  ? Math.round(aAtt  / aSet  * 100) : 0,
    dialToConnect: dials ? Math.round(conn  / dials * 100) : 0,
    texts: sum('texts'), newLeads: sum('newLeads'),
    tasksCompleted: sum('tasksCompleted'), dealsClosed: sum('dealsClosed'),
  };
}

const teamSeries = buildSeries(records);
const agentMap = {};
for (const name of agents) {
  const s = buildSeries(records.filter(r => r.name === name));
  agentMap[name] = { monthly: s, totals: buildTotals(s) };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({
  ok: records.length > 0, source: 'csv',
  recordCount: records.length, months, agents,
}));

app.get('/api/users', (req, res) => res.json({
  ok: true, users: agents.map(n => ({ id: n, name: n, email: '' })),
}));

app.get('/api/kpi', (req, res) => {
  const { userId } = req.query;
  const data = userId && agentMap[userId] ? agentMap[userId].monthly : teamSeries;
  res.json({ ok: true, monthly: data, weekly: data, source: 'csv' });
});

app.get('/api/kpi/all', (req, res) => {
  const agentList = agents.map(n => ({
    userId: n, name: n, email: '',
    ...agentMap[n].totals,
    appts: agentMap[n].totals.apptsSet,
  }));
  res.json({ ok: true, agents: agentList, source: 'csv' });
});

app.get('/api/debug', (req, res) => {
  const { name } = req.query;
  const sample = name
    ? records.filter(r => r.name === name)
    : records.slice(0, 5);
  res.json({ ok: true, recordCount: records.length, months, agents, sample });
});

app.listen(PORT, () => {
  console.log(`\n🚀 http://localhost:${PORT}`);
  console.log(`   records:${records.length} months:${months} agents:${agents.length}\n`);
});
