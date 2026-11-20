// Arc (EVM) access: one public client + one wallet per actor (owner, agent, merchants).
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config, ROOT } from './config.js';

export const VAULT_ABI = JSON.parse(fs.readFileSync(path.join(ROOT, 'abi', 'KillSwitchVault.json'), 'utf8')).abi;

export const BLOCK_REASONS = [
  'None',
  'Killed',
  'Expired',
  'OverPerChargeCap',
  'OverTotalCap',
  'MaxChargesReached',
  'NotMerchant',
  'NotAgent',
  'InsufficientFunds',
];
export const PENDING_STATUS = ['Open', 'Approved', 'Rejected'];

export const USDC = 1_000_000n;
export const toUsd = (v) => Number(v) / 1e6;
export const fromUsd = (usd) => BigInt(Math.round(Number(usd) * 1e6));

export const chain = defineChain({
  id: config.chain.chainId,
  name: config.chain.name,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [config.chain.rpcUrl] } },
  blockExplorers: { default: { name: 'Arcscan', url: config.chain.explorer } },
});

// Public RPCs rate-limit (HTTP 429). Batch JSON-RPC calls into one request and back off on errors.
const transport = () => http(config.chain.rpcUrl, { batch: { wait: 20 }, retryCount: 6, retryDelay: 400 });
export const publicClient = createPublicClient({ chain, transport: transport() });

const wallets = {};
export function wallet(role) {
  if (wallets[role]) return wallets[role];
  const key = config.keys[role];
  if (!key) throw new Error(`Missing private key for "${role}" (see .env.example)`);
  const account = privateKeyToAccount(key);
  wallets[role] = createWalletClient({ account, chain, transport: transport() });
  return wallets[role];
}
export const addressOf = (role) => (config.keys[role] ? privateKeyToAccount(config.keys[role]).address : null);

export const vaultAddress = () => {
  if (!config.chain.vault) throw new Error('VAULT_ADDRESS not set (run `npm run local` or deploy to Arc)');
  return config.chain.vault;
};

export const txUrl = (hash) => `${config.chain.explorer}/tx/${hash}`;
export const addrUrl = (a) => `${config.chain.explorer}/address/${a}`;

// One in-flight tx per wallet, so concurrent clicks never collide on a nonce.
const queues = {};
export function vaultWrite(role, functionName, args) {
  const prev = queues[role] ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => sendVaultTx(role, functionName, args));
  queues[role] = next;
  return next;
}

/** Send a vault tx as `role`, wait for the receipt, return decoded vault events. */
async function sendVaultTx(role, functionName, args) {
  const w = wallet(role);
  const hash = await w.writeContract({ address: vaultAddress(), abi: VAULT_ABI, functionName, args, account: w.account });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const events = decodeVaultLogs(receipt.logs);
  return { hash, receipt, events, status: receipt.status };
}

export function decodeVaultLogs(logs) {
  const mine = logs.filter((l) => l.address?.toLowerCase() === vaultAddress().toLowerCase());
  return parseEventLogs({ abi: VAULT_ABI, logs: mine, strict: false });
}

const read = (functionName, args = []) => publicClient.readContract({ address: vaultAddress(), abi: VAULT_ABI, functionName, args });

let inflight = null;
export function readState() {
  inflight ??= readStateOnce().finally(() => (inflight = null));
  return inflight;
}

async function readStateOnce() {
  const [balance, mCount, pCount, owner, agent, agentCap] = await Promise.all([
    read('balance'),
    read('mandateCount'),
    read('pendingCount'),
    read('owner'),
    read('agent'),
    read('agentMaxCapPerCharge'),
  ]);
  const mandates = await Promise.all([...Array(Number(mCount)).keys()].map((i) => read('getMandate', [BigInt(i)])));
  const pending = await Promise.all([...Array(Number(pCount)).keys()].map((i) => read('getPending', [BigInt(i)])));
  const block = await publicClient.getBlock();
  // Last block time can lag on a quiet chain; never compute expiries from a stale clock.
  const now = Math.max(Number(block.timestamp), Math.floor(Date.now() / 1000));
  return {
    vault: vaultAddress(),
    vaultUrl: addrUrl(vaultAddress()),
    chain: { name: config.chain.name, id: config.chain.chainId, explorer: config.chain.explorer },
    chainTime: now,
    balanceUsd: toUsd(balance),
    owner,
    agent,
    agentMaxCapUsd: toUsd(agentCap),
    mandates: mandates.map((m, id) => ({
      id,
      label: m.label,
      merchant: m.merchant,
      capPerChargeUsd: toUsd(m.capPerCharge),
      totalCapUsd: toUsd(m.totalCap),
      spentUsd: toUsd(m.spent),
      askAboveUsd: toUsd(m.askAbove),
      expiresAt: Number(m.expiresAt),
      expired: now > Number(m.expiresAt),
      maxCharges: Number(m.maxCharges),
      charges: Number(m.charges),
      active: m.active,
      agentCanPay: m.agentCanPay,
    })),
    pending: pending.map((p, id) => ({
      id,
      mandateId: Number(p.mandateId),
      amountUsd: toUsd(p.amount),
      createdAt: Number(p.createdAt),
      status: PENDING_STATUS[p.status],
      memo: p.memo,
    })),
  };
}

export async function preview(mandateId, amount) {
  const [reason, wouldHold] = await read('preview', [BigInt(mandateId), amount]);
  return { reason: BLOCK_REASONS[reason], wouldHold };
}
