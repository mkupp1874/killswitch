// Turns on-chain firewall events into short, human alerts, and voices them with ElevenLabs.
import { speak } from './voice.js';

const usd = (n) => {
  if (n >= 1) return `$${Number(n).toFixed(n % 1 ? 2 : 0)}`;
  const c = Math.round(n * 100);
  return `${c} cent${c === 1 ? '' : 's'}`;
};

function ago(seconds) {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)} hours ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

export function merchantName(m) {
  return m?.label?.replace(/\s*\(.*\)\s*/g, '').replace(/\b(trial|subscription|budget)\b/gi, '').trim() || 'a merchant';
}

/** Compose the alert for an event, given current vault state. Returns null for events we stay quiet about. */
export function composeAlert(ev, state) {
  const mid = ev.args.mandateId ?? ev.args.id;
  const m = state.mandates.find((x) => x.id === mid);
  const name = merchantName(m);
  const amt = usd(ev.args.amount ?? 0);
  if (ev.name === 'ChargeBlocked') {
    const r = ev.args.reason;
    const why = {
      Expired: m ? `your trial window closed ${ago(state.chainTime - m.expiresAt)}` : 'that permission expired',
      OverPerChargeCap: m ? `your cap is ${usd(m.capPerChargeUsd)} per charge` : 'it was over your cap',
      OverTotalCap: m ? `that would pass your ${usd(m.totalCapUsd)} total limit` : 'it was over your total limit',
      Killed: 'you already killed that subscription',
      MaxChargesReached: 'it already used all of its allowed charges',
      NotMerchant: `the request came from an address that isn't ${name}`,
      NotAgent: "the request didn't come from your agent",
      InsufficientFunds: "there isn't enough in your wallet",
    }[r] ?? r;
    const subject = `${amt} from ${name}${ev.args.memo ? ` for ${ev.args.memo.toLowerCase()}` : ''}`;
    return {
      kind: 'blocked',
      severity: 'high',
      title: `Blocked ${amt} · ${name}`,
      text: `Blocked ${subject}. ${why[0].toUpperCase()}${why.slice(1)}. Nothing left your wallet.`,
      mandateId: mid,
      actions: m?.active ? ['kill', 'dismiss'] : ['dismiss'],
    };
  }
  if (ev.name === 'ChargeHeld') {
    return {
      kind: 'held',
      severity: 'medium',
      title: `Approve ${amt}? · ${name}`,
      text: `${name} wants ${amt} for ${ev.args.memo || 'a charge'}. That's above your ask-first limit. Say approve, or kill it.`,
      mandateId: mid,
      pendingId: ev.args.pendingId,
      actions: ['approve', 'kill'],
    };
  }
  if (ev.name === 'MandateKilled') {
    return {
      kind: 'killed',
      severity: 'low',
      title: `Killed · ${name}`,
      text: `Done. ${name} can't charge you anymore.`,
      mandateId: mid,
      actions: [],
    };
  }
  return null;
}

export class Alerts {
  constructor({ getState, broadcast }) {
    this.getState = getState;
    this.broadcast = broadcast;
    this.list = [];
    this.n = 0;
  }

  async onEvent(ev) {
    const state = await this.getState();
    const a = composeAlert(ev, state);
    if (!a) return null;
    return this.push({ ...a, eventKey: ev.key, txHash: ev.txHash, txUrl: ev.txUrl, via: ev.sources[0] });
  }

  /** Alerts can also come from the agent's own off-chain checks (e.g. a 402 price spike it refused). */
  async push(a) {
    const id = `alert-${Date.now()}-${++this.n}`;
    const alert = { id, at: Date.now(), audioUrl: null, voiceError: null, ...a };
    this.list.unshift(alert);
    this.list = this.list.slice(0, 50);
    this.broadcast('alert', alert);
    try {
      alert.audioUrl = await speak(alert.text, id);
      if (alert.audioUrl) this.broadcast('alert-audio', { id, audioUrl: alert.audioUrl });
    } catch (e) {
      alert.voiceError = e.message;
      console.warn('[voice]', e.message);
    }
    return alert;
  }
}
