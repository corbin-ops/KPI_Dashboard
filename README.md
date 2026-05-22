# FUB Metric Explorer

A local dashboard to validate which Follow Up Boss metrics are available per agent, mapped against your Phase 1–3 KPI gap analysis.

## Setup

### 1. Clone & install

```bash
git clone <your-repo-url>
cd fub-metric-explorer
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and add your Follow Up Boss API key:

```
FUB_API_KEY=fka_your_key_here
```

**Where to find your FUB API key:**
> Follow Up Boss → Settings → API → Generate API Key

### 3. Start the server

```bash
npm start
# or for auto-reload during development:
npm run dev
```

### 4. Open the dashboard

```
http://localhost:3000
```

Click **"run full check"** in the sidebar.

---

## What it does

| Action | What happens |
|---|---|
| **run full check** | Validates API key, fetches all users, probes all endpoints, runs gap analysis |
| **probe endpoints** | Checks which FUB endpoints are live and what fields are exposed |
| **load agent metrics** | Pulls actual call/appointment data per matched agent |
| Click an agent | Shows their current metrics + Phase 1–3 gap breakdown |

## Metric availability legend

| Badge | Meaning |
|---|---|
| `available` | FUB has this data — can pull directly |
| `partial` | FUB has related data — needs a calculated field or filter |
| `missing` | Not tracked in FUB — lives in an external tool or doesn't exist |

## Endpoints probed

`people` · `calls` · `appointments` · `deals` · `tasks` · `texts` · `notes` · `events` · `smartLists` · `stages`

## Team members tracked

| Name | Role |
|---|---|
| Marie | New Lead Intake |
| Emma | Follow-Up Specialist |
| Michael | Acquisitions Manager |
| Corbin | Acquisitions |
| Hugo | Realtor/Title Outreach |
| Chenge / Taa | SMS/Lead Push |

## Requirements

- Node.js 18+
- A Follow Up Boss account with API access
