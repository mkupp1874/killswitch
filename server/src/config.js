import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
dotenv.config({ path: process.env.ENV_FILE || path.join(ROOT, '.env') });

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));

export const config = {
  port: num(process.env.PORT, 8787),
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${num(process.env.PORT, 8787)}`,

  chain: {
    name: process.env.CHAIN_NAME || 'Arc Testnet',
    rpcUrl: process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network',
    chainId: num(process.env.CHAIN_ID, 5042002),
    explorer: process.env.EXPLORER_URL || 'https://testnet.arcscan.app',
    usdc: process.env.USDC_ADDRESS || '0x3600000000000000000000000000000000000000',
    vault: process.env.VAULT_ADDRESS,
    pollMs: num(process.env.POLL_LOGS_MS, 4000),
  },

  keys: {
    owner: process.env.OWNER_PRIVATE_KEY, // the user's invisible app wallet
    agent: process.env.AGENT_PRIVATE_KEY, // the AI payment agent
    cloudtool: process.env.MERCHANT_CLOUDTOOL_KEY, // demo SaaS merchant
    weather: process.env.MERCHANT_WEATHER_KEY, // demo x402 API merchant
  },

  quicknode: {
    secret: process.env.QN_STREAM_SECRET || '',
    // true  = alerts come ONLY from QuickNode Streams deliveries (the RPC poller is off).
    // false = the RPC poller also runs, as a backup for local dev without a public webhook URL.
    primary: bool(process.env.QN_STREAMS_PRIMARY, false),
  },

  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',
    ttsModel: process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5',
    sttModel: process.env.ELEVENLABS_STT_MODEL || 'scribe_v1',
  },

  agent: {
    // Off-chain guardrails the agent applies BEFORE it even asks the vault (the vault is the final word).
    taskBudgetUsd: num(process.env.AGENT_TASK_BUDGET_USD, 0.1),
    priceSpikeMultiple: num(process.env.AGENT_PRICE_SPIKE_X, 2),
  },
};
