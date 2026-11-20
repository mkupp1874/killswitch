import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

process.env.VAULT_ADDRESS ||= '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';
const { parseCommand } = await import('../src/voice.js');
const { composeAlert, merchantName } = await import('../src/alerts.js');
const { extractLogs } = await import('../src/events.js');
const { verifyQuickNodeSignature } = await import('../src/streams.js');

const mandates = [
  { id: 0, label: 'CloudTool trial', active: false },
  { id: 1, label: 'WeatherAPI (x402)', active: true },
  { id: 2, label: 'CloudTool trial', active: true },
];

test('voice: approve / kill / kill-all intents', () => {
  assert.equal(parseCommand('Yes, approve it', mandates).action, 'approve');
  assert.equal(parseCommand('kill it', mandates).action, 'kill');
  assert.equal(parseCommand('Block CloudTool!', mandates).target, 2, 'prefers the newest live mandate');
  assert.equal(parseCommand('no', mandates).action, 'kill');
  assert.equal(parseCommand('pause the agent', mandates).action, 'kill-all');
  assert.equal(parseCommand('what is the weather', mandates).action, 'unknown');
});

test('voice: "kill" wins over "approve" when both are heard (fail safe)', () => {
  assert.equal(parseCommand("don't approve, kill it", mandates).action, 'kill');
});

test('alerts: blocked renewal over cap', () => {
  const state = { chainTime: 1000, mandates: [{ id: 0, label: 'CloudTool trial', capPerChargeUsd: 15, totalCapUsd: 15, expiresAt: 900, active: true }] };
  const a = composeAlert({ name: 'ChargeBlocked', args: { mandateId: 0, amount: 29, reason: 'OverPerChargeCap', memo: 'Pro plan renewal' } }, state);
  assert.equal(a.kind, 'blocked');
  assert.match(a.text, /Blocked \$29 from CloudTool for pro plan renewal\. Your cap is \$15 per charge/);
});

test('alerts: blocked after trial expired says when', () => {
  const state = { chainTime: 1000 + 86400, mandates: [{ id: 0, label: 'CloudTool trial', capPerChargeUsd: 15, totalCapUsd: 15, expiresAt: 1000, active: true }] };
  const a = composeAlert({ name: 'ChargeBlocked', args: { mandateId: 0, amount: 29, reason: 'Expired', memo: 'auto-renewal' } }, state);
  assert.match(a.text, /trial window closed 24 hours ago/);
});

test('alerts: held charge offers approve + kill; settled is silent', () => {
  const state = { chainTime: 0, mandates: [{ id: 0, label: 'CloudTool trial' }] };
  const h = composeAlert({ name: 'ChargeHeld', args: { pendingId: 3, mandateId: 0, amount: 12, memo: 'first month' } }, state);
  assert.deepEqual(h.actions, ['approve', 'kill']);
  assert.equal(h.pendingId, 3);
  assert.equal(composeAlert({ name: 'ChargeSettled', args: { mandateId: 0, amount: 1 } }, state), null);
});

test('alerts: merchant names are cleaned', () => {
  assert.equal(merchantName({ label: 'WeatherAPI (x402)' }), 'WeatherAPI');
  assert.equal(merchantName({ label: 'CloudTool trial' }), 'CloudTool');
});

test('streams: extracts logs from filter output and raw block_with_receipts', () => {
  const log = { address: '0xabc', topics: ['0x1'], data: '0x', logIndex: '0x2' };
  assert.equal(extractLogs({ matches: [{ ...log, transactionHash: '0xt' }] }).length, 1);
  const raw = extractLogs({ data: [{ block: { number: '0x5' }, receipts: [{ transactionHash: '0xtx', logs: [log] }] }] });
  assert.equal(raw[0].transactionHash, '0xtx', 'tx hash inherited from receipt');
});

test('streams: HMAC signature verification', () => {
  const secret = 'x'.repeat(40);
  const body = Buffer.from('{"a":1}');
  const sig = crypto.createHmac('sha256', secret).update('n' + '123' + body).digest('hex');
  assert.ok(verifyQuickNodeSignature(body, { 'x-qn-nonce': 'n', 'x-qn-timestamp': '123', 'x-qn-signature': sig }, secret));
  assert.ok(!verifyQuickNodeSignature(body, { 'x-qn-nonce': 'n', 'x-qn-timestamp': '124', 'x-qn-signature': sig }, secret));
});
