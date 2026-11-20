// Generates the four demo wallets (owner, agent, two merchants) and prints .env lines.
// Only the OWNER address needs testnet USDC from https://faucet.circle.com; `npm run setup` funds the rest.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const roles = [
  ['OWNER_PRIVATE_KEY', 'owner (the user\'s invisible app wallet, also deploys the vault)'],
  ['AGENT_PRIVATE_KEY', 'AI payment agent'],
  ['MERCHANT_CLOUDTOOL_KEY', 'demo SaaS merchant'],
  ['MERCHANT_WEATHER_KEY', 'demo x402 API merchant (receives only, never sends)'],
];
for (const [env, what] of roles) {
  const k = generatePrivateKey();
  console.log(`# ${what}: ${privateKeyToAccount(k).address}\n${env}=${k}`);
}
