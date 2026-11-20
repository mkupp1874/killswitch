// KillSwitch dashboard. Dollars up front, chain details tucked into "Receipts".
const $ = (s) => document.querySelector(s);
const state = { s: null, events: [], alerts: [], skew: 0, soundOn: false, voiceOn: false };

const money = (n) => (n >= 1 || n === 0 ? `$${n.toFixed(2)}` : `${Math.round(n * 100)}¢`);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const REASONS = { Killed: 'killed by you', Expired: 'trial expired', OverPerChargeCap: 'over per-charge cap', OverTotalCap: 'over total limit', MaxChargesReached: 'charge limit reached', NotMerchant: 'wrong merchant', NotAgent: 'not your agent', InsufficientFunds: 'not enough funds' };
const chainNow = () => Date.now() / 1000 + state.skew;
const label = (id) => state.s?.mandates?.[id]?.label?.replace(/\s*\(.*\)/, '') ?? `#${id}`;

function dur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${err ? ' err' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), 3500);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Sound: ElevenLabs mp3s, with browser speech only as a labelled fallback ──
const audioQueue = [];
let playing = false;
function enqueueAudio(src, text, alertId) {
  if (!state.soundOn) return;
  audioQueue.push({ src, text, alertId });
  if (!playing) playNext();
}
function setSpeaking(id, on) {
  const el = id && document.querySelector(`[data-alert="${id}"] .speak-ind`);
  if (el) el.classList.toggle('hidden', !on);
}
function playNext() {
  const item = audioQueue.shift();
  if (!item) return void (playing = false);
  playing = true;
  setSpeaking(item.alertId, true);
  const done = () => (setSpeaking(item.alertId, false), playNext());
  if (item.src) {
    const a = new Audio(item.src);
    a.onended = done;
    a.onerror = done;
    a.play().catch(done);
  } else if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(item.text);
    u.onend = done;
    speechSynthesis.speak(u);
  } else done();
}
document.addEventListener('click', () => (state.soundOn = true), { once: true });

// ── Render ──────────────────────────────────────────────────────────────────
function renderChips() {
  const s = state.s;
  if (!s) return;
  const st = s.integrations.streams;
  const chips = [
    `<span class="chip on"><b>${esc(s.chain.name)}</b> · USDC</span>`,
    `<span class="chip ${st.streamsDeliveries ? 'on' : 'off'}">QuickNode Streams · <b>${st.primary ? 'primary' : 'with backup poller'}</b> · ${st.streamsDeliveries} deliveries</span>`,
    `<span class="chip ${s.integrations.voice ? 'on' : 'off'}">ElevenLabs voice · <b>${s.integrations.voice ? 'on' : 'off'}</b></span>`,
    `<span class="chip">x402 price · <b>${money(s.integrations.x402PriceUsd)}</b>/call</span>`,
    `<span class="chip ${state.soundOn ? 'on' : 'off'}">${state.soundOn ? 'Sound on' : 'Click anywhere to enable sound'}</span>`,
  ];
  $('#chips').innerHTML = chips.join('');
}

function renderMandates() {
  const s = state.s;
  if (!s) return;
  $('#balance').textContent = money(s.balanceUsd);
  const list = [...s.mandates].reverse();
  if (!list.length) return void ($('#mandates').innerHTML = '<div class="empty">No permissions yet. Nothing can charge you.</div>');
  $('#mandates').innerHTML = list
    .map((m) => {
      const left = m.expiresAt - chainNow();
      const status = !m.active ? 'killed' : left <= 0 ? 'expired' : 'live';
      const pct = Math.min(100, (m.spentUsd / m.totalCapUsd) * 100);
      const pendingHere = s.pending.filter((p) => p.mandateId === m.id && p.status === 'Open').length;
      return `<div class="card mandate ${status !== 'live' ? 'dead' : ''}">
        <div class="m-top">
          <div><div class="m-name">${esc(m.label)}</div><div class="m-sub">${m.agentCanPay ? 'Your AI agent can pay this' : 'Merchant can charge this'}${pendingHere ? ` · <b style="color:var(--amber)">${pendingHere} waiting</b>` : ''}</div></div>
          <span class="pill ${status}">${status === 'live' ? 'Live' : status === 'expired' ? 'Expired' : 'Killed'}</span>
        </div>
        <div class="meter ${pct > 75 ? 'hot' : ''}"><div style="width:${pct}%"></div></div>
        <div class="m-nums"><span>${money(m.spentUsd)} used</span><span>${money(m.totalCapUsd)} limit</span></div>
        <div class="m-rules">
          <span>Max per charge</span><b>${money(m.capPerChargeUsd)}</b>
          <span>Ask me above</span><b>${m.askAboveUsd ? money(m.askAboveUsd) : 'never'}</b>
          <span>${status === 'expired' ? 'Ended' : 'Ends in'}</span><b class="countdown" data-exp="${m.expiresAt}">${status === 'expired' ? `${dur(-left)} ago` : dur(left)}</b>
          <span>Charges</span><b>${m.charges}${m.maxCharges ? ` / ${m.maxCharges}` : ''}</b>
        </div>
        ${m.active ? `<div class="m-actions"><button class="kill" data-kill="${m.id}">Kill</button><button class="ghost small" data-extend="${m.id}" title="Extend 7 days">+7d</button></div>` : ''}
      </div>`;
    })
    .join('');
}

