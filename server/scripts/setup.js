// One-time demo setup on Arc Testnet (or local anvil):
//   1. owner sends a little native USDC to the agent + CloudTool wallets for gas (Arc gas is USDC)
//   2. owner deposits USDC into the vault (ERC-20 interface, 6 decimals)
//   3. owner grants the CloudTool trial mandate; the agent grants itself a WeatherAPI x402 budget
// Env: DEPOSIT_USDC (default 20), GAS_USDC (default 0.5), TRIAL_SECONDS (default 300 = 5 min, for the demo)
import { parseEther, parseAbi } from 'viem';
import { addressOf, fromUsd, publicClient, readState, vaultAddress, vaultWrite, wallet } from '../src/chain.js';
import { config } from '../src/config.js';

const ERC20 = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);
const deposit = Number(process.env.DEPOSIT_USDC ?? 20);
const gas = String(process.env.GAS_USDC ?? '0.5');
const trialSeconds = Number(process.env.TRIAL_SECONDS ?? 300);
const owner = wallet('owner');

async function send(hashPromise, label) {
  const hash = await hashPromise;
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`  ✓ ${label}  ${hash}`);
}

console.log(`Vault ${vaultAddress()} on ${config.chain.name}`);
const bal = await publicClient.readContract({ address: config.chain.usdc, abi: ERC20, functionName: 'balanceOf', args: [owner.account.address] });
console.log(`Owner ${owner.account.address} holds ${Number(bal) / 1e6} USDC`);
if (bal < fromUsd(deposit + 2 * Number(gas))) {
  console.error(`Not enough USDC. Get testnet USDC at https://faucet.circle.com (Arc Testnet) for ${owner.account.address}`);
  process.exit(1);
}

// 1. gas for the agent + merchant wallets (native transfer; on Arc the native token IS USDC)
for (const role of ['agent', 'cloudtool']) {
  const to = addressOf(role);
  const nativeBal = await publicClient.getBalance({ address: to });
  if (nativeBal < parseEther('0.1')) await send(owner.sendTransaction({ to, value: parseEther(gas) }), `gas → ${role} ${to}`);
}

// 2. deposit
await send(owner.writeContract({ address: config.chain.usdc, abi: ERC20, functionName: 'approve', args: [vaultAddress(), fromUsd(deposit)] }), 'approve');
const d = await vaultWrite('owner', 'deposit', [fromUsd(deposit)]);
console.log(`  ✓ deposit $${deposit}  ${d.hash}`);

// 3. mandates
const s = await readState();
const now = s.chainTime;
const c = await vaultWrite('owner', 'createMandate', [
  {
    merchant: addressOf('cloudtool'),
    capPerCharge: fromUsd(15),
    totalCap: fromUsd(15),
    askAbove: fromUsd(10),
    expiresAt: BigInt(now + trialSeconds),
    maxCharges: 0,
    agentCanPay: false,
    label: 'CloudTool trial',
  },
]);
console.log(`  ✓ mandate: CloudTool trial ($15 cap, ask above $10, expires in ${trialSeconds}s)  ${c.hash}`);
const w = await vaultWrite('agent', 'createMandate', [
  {
    merchant: addressOf('weather'),
    capPerCharge: fromUsd(0.01),
    totalCap: fromUsd(0.5),
    askAbove: 0n,
    expiresAt: BigInt(now + 86400),
    maxCharges: 0,
    agentCanPay: true,
    label: 'WeatherAPI (x402)',
  },
]);
console.log(`  ✓ mandate (created by the agent): WeatherAPI x402, $0.01/call, $0.50 total, 24h  ${w.hash}`);
console.log('\nDone. Start the app with `npm start`.');
