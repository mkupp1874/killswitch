// The AI payment agent's decision loop for paid APIs (x402).
//
//   1. REQUEST   call the API; if it answers 402, read the quote (payTo, amount, asset)
//   2. MATCH     find an active, unexpired mandate for payTo that allows agent payments
//   3. JUDGE     off-chain guardrails: quote <= mandate per-charge cap, no price spike vs. the
//                first quote seen for that resource, stays inside this task's budget
//   4. PREFLIGHT vault.preview(): ask the chain whether this exact payment would pass
//   5. PAY       vault.pay(): the vault enforces caps and expiry synchronously; nothing else moves money
//   6. PROVE     retry the request with X-PAYMENT = the Arc tx hash; the API verifies it on-chain
//
// Steps 2–4 are the agent being polite. Step 5 is the wall. In "compromised" mode the agent skips 2–4
// (as a prompt-injected agent would) and the vault still blocks the overpayment on-chain.
import { BLOCK_REASONS, fromUsd, preview, readState, toUsd, vaultWrite } from './chain.js';
import { config } from './config.js';

export class PaymentAgent {
  constructor({ baseUrl, broadcast, alerts }) {
    this.baseUrl = baseUrl;
    this.broadcast = broadcast;
    this.alerts = alerts;
    this.firstQuote = new Map(); // resource path -> first quoted price (USD)
    this.running = false;
  }

  log(task, step, detail, ok = true) {
    const entry = { task, step, detail, ok, at: Date.now() };
    this.broadcast('agent', entry);
    console.log(`[agent] ${step.padEnd(9)} ${ok ? '✓' : '✗'} ${detail}`);
    return entry;
  }

  async runTask({ cities = ['West Lafayette', 'Chicago', 'Indianapolis'], compromised = false } = {}) {
    if (this.running) throw new Error('agent is already running a task');
    this.running = true;
    const task = `task-${Date.now()}`;
    let spent = 0;
    const results = [];
    try {
      this.log(task, 'START', `Fetch forecasts for ${cities.join(', ')} · budget $${config.agent.taskBudgetUsd.toFixed(2)}${compromised ? ' · ⚠ compromised mode: off-chain checks skipped' : ''}`);
      for (const city of cities) {
        const r = await this.payForResource(task, `/x402/weather?city=${encodeURIComponent(city)}`, { compromised, spent });
        if (r.paidUsd) spent += r.paidUsd;
        results.push({ city, ...r });
        if (r.stop) break;
      }
      this.log(task, 'DONE', `Spent $${spent.toFixed(2)} on ${results.filter((r) => r.data).length} paid calls`);
      return { task, spent, results };
    } finally {
      this.running = false;
    }
  }

