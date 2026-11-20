import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { PaymentAgent } from './agent.js';
import { Alerts } from './alerts.js';
import { addressOf, fromUsd, readState, vaultWrite } from './chain.js';
import { config, ROOT } from './config.js';
import { EventHub, startPoller } from './events.js';
import { merchantCharge, merchants, x402Router, x402State } from './merchants.js';
import { streamsRouter } from './streams.js';
import { parseCommand, speak, transcribe, voiceEnabled } from './voice.js';

const app = express();
const hub = new EventHub();

// ── Server-sent events to the dashboard ─────────────────────────────────────
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

let cache = { at: 0, state: null };
async function getState(fresh = false) {
  if (!fresh && cache.state && Date.now() - cache.at < 1000) return cache.state;
  cache = { at: Date.now(), state: await readState() };
  return cache.state;
}

const alerts = new Alerts({ getState: () => getState(true), broadcast });
const agent = new PaymentAgent({ baseUrl: `http://127.0.0.1:${config.port}`, broadcast, alerts });

hub.on('event', (ev) => {
  broadcast('event', ev);
  alerts.onEvent(ev).catch((e) => console.warn('[alerts]', e.message));
  getState(true).then((s) => broadcast('state', s)).catch(() => {});
});
hub.on('update', (ev) => broadcast('event-update', ev));

