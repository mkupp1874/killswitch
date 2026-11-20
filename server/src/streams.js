// QuickNode Streams webhook destination.
// Signature: hex HMAC-SHA256(securityToken, X-QN-Nonce + X-QN-Timestamp + rawBody)
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import express from 'express';
import { config } from './config.js';
import { SOURCES, extractLogs } from './events.js';

export function verifyQuickNodeSignature(rawBody, headers, secret) {
  const nonce = headers['x-qn-nonce'];
  const ts = headers['x-qn-timestamp'];
  const sig = headers['x-qn-signature'];
  if (!nonce || !ts || !sig || !/^[0-9a-fA-F]{64}$/.test(sig)) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(nonce + ts, 'latin1'), rawBody]))
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig.toLowerCase(), 'hex'));
}

export function streamsRouter(hub) {
  const r = express.Router();
  r.post('/webhooks/quicknode', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
    let raw = req.body ?? Buffer.alloc(0);
    if (req.headers['content-encoding'] === 'gzip') {
      try {
        raw = zlib.gunzipSync(raw);
      } catch {
        return res.status(400).json({ error: 'bad gzip' });
      }
    }
    if (config.quicknode.secret && !verifyQuickNodeSignature(raw, req.headers, config.quicknode.secret)) {
      return res.status(401).json({ error: 'bad signature' });
    }
    let payload;
    try {
      payload = raw.length ? JSON.parse(raw.toString('utf8')) : null;
    } catch {
      return res.status(400).json({ error: 'bad json' });
    }
    hub.stats.streamsDeliveries++;
    hub.stats.lastStreamsAt = Date.now();
    const logs = extractLogs(payload);
    let accepted = 0;
    for (const l of logs) if (hub.ingestLog(l, SOURCES.STREAMS)) accepted++;
    res.json({ ok: true, logs: logs.length, accepted });
  });
  return r;
}
