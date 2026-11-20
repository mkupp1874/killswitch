# Demo video script (target 2:30, hard max 3:00)

**Before recording:** run on Arc Testnet with `QN_STREAMS_PRIMARY=true` and ElevenLabs on. Run `npm run setup` with `TRIAL_SECONDS=150` right before you hit record, so the trial expires mid-video. Record screen **with system audio** (the ElevenLabs voice must be audible). Click once on the page so sound is enabled.

---

**0:00–0:15 · Hook** (face cam or title slide)
> "Raise your hand if a free trial ever turned into a charge you forgot to cancel. Now imagine your AI agent doing that a thousand times a day. This is KillSwitch: a spending firewall on Arc for you and your agents."

**0:15–0:35 · The idea** (dashboard, point at the two permission cards)
> "Instead of a card on file, I grant mandates: CloudTool gets a $15 trial that asks me above $10 and expires on its own. My AI agent gets 1 cent per API call, 50 cents total. These rules live in a vault contract on Arc and are enforced before any USDC moves."

**0:35–1:00 · Ask-first + voice approve**
- Click **Charge $12 (ask first)**. The amber alert appears and the voice speaks.
- Hold the mic: **"approve."** The voice confirms and the feed shows "Paid".
> "That alert came from QuickNode Streams. See the badge. My 'approve' went through ElevenLabs speech-to-text and became an on-chain approval."

**1:00–1:20 · Surprise renewal blocked**
- Click **Surprise $29 renewal**. A red alert, and the voice says "Blocked $29… your cap is $15 per charge. Nothing left your wallet."
> "Notice the order. The contract blocked it first, then Streams told me. There's no race. The money never left."

**1:20–1:55 · The agent** (right column)
- Click **Run research task**. The decision log ticks: REQUEST → 402 → MATCH → JUDGE → PREFLIGHT → PAY → PROVE, three 1¢ payments.
> "This is x402. The API says 402 Payment Required, the agent checks the quote against its mandate, pays through the vault on Arc, and proves payment with the tx hash."
- Click **API hikes price 25×**. The agent refuses and the voice alerts.
- Click **Hijacked agent**.
> "Now the agent is prompt-injected and skips its own checks. It tries to pay 25 cents anyway, and the vault blocks it on-chain. Defense in depth."

**1:55–2:15 · Trial expiry + kill by voice**
- The CloudTool card flips to **Expired**. Click **Charge $3 usage**. Voice: "…your trial window closed 20 seconds ago."
- Hold the mic: **"kill CloudTool."** The card goes to Killed.

**2:15–2:30 · Receipts + close**
- Open **Receipts** to show the vault address on Arcscan and the events delivered via QuickNode Streams.
> "USDC is the gas, finality is sub-second, and every blocked attempt is provable on Arc. KillSwitch: give your subscriptions and your agents a leash, not your card."

---

## Live pitch (4 min + 2 min Q&A): likely judge questions
- **"Why not just Privacy.com?"** Virtual cards don't work for AI agents paying APIs per request, can't hold a charge for approval, and don't leave a verifiable record of blocked attempts. KillSwitch is one firewall for humans and agents.
- **"Isn't this just an ERC-20 allowance?"** An allowance is a single number with no expiry, no per-charge cap, no hold, and no record of rejected pulls. Ours enforces all of these and records every block.
- **"Streams fires after the fact. Isn't that too late?"** That's why enforcement is on-chain and synchronous. Streams drives only the human alert and override loop.
- **"Who holds the keys?"** For the demo, a server-held testnet key (no pop-ups). In production: Circle Wallets with passkeys. The agent key can never approve, extend, or withdraw.
- **"Why Arc?"** USDC as gas means merchants, agents, and users never touch a volatile token, and sub-second finality makes voice approval and per-request x402 feel instant.
