import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync, readFileSync, existsSync } from 'fs';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = join(__dirname, '../data');

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// ── Config ────────────────────────────────────────────────────────────────────
const MARIE_SHEET_ID = '14GT7CfPfsdkL_bgDbXi2hWg4yJQ9izAPwvFW2KNNT-o';
const MARIE_GID      = '0'; // Form Responses 1

const MONTH_ORDER = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const SHORT = Object.fromEntries(MONTH_ORDER.map(m => [m, m.slice(0,3)]));

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if (lines.length < 2) return [];
  function splitLine(line) {
    const cols=[]; let cur='', inQ=false;
    for (let i=0; i<line.length; i++) {
      const ch=line[i];
      if (ch==='"'){inQ=!inQ;continue;}
      if (ch===','&&!inQ){cols.push(cur.trim());cur='';continue;}
      cur+=ch;
    }
    cols.push(cur.trim()); return cols;
  }
  const headers = splitLine(lines[0]);
  return lines.slice(1).filter(l=>l.trim()).map(l=>{
    const vals=splitLine(l), row={};
    headers.forEach((h,i)=>{ row[h.trim()]=(vals[i]??'').trim(); });
    return row;
  }).filter(r=>Object.values(r).some(v=>v));
}

function safeN(v) {
  const n = parseFloat(String(v??'').replace(/[^\d.\-]/g,''));
  return isNaN(n) ? 0 : n;
}

function parseTalkHours(s) {
  if (!s || String(s).trim()==='') return 0;
  const str = String(s).toLowerCase();
  const d = str.match(/(\d+)\s*day/);
  const h = str.match(/(\d+)\s*hour/);
  const m = str.match(/(\d+)\s*min/);
  return Math.round(((d?parseInt(d[1])*24:0)+(h?parseInt(h[1]):0)+(m?parseInt(m[1])/60:0))*100)/100;
}