function tickCountdowns() {
  for (const el of document.querySelectorAll('.countdown')) {
    const left = Number(el.dataset.exp) - chainNow();
    el.textContent = left > 0 ? dur(left) : `${dur(-left)} ago`;
  }
  // flip a mandate to "Expired" the moment it lapses
  if (state.s?.mandates.some((m) => m.active && !m.expired && m.expiresAt < chainNow())) {
    state.s.mandates.forEach((m) => (m.expired = m.expiresAt < chainNow()));
    renderMandates();
  }
}

function viaBadge(sources = []) {
  if (sources.includes('quicknode-streams')) return '<span class="via qn" title="Delivered by QuickNode Streams webhook">via QuickNode Streams</span>';
  if (sources.length) return '<span class="via" title="Backup eth_getLogs poller">via RPC poll</span>';
  return '<span class="via">agent check</span>';
}

function renderAlerts() {
  const live = state.alerts.filter((a) => !a.dismissed).slice(0, 4);
  if (!live.length) return void ($('#alerts').innerHTML = '<div class="empty">All quiet. Every charge is inside your rules.</div>');
  const ev = (a) => state.events.find((e) => e.key === a.eventKey);
  $('#alerts').innerHTML = live
    .map((a) => {
      const pendingOpen = a.pendingId !== undefined && state.s?.pending?.[a.pendingId]?.status === 'Open';
      const resolved = a.kind === 'held' && !pendingOpen;
      const kindLabel = { blocked: 'Blocked on-chain', held: 'Needs your OK', agent: 'Agent stopped itself', killed: 'Killed' }[a.kind];
      const btns = [];
      if (a.kind === 'held' && pendingOpen) btns.push(`<button class="approve" data-approve="${a.pendingId}">Approve</button>`, `<button class="kill" data-reject="${a.pendingId}">Kill it</button>`);
      if ((a.kind === 'blocked' || a.kind === 'agent') && a.mandateId !== undefined && state.s?.mandates?.[a.mandateId]?.active) btns.push(`<button class="kill" data-kill="${a.mandateId}">Kill ${esc(label(a.mandateId))}</button>`);
      btns.push(`<button class="ghost small" data-replay="${a.id}" title="Play again">▶ ${a.audioUrl ? 'Replay' : 'Speak'}</button>`, `<button class="ghost small" data-dismiss="${a.id}">Dismiss</button>`);
      return `<div class="alert ${a.kind} ${a.severity}" data-alert="${a.id}">
        <div class="a-top"><span class="a-kind">${kindLabel}${resolved ? ' · resolved' : ''}</span><span class="speak-ind hidden speaking"><i></i><i></i><i></i></span></div>
        <div class="a-title">${esc(a.title)}</div>
        <p class="a-text">${esc(a.text)}</p>
        <div class="a-actions">${btns.join('')}
          <span class="a-meta">${viaBadge(ev(a)?.sources ?? (a.via ? [a.via] : []))}${a.txUrl ? `<a href="${a.txUrl}" target="_blank" rel="noopener">tx</a>` : ''}</span>
        </div>
      </div>`;
    })
    .join('');
}

function describe(e) {
  const a = e.args;
  switch (e.name) {
    case 'ChargeSettled': return { dot: 'settled', what: `Paid ${esc(label(a.mandateId))}${a.memo ? ` · ${esc(a.memo)}` : ''}${a.viaAgent ? ' · by agent' : ''}`, amt: money(a.amount) };
    case 'ChargeBlocked': return { dot: 'blocked', what: `Blocked ${esc(label(a.mandateId))} · ${esc(REASONS[a.reason] ?? a.reason)}`, amt: money(a.amount), neg: true };
    case 'ChargeHeld': return { dot: 'held', what: `Held for approval · ${esc(label(a.mandateId))}`, amt: money(a.amount) };
    case 'PendingResolved': return { dot: a.approved ? 'settled' : 'blocked', what: `You ${a.approved ? 'approved' : 'rejected'} a held charge · ${esc(label(a.mandateId))}` };
    case 'MandateCreated': return { dot: '', what: `Granted ${esc(a.label)} · ${money(a.capPerCharge)} max${a.createdBy?.toLowerCase() === state.s?.agent?.toLowerCase() ? ' · by agent' : ''}` };
    case 'MandateKilled': return { dot: 'blocked', what: `Killed ${esc(label(a.id))}` };
    case 'MandateExtended': return { dot: '', what: `Extended ${esc(label(a.id))}` };
    case 'Deposited': return { dot: 'settled', what: 'Added funds', amt: money(a.amount / 1) };
    default: return { dot: '', what: e.name };
  }
}

