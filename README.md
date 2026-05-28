# FUB KPI Dashboard — CSV Mode

Data source has been switched from the FUB API to **exported CSV files**.
No API key required. No rate limits. Exact numbers matching FUB reports.

## How it works

The server reads two CSV types exported from FUB Reporting each month:
- `{Month}-calls-export.csv` — from Reporting → Calls
- `{Month}-agent-activity-export.csv` — from Reporting → Agent Activity

Place files in the `/data/` folder. Server reads them all on startup.

## Setup

```bash
npm install
npm start
# open http://localhost:3000
```

No `.env` file or API key needed (FUB_API_KEY is no longer required).

## Adding a new month

1. Export from FUB:
   - Reporting → Calls → Everyone → [month date range] → Download CSV → rename `May-calls-export.csv`
   - Reporting → Agent Activity → Everyone → [month date range] → Download CSV → rename `May-agent-activity-export.csv`

2. Drop both files into `/data/`

3. Either:
   - Restart the server (`npm start`), OR
   - Hit `GET /api/reload` to hot-reload without restart

4. Push to GitHub → Render auto-deploys

## Render deployment

**Build command:** `npm install`
**Start command:** `npm start`

**Environment variables:** None required (FUB_API_KEY no longer needed)

## Data folder

```
data/
  January-calls-export.csv
  January-agent-activity-export.csv
  February-calls-export.csv
  February-agent-activity-export.csv
  March-calls-export.csv
  March-agent-activity-export.csv
  April-calls-export.csv
  April-agent-activity-export.csv
  May-calls-export.csv          ← add here each month
  May-agent-activity-export.csv
```

## Available metrics (from CSV exports)

| Metric | Source |
|---|---|
| Calls Made | Calls Export |
| Connected Calls | Calls Export |
| Talk Time (hrs) | Calls Export — parsed from text |
| Dial → Connect % | Calculated |
| Appointments Set | Agent Activity Export |
| Appointments Attended | Agent Activity Export |
| Show Rate % | Calculated |
| Texts Sent | Agent Activity Export |
| New Leads | Agent Activity Export |
| Tasks Completed | Agent Activity Export |
| Deals Closed | Agent Activity Export (April+) |
| Speed to First Call | Agent Activity Export |
| Speed to First Text | Agent Activity Export |
| % Leads Responding | Agent Activity Export |
