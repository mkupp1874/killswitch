// QuickNode Streams filter for KillSwitch
// Network: Arc Testnet · Dataset: "Block with Receipts" · Destination: Webhook → https://<your-host>/webhooks/quicknode
//
// Paste this into the Stream's filter editor. Set VAULT to your deployed KillSwitchVault address (lowercase).
// It drops every block that has no KillSwitch firewall activity, and for the rest delivers only the vault's
// logs, tagged with a human-readable event name, so the app server gets exactly what it needs to
// speak an alert. The server decodes the full event from topics + data with the vault ABI.

const VAULT = '0xYOUR_VAULT_ADDRESS_LOWERCASE';

const TOPICS = {
  '0x0b5b18185c1bb6669335cac7a5c0347b4e645956a315cc4851306472f879d51f': 'ChargeBlocked',
  '0x9c0670c9c94f688c0fcb1edd75306207d16f677d901503b58776b62a91a5abfd': 'ChargeHeld',
  '0x26f54a21c9789eb6b05bb59760157911e24ba11d89d0422c300d37e8bad2b13a': 'ChargeSettled',
  '0x130ddcbde1d27b4399e448f41cb667a09358e86c61e943f1983212124fc37a73': 'PendingResolved',
  '0x8defa6a15fc571a00eb50fe3e6ea8aeeba3b7aa015f89021229747f53a899120': 'MandateKilled',
  '0x1ea4a6d0af06eac6c18407904f79c624b8cc1ff9fea52dcd59329f3e800fda50': 'MandateCreated',
  '0xb246e52c50197e59f08195b53f9da3c1cd94059b7d25eba8c0076bcb80c78301': 'MandateExtended',
};

// Events that should interrupt the user (voice alert); everything else is silent bookkeeping.
const LOUD = new Set(['ChargeBlocked', 'ChargeHeld']);

function main(stream) {
  const blocks = Array.isArray(stream.data) ? stream.data : [stream.data];
  const matches = [];
  for (const item of blocks) {
    if (!item) continue;
    const receipts = item.receipts || [];
    const blockNumber = item.block ? item.block.number : undefined;
    for (const receipt of receipts) {
      for (const log of receipt.logs || []) {
        if (!log.address || log.address.toLowerCase() !== VAULT) continue;
        const name = TOPICS[log.topics && log.topics[0]];
        if (!name) continue;
        matches.push({
          event: name,
          loud: LOUD.has(name),
          address: log.address,
          topics: log.topics,
          data: log.data,
          logIndex: log.logIndex,
          transactionHash: log.transactionHash || receipt.transactionHash,
          blockNumber: log.blockNumber || blockNumber,
        });
      }
    }
  }
  if (matches.length === 0) return null; // nothing delivered for this block
  return { vault: VAULT, count: matches.length, loud: matches.some((m) => m.loud), matches };
}