function renderFeed() {
  $('#feed').innerHTML = state.events
    .slice(0, 40)
    .map((e) => {
      const d = describe(e);
      return `<li><span class="dot ${d.dot}"></span><span class="what">${d.what}</span>${d.amt ? `<span class="amt ${d.neg ? 'neg' : ''}">${d.amt}</span>` : ''}${viaBadge(e.sources)}</li>`;
    })
    .join('') || '<li class="muted">No activity yet.</li>';
}

function renderReceipts() {
  const s = state.s;
  if (!s) return;
  $('#receiptsBody').innerHTML = `
    <div class="kv">
      <span>Network</span><b>${esc(s.chain.name)} (chain ${s.chain.id})</b>
      <span>Vault contract</span><a class="mono" href="${s.vaultUrl}" target="_blank">${s.vault}</a>
      <span>Your wallet</span><code>${s.owner}</code>
      <span>AI agent</span><code>${s.agent}</code>
      <span>Agent ceiling</span><b>${money(s.agentMaxCapUsd)} per charge on any permission it grants itself</b>
      <span>Streams webhook</span><code>/webhooks/quicknode · ${s.integrations.streams.signed ? 'HMAC verified' : 'unsigned (set QN_STREAM_SECRET)'}</code>
      <span>Deliveries</span><b>${s.integrations.streams['quicknode-streams']} events via Streams · ${s.integrations.streams['rpc-poller']} via poller</b>
    </div>
    <table class="log">${state.events
      .map((e) => `<tr><td>${esc(e.name)}</td><td class="mono">${esc(JSON.stringify(e.args))}</td><td><a href="${e.txUrl}" target="_blank">${short(e.txHash)}</a><br/><small>${e.sources.join(', ')}</small></td></tr>`)
      .join('')}</table>`;
}

function renderAll() {
  renderChips();
  renderMandates();
  renderAlerts();
  renderFeed();
  if (!$('#receipts').classList.contains('hidden')) renderReceipts();
}

async function refresh() {
  const s = await api('/api/state');
  state.s = s;
  state.skew = s.chainTime - Date.now() / 1000;
  renderAll();
}

// ── Live updates ────────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('state', (m) => {
    const s = JSON.parse(m.data);
    state.s = { ...state.s, ...s };
    state.skew = s.chainTime - Date.now() / 1000;
    renderAll();
  });
  es.addEventListener('event', (m) => {
    state.events.unshift(JSON.parse(m.data));
    renderFeed();
    renderChips();
  });
  es.addEventListener('event-update', (m) => {
    const e = JSON.parse(m.data);
    const i = state.events.findIndex((x) => x.key === e.key);
    if (i >= 0) state.events[i] = e;
    renderFeed();
    renderAlerts();
  });
  es.addEventListener('alert', (m) => {
    const a = JSON.parse(m.data);
    state.alerts.unshift(a);
    renderAlerts();
    if (!state.s?.integrations.voice) enqueueAudio(null, a.text, a.id);
  });
  es.addEventListener('alert-audio', (m) => {
    const { id, audioUrl } = JSON.parse(m.data);
    const a = state.alerts.find((x) => x.id === id);
    if (a) a.audioUrl = audioUrl;
    enqueueAudio(audioUrl, a?.text, id);
  });
  es.addEventListener('agent', (m) => {
    const e = JSON.parse(m.data);
    const ol = $('#agentLog');
    if (e.step === 'START') ol.innerHTML = '';
    ol.insertAdjacentHTML('beforeend', `<li class="${e.ok ? 'ok' : 'bad'}"><span class="step">${e.step}</span><span class="d">${esc(e.detail)}</span></li>`);
    ol.scrollTop = ol.scrollHeight;
    $('#agentState').textContent = e.step === 'DONE' ? 'idle' : 'working';
    $('#agentState').className = `pill ${e.step === 'DONE' ? 'idle' : 'busy'}`;
  });
  es.addEventListener('command', (m) => {
    const c = JSON.parse(m.data);
    $('#heard').classList.remove('hidden');
    $('#heard').innerHTML = `Heard <b>"${esc(c.heard)}"</b> → ${esc(c.reply)}`;
    enqueueAudio(c.audioUrl, c.reply);
  });
  es.onerror = () => setTimeout(() => refresh().catch(() => {}), 1500);
}