// ── Fetch URL with redirect following (for Google Sheets) ─────────────────────
function fetchURL(url, redirects=0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers:{'User-Agent':'Mozilla/5.0'} }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location, redirects+1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data='';
      res.on('data', chunk => data+=chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ── Load main data from CSVs in /data/ ────────────────────────────────────────
function loadCSVData() {
  if (!existsSync(DATA_DIR)) {
    console.error('[DATA] /data directory not found:', DATA_DIR);
    return { records:[], months:[], agents:[] };
  }

  const files = readdirSync(DATA_DIR).filter(f=>f.endsWith('.csv'));
  console.log('[CSV] Files found:', files.join(', '));

  const callsMap={}, actMap={};
  for (const file of files) {
    const m = file.match(/^([A-Za-z]+)-(calls|agent-activity)-export\.csv$/i);
    if (!m) continue;
    const month=m[1], type=m[2].toLowerCase();
    try {
      const rows = parseCSV(readFileSync(join(DATA_DIR,file),'utf8'));
      if (type==='calls') callsMap[month]=rows;
      else actMap[month]=rows;
    } catch(e) { console.error('[CSV] Error reading',file,e.message); }
  }

  const allMonthNames = [...new Set([...Object.keys(callsMap),...Object.keys(actMap)])]
    .sort((a,b) => MONTH_ORDER.indexOf(a)-MONTH_ORDER.indexOf(b));

  const records=[];
  for (const monthFull of allMonthNames) {
    const callRows=callsMap[monthFull]||[];
    const actRows=actMap[monthFull]||[];
    const byName={};
    actRows.forEach(r=>{ if(r.Name) byName[r.Name.trim()]={a:r,c:null}; });
    callRows.forEach(r=>{ if(!r.Name) return; const n=r.Name.trim();
      if(!byName[n]) byName[n]={a:{},c:r}; else byName[n].c=r; });

    for (const [name,{a,c}] of Object.entries(byName)) {
      if (!name) continue;
      records.push({
        monthFull, month: SHORT[monthFull]||monthFull.slice(0,3), name,
        callsMade:      safeN(c?.['Calls Made']),
        connected:      safeN(c?.['Connected']),
        talkHrs:        parseTalkHours(c?.['Total Talk Time']),
        apptsSet:       safeN(a?.['Appointments Set']),
        apptsAtt:       safeN(a?.['Appointments']),
        texts:          safeN(a?.['Texts']),
        newLeads:       safeN(a?.['New Leads']),
        tasksCompleted: safeN(a?.['Tasks Completed']),
        emails:         safeN(a?.['Emails']),
        dealsClosed:    safeN(a?.['Deals Closed']||0),
      });
    }
  }

  const seenMonths=new Set(), months=[];
  for (const m of MONTH_ORDER) {
    if (records.some(r=>r.monthFull===m) && !seenMonths.has(m)) {
      months.push({full:m, short:SHORT[m]});
      seenMonths.add(m);
    }
  }

  const agents = [...new Set(records.map(r=>r.name))].sort();
  console.log(`[CSV] Loaded: ${records.length} records | months: ${months.map(m=>m.short)} | agents: ${agents.length}`);
  return {records, months, agents};
}

// ── Fetch & parse Marie's appointment sheet (live, every request with cache) ──
let marieCache = null;
let marieCacheTime = 0;
const MARIE_TTL = 60 * 60 * 1000; // 1 hour cache

async function loadMarieData() {
  // Return cache if fresh
  if (marieCache && (Date.now() - marieCacheTime) < MARIE_TTL) {
    return marieCache;
  }

  const url = `https://docs.google.com/spreadsheets/d/${MARIE_SHEET_ID}/export?format=csv&gid=${MARIE_GID}`;
  console.log('[MARIE] Fetching fresh data from Google Sheet...');
  const text = await fetchURL(url);
  const rows = parseCSV(text);
  console.log(`[MARIE] Fetched ${rows.length} rows`);

  const outcomes={}, objections={}, personalities={};
  const motLevels=[];
  const monthlyBooked={}, monthlyTotal={};
  const weeklyBooked={};

  for (const r of rows) {
    const outcome = r['Call Outcome']?.trim()||'';
    outcomes[outcome]=(outcomes[outcome]||0)+1;
    const obj=r['Objections']?.trim()||'';
    if(obj) objections[obj]=(objections[obj]||0)+1;
    const pers=r['Personality']?.trim()||'';
    if(pers) personalities[pers]=(personalities[pers]||0)+1;
    const mot=parseFloat(r['Motivation Level']);
    if(!isNaN(mot)) motLevels.push(mot);

    const ts=r['Timestamp']||'';
    const dm=ts.match(/^(\d+)\/(\d+)\/(\d+)/);
    if(dm) {
      const d=new Date(parseInt(dm[3]),parseInt(dm[1])-1,parseInt(dm[2]));
      const moStr=d.toLocaleString('en-US',{month:'short'});
      monthlyTotal[moStr]=(monthlyTotal[moStr]||0)+1;
      if(outcome==='Appointment Booked') monthlyBooked[moStr]=(monthlyBooked[moStr]||0)+1;
      const jan1=new Date(d.getFullYear(),0,1);
      const week=Math.ceil(((d-jan1)/86400000+jan1.getDay()+1)/7);
      const wk=`W${String(week).padStart(2,'0')}`;
      if(outcome==='Appointment Booked') weeklyBooked[wk]=(weeklyBooked[wk]||0)+1;
    }
  }

  const total=rows.length;
  const booked=outcomes['Appointment Booked']||0;
  const avgMot=motLevels.length ? Math.round(motLevels.reduce((a,b)=>a+b,0)/motLevels.length*10)/10 : 0;
  const highMot=motLevels.filter(m=>m>=8).length;

  const moOrder=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthlyArr=moOrder.filter(m=>monthlyTotal[m]).map(m=>({
    m, n:monthlyBooked[m]||0, total:monthlyTotal[m]
  }));
  const weeklyArr=Object.entries(weeklyBooked)
    .sort((a,b)=>a[0].localeCompare(b[0])).slice(-10)
    .map(([w,n])=>({w:w.replace('W',''),n}));

  marieCache = {
    total, booked,
    followUp: outcomes['Follow Up Needed']||0,
    notInterested: outcomes['Not Interested']||0,
    bookRate: total?Math.round(booked/total*100):0,
    avgMot, highMot,
    highMotPct: motLevels.length?Math.round(highMot/motLevels.length*100):0,
    objections: Object.entries(objections).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([l,n])=>({l,n})),
    personalities: Object.entries(personalities).sort((a,b)=>b[1]-a[1]).map(([l,n])=>({l,n})),
    monthlyBooked: monthlyArr,
    weeklyTrend: weeklyArr,
    lastUpdated: new Date().toISOString(),
  };
  marieCacheTime = Date.now();

  console.log(`[MARIE] Parsed: ${total} leads, ${booked} booked (${marieCache.bookRate}%), cached for 1hr`);
  return marieCache;
}

// ── Pre-load CSV data at startup ──────────────────────────────────────────────
const CSV_DATA = loadCSVData();

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req,res) => {
  res.json({
    ok: CSV_DATA.records.length > 0,
    csvRecords: CSV_DATA.records.length,
    months: CSV_DATA.months.map(m=>m.short),
    agents: CSV_DATA.agents,
    marieCached: !!marieCache,
    marieCacheAge: marieCache ? Math.round((Date.now()-marieCacheTime)/1000)+'s' : 'none',
  });
});

// Main data: CSV data + live Marie sheet
app.get('/api/data', async (req,res) => {
  try {
    const marie = await loadMarieData().catch(e => {
      console.warn('[MARIE] Fetch failed:', e.message);
      return null;
    });
    res.json({ ok:true, ...CSV_DATA, marie });
  } catch(e) {
    console.error('[/api/data]', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// Force Marie cache refresh
app.get('/api/refresh-marie', async (req,res) => {
  marieCache = null; marieCacheTime = 0;
  try {
    const marie = await loadMarieData();
    res.json({ ok:true, message:'Marie data refreshed', total:marie.total, booked:marie.booked });
  } catch(e) {
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀  FUB KPI Dashboard — http://localhost:${PORT}`);
  console.log(`    CSV months: ${CSV_DATA.months.map(m=>m.short).join(', ')}`);
  console.log(`    Marie sheet: live fetch on first request, cached 1hr`);
  console.log(`\n    ➕ New month: drop CSVs in /data/ and redeploy`);
  console.log(`    🔄 Force Marie refresh: GET /api/refresh-marie\n`);
});
