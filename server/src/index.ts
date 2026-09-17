import express from 'express';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';
import { env } from './env.js';
import { logger } from './logger.js';
import { attachWs, broadcast, studioMateConnected } from './ws.js';
import { MEDIA_DIR, MEDIA_ROUTE } from './media.js';
import { studiocallRouter } from './routes/studiocall.js';

const app = express();
app.disable('x-powered-by');

app.get('/api/studiocall/health', (_req, res) => res.json({
  ok: true,
  studiomate: { configured: !!env.STUDIOMATE_URL, connected: studioMateConnected() },
}));

// Faces pulled off Clubhouse's CDN, content-hashed — safe to cache for good.
app.use(MEDIA_ROUTE, express.static(MEDIA_DIR, { immutable: true, maxAge: '365d', fallthrough: false }));

/**
 * StudioMate, reached from the StudioCall UI through this server — the browser never calls a
 * second origin. Only the StudioMate-side panels use it (the OBS overlay layer a card is drawn
 * on, its style, whether it is showing). Unconfigured, it answers 503 and those panels say so.
 */
const localTls = new Agent({ connect: { rejectUnauthorized: false } });
app.use('/api/studiocall/studiomate', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  if (!env.STUDIOMATE_URL) return res.status(503).json({ error: 'studiomate-offline', message: 'StudioMate is not configured (STUDIOMATE_URL).' });
  try {
    const upstream = await undiciFetch(`${env.STUDIOMATE_URL}${req.url}`, {
      method: req.method,
      headers: req.headers['content-type'] ? { 'content-type': String(req.headers['content-type']) } : undefined,
      body: ['GET', 'HEAD'].includes(req.method) || !Buffer.isBuffer(req.body) || !req.body.length ? undefined : req.body,
      dispatcher: localTls,
    });
    res.status(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.setHeader('content-type', type);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    res.status(503).json({ error: 'studiomate-offline', message: 'StudioMate is not answering.' });
  }
});

app.use(express.json({ limit: '10mb' }));

// UI settings (layout, sort, tile size) — one JSON file, broadcast so every open window agrees.
const UI_FILE = join(env.DATA_DIR, 'ui-settings.json');
let uiSettings: Record<string, string> = {};
try { uiSettings = JSON.parse(readFileSync(UI_FILE, 'utf8')); } catch {}
function patchUiSettings(patch: unknown) {
  if (!patch || typeof patch !== 'object') return;
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) if (typeof v === 'string') clean[k] = v;
  if (!Object.keys(clean).length) return;
  Object.assign(uiSettings, clean);
  writeFileSync(UI_FILE, JSON.stringify(uiSettings, null, 2));
  broadcast({ type: 'ui-settings', patch: clean });
}
app.get('/api/studiocall/ui/settings', (_req, res) => res.json(uiSettings));
app.post('/api/studiocall/ui/settings', (req, res) => { patchUiSettings(req.body); res.json({ ok: true }); });
app.post('/api/studiocall/ui/settings/beacon', express.text({ type: '*/*' }), (req, res) => {
  try { patchUiSettings(JSON.parse(String(req.body))); } catch {}
  res.json({ ok: true });
});

app.use('/api/studiocall', studiocallRouter);

// The built UI (client/dist), when there is one: a shared install is this server and the engine,
// no dev server. In development studiocall-client serves it instead.
const CLIENT_DIST = join(env.ROOT, 'client', 'dist');
if (existsSync(join(CLIENT_DIST, 'index.html'))) {
  app.use('/studiocall', express.static(CLIENT_DIST, { index: 'index.html' }));
  app.get('/', (_req, res) => res.redirect('/studiocall/'));
}

const server = createServer(app);
attachWs(server);
server.listen(env.PORT, '127.0.0.1', () => {
  logger.info(`StudioCall server on http://127.0.0.1:${env.PORT} — data ${env.DATA_DIR}${env.STUDIOMATE_URL ? `, StudioMate ${env.STUDIOMATE_URL}` : ', no StudioMate'}`);
});