// ── Actions ─────────────────────────────────────────────────────────────────
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.kill !== undefined) busy(b, async () => (await api(`/api/mandates/${d.kill}/kill`, {}), toast('Killed. That merchant is cut off.'), refresh()));
  if (d.extend !== undefined) busy(b, async () => (await api(`/api/mandates/${d.extend}/extend`, { expiresInSec: 7 * 86400 }), refresh()));
  if (d.approve !== undefined) busy(b, async () => (await api(`/api/pending/${d.approve}/approve`, {}), toast('Approved and paid.'), refresh()));
  if (d.reject !== undefined) busy(b, async () => (await api(`/api/pending/${d.reject}/reject`, { kill: true }), toast('Rejected and killed.'), refresh()));
  if (d.dismiss !== undefined) {
    const a = state.alerts.find((x) => x.id === d.dismiss);
    if (a) a.dismissed = true;
    renderAlerts();
  }
  if (d.replay !== undefined) {
    const a = state.alerts.find((x) => x.id === d.replay);
    state.soundOn = true;
    if (a) enqueueAudio(a.audioUrl, a.text, a.id);
  }
  if (d.charge !== undefined) busy(b, () => api('/api/demo/cloudtool', { amountUsd: Number(d.charge), memo: d.memo }).then((r) => toast(`CloudTool → ${r.outcome.replace('Charge', '')}`)));
  if (d.agent !== undefined) {
    const body = d.agent === 'normal' ? { spike: false } : d.agent === 'spike' ? { spike: true, cities: ['Chicago'] } : { spike: true, compromised: true, cities: ['Chicago'] };
    busy(b, () => api('/api/demo/agent', body).then(refresh));
  }
});

$('#newBtn').onclick = () => $('#newForm').classList.toggle('hidden');
$('#newForm').querySelector('[name=merchantKey]').onchange = (e) => {
  const f = $('#newForm');
  const api402 = e.target.value === 'weather';
  f.label.value = api402 ? 'WeatherAPI (x402)' : 'CloudTool trial';
  f.capPerChargeUsd.value = api402 ? 0.01 : 15;
  f.totalCapUsd.value = api402 ? 0.5 : 15;
  f.askAboveUsd.value = api402 ? 0 : 10;
  f.agentCanPay.checked = api402;
};
$('#newForm').onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = Object.fromEntries(f);
  body.agentCanPay = f.get('agentCanPay') === 'on';
  busy(e.target.querySelector('button'), async () => (await api('/api/mandates', body), toast('Permission granted.'), e.target.classList.add('hidden'), refresh()));
};
$('#receiptsBtn').onclick = () => ($('#receipts').classList.remove('hidden'), renderReceipts());
$('#closeReceipts').onclick = () => $('#receipts').classList.add('hidden');

const focusedAlertId = () => state.alerts.find((a) => !a.dismissed)?.id;
$('#cmdForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#cmdInput').value.trim();
  if (!text) return;
  $('#cmdInput').value = '';
  busy(null, () => api('/api/command', { text, alertId: focusedAlertId() }).then(refresh));
};

// Hold-to-talk → ElevenLabs Scribe on the server
let rec;
let chunks = [];
const mic = $('#micBtn');
async function startRec() {
  state.soundOn = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    rec = new MediaRecorder(stream);
    chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      mic.classList.remove('rec');
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (blob.size < 1200) return toast('Hold the mic while you talk.');
      const form = new FormData();
      form.append('audio', blob, 'command.webm');
      const id = focusedAlertId();
      if (id) form.append('alertId', id);
      $('#heard').classList.remove('hidden');
      $('#heard').textContent = 'Listening…';
      const res = await fetch('/api/voice', { method: 'POST', body: form });
      const j = await res.json();
      if (!res.ok) toast(j.error, true);
      refresh();
    };
    rec.start();
    mic.classList.add('rec');
  } catch (e) {
    toast(`Mic unavailable: ${e.message}`, true);
  }
}
const stopRec = () => rec?.state === 'recording' && rec.stop();
mic.addEventListener('pointerdown', startRec);
mic.addEventListener('pointerup', stopRec);
mic.addEventListener('pointerleave', stopRec);

// ── Boot ────────────────────────────────────────────────────────────────────
(async () => {
  await refresh().catch((e) => toast(e.message, true));
  const f = await api('/api/feed');
  state.events = f.events;
  state.alerts = f.alerts;
  renderAll();
  connect();
  setInterval(tickCountdowns, 1000);
  setInterval(() => refresh().catch(() => {}), 15000);
})();
