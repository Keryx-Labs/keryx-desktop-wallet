// Explorer REST client for the inference chat. Same routes and shapes as the website's lib/api.ts.

export interface NetworkInfo {
  network: string;
  last_daa_score: number;
  total_blocks: number;
  total_txs: number;
  hashrate_hps: number;
  total_supply_krx: number;
  block_reward_krx: number;
  max_supply_krx: number;
  mined_pct: number;
  burned_krx: number;
  total_escrow_krx: number;
  total_real_inferences: number;
}

export interface MarketData {
  price_usd: number;
  market_cap_usd: number;
  volume_24h_usd: number;
  change_24h_pct: number;
  high_24h_usd: number;
  low_24h_usd: number;
  circulating_supply_krx: number;
  updated_ms: number;
}

export interface ServiceProvider {
  tier: number;
  model_id: string;
  model: string;
  identity: string;
  escrow_pubkey: string;
}

export interface AiProviders {
  virtual_daa_score: number;
  window_daa: number;
  cohort: ServiceProvider[];
  window: ServiceProvider[];
}

export interface SealedResponse {
  responder_pubkey: string;
  body: string;
  response_length: number;
  block_hash: string;
  daa_score: number;
}

export interface InferenceResult {
  tx_id: string;
  model: string;
  status: string;
  sealed: boolean;
  sealed_recipients: number | null;
  sealed_responses: SealedResponse[];
}

export interface AddressBalance {
  balance_sompi: number;
}

export interface InferencesServed {
  served: number;
}

export interface Block {
  timestamp_ms: number;
  parents?: string[];
}

export function explorerBase(networkId: string): string {
  return networkId === "mainnet" ? "https://keryx-labs.com" : "https://testnet.keryx-labs.com";
}

export interface ExplorerApi {
  info: () => Promise<NetworkInfo>;
  market: () => Promise<MarketData>;
  balance: (addr: string) => Promise<AddressBalance>;
  inferencesServed: (addr: string) => Promise<InferencesServed>;
  transaction: (id: string) => Promise<Record<string, unknown>>;
  block: (hash: string) => Promise<Block>;
  aiProviders: () => Promise<AiProviders>;
  inferenceResult: (txId: string) => Promise<InferenceResult>;
}

export function explorerApi(networkId: string): ExplorerApi {
  const base = explorerBase(networkId);
  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`explorer ${res.status} on ${path}`);
    return (await res.json()) as T;
  }
  const e = encodeURIComponent;
  return {
    info: () => get("/api/v1/info"),
    market: () => get("/api/v1/market"),
    balance: (addr) => get(`/api/v1/addresses/${e(addr)}/balance`),
    inferencesServed: (addr) => get(`/api/v1/addresses/${e(addr)}/inferences-served`),
    transaction: (id) => get(`/api/v1/transactions/${e(id)}`),
    block: (hash) => get(`/api/v1/blocks/${e(hash)}`),
    aiProviders: () => get("/api/v1/ai/providers"),
    inferenceResult: (txId) => get(`/api/v1/inference/${e(txId)}`),
  };
}

export const formatHashrate = (hps: number): string => {
  if (hps <= 0) return "0 H/s";
  const units = ["H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
  let i = 0;
  let v = hps;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
};
