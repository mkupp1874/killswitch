# Devpost submission: KillSwitch

**Project name:** KillSwitch
**Tagline:** Give subscriptions and AI agents a leash, not your card.
**Main track:** Agentic Payments and AI
**Chain award:** Best use of Arc
**Bounties:** QuickNode Streams, ElevenLabs
**Team:** _(add names)_
**Repo:** _(GitHub URL)_ · **Demo video:** _(YouTube / Drive link, 2–3 min, set to "anyone with the link")_
**Contract (Arc Testnet):** `KillSwitchVault` at `0x…` _(fill in after deploy)_

---

### What did you build?
KillSwitch is a USDC spending firewall on Arc for people and their AI agents. Instead of giving a SaaS trial, an API, or your own agent an open card or an unlimited token allowance, you grant a **mandate**: a per-merchant permission with a per-charge cap, a total cap, an expiry, and an optional "ask me above $X" threshold. A vault contract enforces every charge synchronously on-chain. Blocked attempts are recorded as events, QuickNode Streams delivers them in real time, and ElevenLabs speaks the alert ("Blocked a $29 renewal from CloudTool. Your trial cap was $15.") so you can approve or kill it with one tap or one word.

### What problem does it solve?
Forgotten free trials and surprise auto-renewals. Every one of us has been charged for something we meant to cancel. Cards and ERC-20 `approve()` share the same flaw: access is open-ended, and you find out after the money is gone. AI agents that pay per request for APIs, MCP tools, and compute (x402) make it worse: they can be prompt-injected, loop, or accept a quote that silently jumped 25×. KillSwitch gives both humans and agents bounded, revocable spending power.

### How does it work?
- **KillSwitchVault (Solidity, Arc Testnet).** Holds the user's USDC. Merchants pull with `charge()`, the AI agent pushes with `pay()`. Both are checked against the mandate *before* USDC moves. Violations don't revert: they emit `ChargeBlocked(reason)` and return false, so the attempt is a permanent on-chain fact. Charges above the ask-first threshold emit `ChargeHeld` and wait for the owner's `approvePending()`. The agent can kill and reject but can never approve, extend, or withdraw, and any mandate it grants itself is capped by an owner-set ceiling.
- **AI payment agent (x402).** Requests an API, receives `402 Payment Required`, matches the quote to a mandate, applies off-chain guardrails (per-call cap, price-spike detection, task budget), preflights with `vault.preview()`, pays via `vault.pay()`, and retries with an `X-PAYMENT` proof that the API verifies on Arc.
- **QuickNode Streams.** An Arc Testnet stream (Block with Receipts) with a filter that forwards only our vault's events to a signed webhook. In demo mode alerts come only from Streams.
- **ElevenLabs.** TTS speaks every blocked/held charge; Scribe STT turns "approve" / "kill it" / "pause the agent" into vault transactions.
- **Dashboard.** Plain dollars and big Kill buttons; tx hashes live in a Receipts drawer.

### What makes it unique?
1. **It doesn't race.** Most "alert" products react after the fact. KillSwitch enforces on-chain first and uses Streams only for the human loop, so even a delayed alert never means lost money.
2. **Blocked attempts are provable.** A rejected charge is an event on Arc, not a silent decline. Disputes and merchant reputation can be built on that record.
3. **One firewall for humans *and* agents.** The same mandate stops a SaaS renewal and a prompt-injected agent's overpayment. Our "Hijacked agent" demo skips the agent's own checks and the vault still blocks it.
4. **Voice is a control surface, not a read-out.** You can kill a subscription by saying so.
5. **Arc makes it practical:** USDC-denominated gas for every actor, and sub-second finality for an approve-by-voice loop and for per-request x402 payments.

### What would you build next?
Circle Wallets with passkeys for the owner (replacing the demo's server-held key), a vault factory, x402 `exact`-scheme support via EIP-3009 / Circle Gateway, a merchant SDK that calls `preview()` before charging, and a browser extension that offers "grant a mandate" wherever a site asks for a card.

### Technologies / sponsor tools used
Arc Testnet (USDC as gas, USDC ERC-20 at `0x3600…0000`), Foundry, Solidity 0.8.24, viem, Node.js/Express, **QuickNode Streams** (Arc Testnet, Block with Receipts, JS filter, HMAC-signed webhook), **ElevenLabs** (TTS `eleven_flash_v2_5`, Speech-to-Text `scribe_v1`), x402 payment-required flow, Circle testnet faucet.

### Track-specific requirements checklist
- [x] Agents execute on-chain transactions (`vault.pay`, `createMandate`, `kill`) on Arc Testnet
- [x] Agent decision loop + safety limits documented (README → "The agent's decision loop and safety limits")
- [x] Arc: core functionality on Arc, contract address + explanation in README
- [x] QuickNode: Stream with filter + webhook destination; README explains network, dataset, filter logic, destination, and why
- [x] ElevenLabs: TTS + STT as core features; README lists products; demo video shows audio
- [x] Public GitHub repo with setup instructions and architecture overview
