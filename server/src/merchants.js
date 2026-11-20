// Demo merchants.
//  • CloudTool: a SaaS product that PULLS charges from a mandate (trial usage, sneaky auto-renewals).
//  • WeatherAPI: a pay-per-request API that speaks x402: it answers 402 Payment Required with a quote,
//    the agent pays through the vault, then retries with an X-PAYMENT proof (the Arc tx hash).
import express from 'express';
import { addressOf, decodeVaultLogs, fromUsd, publicClient, toUsd, vaultWrite } from './chain.js';
import { config } from './config.js';

export const merchants = {
  cloudtool: { key: 'cloudtool', name: 'CloudTool', kind: 'saas' },
  weather: { key: 'weather', name: 'WeatherAPI', kind: 'x402', basePriceUsd: 0.01 },
};

/** CloudTool (or any merchant wallet) tries to pull a charge from its mandate. */
export async function merchantCharge(merchantKey, mandateId, amountUsd, memo) {
  const r = await vaultWrite(merchantKey, 'charge', [BigInt(mandateId), fromUsd(amountUsd), memo]);
  return summarize(r);
}

export function summarize(r) {
  const ev = r.events.find((e) => ['ChargeSettled', 'ChargeBlocked', 'ChargeHeld'].includes(e.eventName));
  return { txHash: r.hash, outcome: ev?.eventName ?? 'unknown', events: r.events.map((e) => e.eventName) };
}

// ── x402 API ────────────────────────────────────────────────────────────────
const usedProofs = new Set();
export const x402State = { priceMultiplier: 1 };

export const quoteUsd = () => merchants.weather.basePriceUsd * x402State.priceMultiplier;

export function paymentRequirements(resource) {
  return {
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [
      {
        scheme: 'killswitch-vault',
        network: 'arc-testnet',
        asset: config.chain.usdc,
        maxAmountRequired: String(fromUsd(quoteUsd())), // USDC base units (6 decimals)
        payTo: addressOf('weather'),
        resource,
        description: 'Hyperlocal forecast, priced per request',
        mimeType: 'application/json',
        maxTimeoutSeconds: 60,
        extra: { name: 'WeatherAPI', settlement: 'Pay via KillSwitchVault.pay(mandateId, amount, memo) then retry with X-PAYMENT' },
      },
    ],
  };
}

/** Verify a payment proof against the chain itself (not our own event cache). */
export async function verifyPayment(header) {
  let proof;
  try {
    proof = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return { ok: false, error: 'malformed X-PAYMENT' };
  }
  const txHash = proof?.payload?.txHash;
  if (!txHash) return { ok: false, error: 'missing txHash' };
  if (usedProofs.has(txHash)) return { ok: false, error: 'payment already used' };
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt || receipt.status !== 'success') return { ok: false, error: 'tx not found or failed' };
  const settled = decodeVaultLogs(receipt.logs).find(
    (e) => e.eventName === 'ChargeSettled' && e.args.merchant.toLowerCase() === addressOf('weather').toLowerCase(),
  );
  if (!settled) return { ok: false, error: 'no settled vault payment to WeatherAPI in tx' };
  if (settled.args.amount < fromUsd(quoteUsd())) return { ok: false, error: 'underpaid' };
  usedProofs.add(txHash);
  return { ok: true, txHash, amountUsd: toUsd(settled.args.amount) };
}

function fakeForecast(city) {
  // Demo data. The point of the demo is the payment, not the meteorology.
  const seed = [...city].reduce((a, c) => a + c.charCodeAt(0), 0);
  return {
    city,
    tempF: 38 + (seed % 25),
    precipChance: (seed * 7) % 100,
    windMph: 3 + (seed % 17),
    source: 'WeatherAPI demo dataset',
  };
}

export function x402Router() {
  const r = express.Router();
  r.get('/x402/weather', async (req, res) => {
    const city = String(req.query.city || 'West Lafayette');
    const resource = `${config.publicUrl}/x402/weather?city=${encodeURIComponent(city)}`;
    const header = req.get('X-PAYMENT');
    if (!header) return res.status(402).json(paymentRequirements(resource));
    const v = await verifyPayment(header);
    if (!v.ok) return res.status(402).json({ ...paymentRequirements(resource), error: v.error });
    res.set('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ success: true, txHash: v.txHash, network: 'arc-testnet' })).toString('base64'));
    res.json(fakeForecast(city));
  });
  return r;
}