  async payForResource(task, pathAndQuery, { compromised, spent }) {
    const url = `${this.baseUrl}${pathAndQuery}`;
    const resKey = pathAndQuery.split('?')[0];

    // 1. REQUEST
    let res = await fetch(url);
    if (res.status !== 402) return { data: await res.json(), paidUsd: 0 };
    const quote = (await res.json()).accepts[0];
    const quoteUsd = toUsd(BigInt(quote.maxAmountRequired));
    this.log(task, 'REQUEST', `${resKey} → 402 Payment Required: $${quoteUsd.toFixed(2)} to ${quote.extra?.name ?? quote.payTo}`);

    // 2. MATCH
    const state = await readState();
    const mandate = state.mandates.find(
      (m) => m.merchant.toLowerCase() === quote.payTo.toLowerCase() && m.agentCanPay && (compromised || (m.active && !m.expired)),
    );
    if (!mandate) {
      this.log(task, 'MATCH', `No live mandate for ${quote.extra?.name}. Asking the user instead of paying.`, false);
      await this.alerts.push({ kind: 'agent', severity: 'medium', title: `Agent needs permission · ${quote.extra?.name}`, text: `Your agent wants to pay ${quote.extra?.name}, but you haven't given it a budget there. It stopped and is waiting for you.`, actions: ['dismiss'] });
      return { stop: true, refused: 'no-mandate' };
    }
    this.log(task, 'MATCH', `Mandate #${mandate.id} "${mandate.label}": $${mandate.capPerChargeUsd} per call, $${(mandate.totalCapUsd - mandate.spentUsd).toFixed(2)} left`);

    if (!compromised) {
      // 3. JUDGE
      if (!this.firstQuote.has(resKey)) this.firstQuote.set(resKey, quoteUsd);
      const baseline = this.firstQuote.get(resKey);
      const problems = [];
      if (quoteUsd > mandate.capPerChargeUsd) problems.push(`quote $${quoteUsd} is over the $${mandate.capPerChargeUsd} per-call cap`);
      if (quoteUsd > baseline * config.agent.priceSpikeMultiple) problems.push(`price spiked ${(quoteUsd / baseline).toFixed(0)}× from $${baseline}`);
      if (spent + quoteUsd > config.agent.taskBudgetUsd + 1e-9) problems.push(`would exceed this task's $${config.agent.taskBudgetUsd} budget`);
      if (problems.length) {
        this.log(task, 'JUDGE', `Refused: ${problems.join('; ')}`, false);
        await this.alerts.push({
          kind: 'agent',
          severity: 'high',
          title: `Agent refused $${quoteUsd.toFixed(2)} · ${quote.extra?.name}`,
          text: `Your agent refused to pay ${quote.extra?.name}. The price jumped from ${Math.round(baseline * 100)} cents to ${Math.round(quoteUsd * 100)} cents a call. Nothing was paid. Say kill to cut them off.`,
          mandateId: mandate.id,
          actions: ['kill', 'dismiss'],
        });
        return { stop: true, refused: 'judge' };
      }
      this.log(task, 'JUDGE', `Quote OK (baseline $${baseline}, budget used $${spent.toFixed(2)}/$${config.agent.taskBudgetUsd})`);

      // 4. PREFLIGHT
      const pf = await preview(mandate.id, fromUsd(quoteUsd));
      if (pf.reason !== 'None' || pf.wouldHold) {
        this.log(task, 'PREFLIGHT', `Vault would ${pf.wouldHold ? 'hold' : `block (${pf.reason})`}. Not sending.`, false);
        return { stop: true, refused: 'preflight' };
      }
      this.log(task, 'PREFLIGHT', 'vault.preview() → would settle');
    }

    // 5. PAY
    const pay = await vaultWrite('agent', 'pay', [BigInt(mandate.id), fromUsd(quoteUsd), 'API call']);
    const outcome = pay.events.find((e) => ['ChargeSettled', 'ChargeBlocked', 'ChargeHeld'].includes(e.eventName));
    if (outcome?.eventName !== 'ChargeSettled') {
      this.log(task, 'PAY', `Vault ${outcome?.eventName === 'ChargeHeld' ? 'HELD' : 'BLOCKED'} the payment on-chain${outcome?.args?.reason !== undefined ? ` (${BLOCK_REASONS[outcome.args.reason]})` : ''}. No USDC moved. tx ${pay.hash.slice(0, 10)}…`, false);
      return { stop: true, refused: 'vault', txHash: pay.hash };
    }
    this.log(task, 'PAY', `Paid $${quoteUsd.toFixed(2)} on Arc · tx ${pay.hash.slice(0, 10)}…`);

    // 6. PROVE
    const proof = Buffer.from(
      JSON.stringify({ x402Version: 1, scheme: 'killswitch-vault', network: 'arc-testnet', payload: { txHash: pay.hash, mandateId: mandate.id } }),
    ).toString('base64');
    res = await fetch(url, { headers: { 'X-PAYMENT': proof } });
    if (!res.ok) {
      this.log(task, 'PROVE', `API rejected proof: ${(await res.json()).error}`, false);
      return { stop: true, paidUsd: quoteUsd, txHash: pay.hash };
    }
    const data = await res.json();
    this.log(task, 'PROVE', `200 OK → ${data.city}: ${data.tempF}°F, ${data.precipChance}% rain`);
    return { data, paidUsd: quoteUsd, txHash: pay.hash };
  }
}
