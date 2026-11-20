// The event hub: every vault event lands here, from QuickNode Streams (primary) or the RPC poller (backup).
// Events are de-duplicated by txHash:logIndex so a Streams delivery and a poll of the same log merge into one item.
import { EventEmitter } from 'node:events';
import { decodeEventLog } from 'viem';
import { BLOCK_REASONS, VAULT_ABI, publicClient, toUsd, txUrl, vaultAddress } from './chain.js';

export const SOURCES = { STREAMS: 'quicknode-streams', POLLER: 'rpc-poller' };

const USD_FIELDS = new Set(['amount', 'capPerCharge', 'totalCap', 'askAbove']);

function serializeArgs(args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'bigint') {
      out[k] = USD_FIELDS.has(k) ? toUsd(v) : Number(v);
    } else out[k] = v;
  }
  if (out.reason !== undefined) out.reason = BLOCK_REASONS[out.reason] ?? out.reason;
  return out;
}

const hexToNum = (v) => (typeof v === 'string' ? Number(BigInt(v)) : Number(v ?? 0));

export class EventHub extends EventEmitter {
  constructor() {
    super();
    this.items = new Map(); // key -> item
    this.order = [];
    this.stats = { [SOURCES.STREAMS]: 0, [SOURCES.POLLER]: 0, streamsDeliveries: 0, lastStreamsAt: null };
  }

  /** Ingest one raw EVM log. Returns the merged item (or null if not ours / undecodable). */
  ingestLog(log, source) {
    if (!log?.topics?.length || log.address?.toLowerCase() !== vaultAddress().toLowerCase()) return null;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: VAULT_ABI, topics: log.topics, data: log.data });
    } catch {
      return null;
    }
    const txHash = log.transactionHash;
    const logIndex = hexToNum(log.logIndex);
    const key = `${txHash}:${logIndex}`;
    const existing = this.items.get(key);
    if (existing) {
      if (!existing.sources.includes(source)) {
        existing.sources.push(source);
        existing.seenBy[source] = Date.now();
        this.stats[source]++;
        this.emit('update', existing);
      }
      return existing;
    }
    const item = {
      key,
      name: decoded.eventName,
      args: serializeArgs(decoded.args),
      txHash,
      txUrl: txUrl(txHash),
      blockNumber: hexToNum(log.blockNumber),
      logIndex,
      sources: [source],
      seenBy: { [source]: Date.now() },
      at: Date.now(),
    };
    this.items.set(key, item);
    this.order.push(key);
    this.stats[source]++;
    this.emit('event', item);
    return item;
  }

  recent(n = 100) {
    return this.order.slice(-n).map((k) => this.items.get(k)).reverse();
  }

  /** Is there an event of this name/tx already (used by x402 receipt verification)? */
  find(pred) {
    for (const k of this.order) {
      const it = this.items.get(k);
      if (pred(it)) return it;
    }
    return null;
  }
}

/**
 * Pull every EVM log out of a QuickNode Streams payload, whatever the dataset shape:
 * our filter's `{ matches: [...] }`, raw `block_with_receipts` (`[{ block, receipts: [{ logs }] }]`),
 * or a plain `logs` dataset. Carries the parent receipt's tx hash down to its logs.
 */
export function extractLogs(payload) {
  const logs = [];
  const walk = (node, ctx) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, ctx));
    if (Array.isArray(node.topics) && typeof node.data === 'string' && node.address) {
      logs.push({
        address: node.address,
        topics: node.topics,
        data: node.data,
        transactionHash: node.transactionHash ?? node.txHash ?? ctx.txHash,
        logIndex: node.logIndex ?? 0,
        blockNumber: node.blockNumber ?? ctx.blockNumber,
      });
      return;
    }
    const next = {
      txHash: node.transactionHash ?? node.txHash ?? ctx.txHash,
      blockNumber: node.blockNumber ?? node.number ?? ctx.blockNumber,
    };
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, next);
  };
  walk(payload, {});
  return logs;
}

/** Backup path: poll eth_getLogs for the vault. Disabled when Streams is primary. */
export function startPoller(hub, { intervalMs }) {
  let from = null;
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const head = await publicClient.getBlockNumber();
        if (from === null) from = head > 2000n ? head - 2000n : 0n; // short backfill on boot
        if (head >= from) {
          const logs = await publicClient.getLogs({ address: vaultAddress(), fromBlock: from, toBlock: head });
          for (const l of logs) hub.ingestLog(l, SOURCES.POLLER);
          from = head + 1n;
        }
      } catch (e) {
        console.warn('[poller]', e.shortMessage ?? e.message);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  loop();
  return () => (stopped = true);
}