// Webhook + x402 routes need their own body handling, so mount them before express.json().
app.use(streamsRouter(hub));
app.use(x402Router());
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.shortMessage ?? e.message });
  }
};

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(': hi\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

app.get(
  '/api/state',
  wrap(async () => ({
    ...(await getState()),
    merchants: Object.fromEntries(Object.entries(merchants).map(([k, m]) => [k, { ...m, address: addressOf(k) }])),
    integrations: {
      voice: voiceEnabled(),
      streams: { primary: config.quicknode.primary, signed: Boolean(config.quicknode.secret), ...hub.stats },
      x402PriceUsd: merchants.weather.basePriceUsd * x402State.priceMultiplier,
    },
  })),
);
app.get('/api/feed', (req, res) => res.json({ events: hub.recent(100), alerts: alerts.list }));

// ── User actions (the owner's invisible wallet signs these) ─────────────────
app.post(
  '/api/mandates',
  wrap(async (req) => {
    const b = req.body;
    const merchant = b.merchant ?? addressOf(b.merchantKey);
    if (!merchant) throw new Error('merchant or merchantKey required');
    const s = await getState(true);
    const r = await vaultWrite('owner', 'createMandate', [
      {
        merchant,
        capPerCharge: fromUsd(b.capPerChargeUsd),
        totalCap: fromUsd(b.totalCapUsd ?? b.capPerChargeUsd),
        askAbove: fromUsd(b.askAboveUsd ?? 0),
        expiresAt: BigInt(s.chainTime + Number(b.expiresInSec ?? 7 * 86400)),
        maxCharges: Number(b.maxCharges ?? 0),
        agentCanPay: Boolean(b.agentCanPay),
        label: String(b.label ?? 'New mandate').slice(0, 60),
      },
    ]);
    return { txHash: r.hash };
  }),
);
app.post('/api/mandates/:id/kill', wrap(async (req) => ({ txHash: (await vaultWrite('owner', 'kill', [BigInt(req.params.id)])).hash })));
app.post(
  '/api/mandates/:id/extend',
  wrap(async (req) => {
    const s = await getState(true);
    const m = s.mandates[Number(req.params.id)];
    const r = await vaultWrite('owner', 'extend', [
      BigInt(req.params.id),
      BigInt(s.chainTime + Number(req.body.expiresInSec ?? 7 * 86400)),
      fromUsd(req.body.totalCapUsd ?? m.totalCapUsd),
    ]);
    return { txHash: r.hash };
  }),
);
app.post('/api/pending/:id/approve', wrap(async (req) => ({ txHash: (await vaultWrite('owner', 'approvePending', [BigInt(req.params.id)])).hash })));
app.post('/api/pending/:id/reject', wrap(async (req) => ({ txHash: (await vaultWrite('owner', 'rejectPending', [BigInt(req.params.id), Boolean(req.body.kill)])).hash })));

// ── Voice commands: ElevenLabs Scribe → deterministic intent → vault tx → spoken confirmation ──
async function executeCommand(text, alertId) {
  const s = await getState(true);
  const cmd = parseCommand(text, s.mandates);
  const ctx = alerts.list.find((a) => a.id === alertId) ?? alerts.list.find((a) => a.kind === 'held' || a.kind === 'blocked' || a.kind === 'agent');
  const open = s.pending.filter((p) => p.status === 'Open');
  let reply;
  let txHash = null;

  if (cmd.action === 'approve') {
    const p =
      (ctx?.pendingId !== undefined && open.find((x) => x.id === ctx.pendingId)) ||
      open.filter((x) => cmd.target === null || x.mandateId === cmd.target).at(-1);
    if (!p) reply = "There's nothing waiting for approval.";
    else {
      txHash = (await vaultWrite('owner', 'approvePending', [BigInt(p.id)])).hash;
      reply = `Approved $${p.amountUsd.toFixed(2)} to ${s.mandates[p.mandateId].label}.`;
    }
  } else if (cmd.action === 'kill') {
    const mandateId = cmd.target ?? ctx?.mandateId;
    const p = open.find((x) => x.mandateId === mandateId);
    if (mandateId === undefined || mandateId === null) reply = 'Which subscription should I kill?';
    else if (p) {
      txHash = (await vaultWrite('owner', 'rejectPending', [BigInt(p.id), true])).hash;
      reply = `Rejected the charge and killed ${s.mandates[mandateId].label}.`;
    } else if (!s.mandates[mandateId]?.active) reply = `${s.mandates[mandateId]?.label ?? 'That'} is already dead.`;
    else {
      txHash = (await vaultWrite('owner', 'kill', [BigInt(mandateId)])).hash;
      reply = `Killed ${s.mandates[mandateId].label}.`;
    }
  } else if (cmd.action === 'kill-all') {
    const live = s.mandates.filter((m) => m.active);
    for (const m of live) txHash = (await vaultWrite('owner', 'kill', [BigInt(m.id)])).hash;
    reply = live.length ? `Killed all ${live.length} active permissions. Nothing can charge you now.` : 'Nothing is active.';
  } else {
    reply = `I heard "${text}". Say approve, or kill it.`;
  }
  let audioUrl = null;
  try {
    audioUrl = await speak(reply, `reply-${Date.now()}`);
  } catch (e) {
    console.warn('[voice]', e.message);
  }
  const out = { heard: text, command: cmd, reply, audioUrl, txHash };
  broadcast('command', out);
  return out;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post(
  '/api/voice',
  upload.single('audio'),
  wrap(async (req) => {
    if (!req.file) throw new Error('no audio');
    const text = await transcribe(req.file.buffer, req.file.mimetype, req.file.originalname || 'command.webm');
    return executeCommand(text, req.body.alertId);
  }),
);
app.post('/api/command', wrap(async (req) => executeCommand(String(req.body.text ?? ''), req.body.alertId)));

// ── Demo controls (merchant + agent simulators) ─────────────────────────────
const findMandate = (s, key) => s.mandates.find((m) => m.merchant.toLowerCase() === addressOf(key)?.toLowerCase());
app.post(
  '/api/demo/cloudtool',
  wrap(async (req) => {
    const s = await getState(true);
    const m = req.body.mandateId !== undefined ? s.mandates[req.body.mandateId] : [...s.mandates].reverse().find((x) => x.merchant.toLowerCase() === addressOf('cloudtool').toLowerCase());
    if (!m) throw new Error('No CloudTool mandate yet. Run `npm run setup` or create one.');
    return merchantCharge('cloudtool', m.id, Number(req.body.amountUsd), String(req.body.memo ?? 'charge'));
  }),
);
app.post(
  '/api/demo/agent',
  wrap(async (req) => {
    if (req.body.spike !== undefined) x402State.priceMultiplier = req.body.spike ? 25 : 1;
    const s = await getState(true);
    if (!findMandate(s, 'weather')) throw new Error('No WeatherAPI mandate yet. Run `npm run setup`.');
    return agent.runTask({ cities: req.body.cities, compromised: Boolean(req.body.compromised) });
  }),
);
app.post('/api/demo/price', wrap(async (req) => ((x402State.priceMultiplier = Number(req.body.multiplier) || 1), { priceUsd: merchants.weather.basePriceUsd * x402State.priceMultiplier })));

// ── Boot ─────────────────────────────────────────────────────────────────────
app.listen(config.port, async () => {
  console.log(`KillSwitch on ${config.publicUrl}  (dashboard: http://localhost:${config.port})`);
  console.log(`  chain   ${config.chain.name} (${config.chain.chainId}) · vault ${config.chain.vault ?? '— not set —'}`);
  console.log(`  streams ${config.quicknode.primary ? 'PRIMARY (poller off)' : 'backup poller ON'} · webhook ${config.publicUrl}/webhooks/quicknode`);
  console.log(`  voice   ${voiceEnabled() ? 'ElevenLabs on' : 'off (set ELEVENLABS_API_KEY)'}`);
  if (!config.chain.vault) return;
  if (!config.quicknode.primary) startPoller(hub, { intervalMs: config.chain.pollMs });
  try {
    const s = await getState(true);
    console.log(`  balance $${s.balanceUsd.toFixed(2)} · ${s.mandates.length} mandates`);
  } catch (e) {
    console.warn('  could not read vault:', e.shortMessage ?? e.message);
  }
});

