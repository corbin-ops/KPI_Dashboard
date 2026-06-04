import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync, readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// The frontend is fully self-contained — all data is baked into public/index.html
// This server only needs to serve the static files.
// When the mothersheet is updated, regenerate index.html and redeploy.

app.get('/api/health', (req, res) => {
  res.json({ ok: true, source: 'static-html', note: 'Data baked into index.html from mothersheet' });
});

app.listen(PORT, () => {
  console.log(`\n🚀  FUB KPI Dashboard — http://localhost:${PORT}`);
  console.log(`    Data source: public/index.html (baked from mothersheet)`);
  console.log(`    To update: regenerate index.html from updated mothersheet and redeploy\n`);
});
