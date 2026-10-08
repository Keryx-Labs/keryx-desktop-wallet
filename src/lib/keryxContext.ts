/**
 * Keryx facts for the inference chat.
 *
 * The miner's model answers from training knowledge only, so questions about Keryx get a block
 * of facts fetched by this browser: live network numbers from the API, the whitepaper sections
 * that match the question, and the explorer entry of any address or hash pasted in it. The block
 * travels inside the sealed prompt like the conversation memory does.
 */

import { AiProviders, ExplorerApi, formatHashrate, MarketData, NetworkInfo } from "./explorerApi";
import { WHITEPAPER_MD } from "./whitepaper";
import { byteLength } from "./chatStore";

const TRIGGER =
  /(?<!\p{L})(keryx|krx|kaspa|blockdag|ghostdag|proof[- ]of[- ]model|pom|tiers?|escrow|strikes?|halving|supply|emission|wallets?|miners?|mining|hashrate|hash rate|rewards?|burn(ed|ing|s)?|roadmap|phases?|bridges?|explorer|price|market cap|exchanges?|listings?|pools?|suprnova|neuropool|daa|testnet|mainnet|whitepaper|keryxhash|kheavyhash|gpu|vram|inference|asic|coin|token|minage|mineurs?|récompenses?|émission|portefeuilles?|prix|pont|feuille de route|brûl(é|e|ée|és|ées|age)s?)(?!\p{L})/iu;

const ADDRESS_RE = /\bkeryx(?:test)?:[a-z0-9]{61,}\b/gi;
const HASH_RE = /\b[0-9a-f]{64}\b/gi;

const STOPWORDS = new Set(
  ("the a an and or of to in on for with is are was were be been it its this that these those what which who how why when where " +
    "does do did can could would should will from by as at about into over under than then there here you your we our they their " +
    "le la les un une des du de et ou est sont été ce cette ces qui que quoi comment pourquoi quand où dans pour avec sur par au aux " +
    "moi toi nous vous explique expliquer dis dire donne donner raconte parle " +
    "keryx krx please tell explain give about what's").split(" ")
);

/** Fixed facts every Keryx block carries, so a general question gets the essentials even when no whitepaper section matches. */
const CORE_FACTS =
  "- The coin is called Keryx; its ticker is spelled K-R-X. On the public testnet the coin has no value.\n" +
  "- Keryx is a proof-of-work BlockDAG forked from Kaspa (GHOSTDAG), about 10 blocks per second, with no premine and no token sale; 5% of each block subsidy goes to the protocol R&D treasury.\n" +
  "- Mining and AI inference are one job: every mining GPU keeps a language model resident in VRAM and proves it on every block (Proof-of-Model); ASICs cannot mine it.\n" +
  "- Users send an AI request as an on-chain transaction paid in Keryx coins; the first miner of the model's tier to answer earns the inference reward; all fees are burned.\n" +
  "- Private inference: the prompt is encrypted end to end to the miners of the tier; only they can read it.\n" +
  "- Model tiers by GPU memory: tier 0 Qwen3.5-9B (8 GB), tier 1 GLM-4-9B (12 GB), tier 2 Gemma-4-12B (16 GB), tier 3 Qwen3.8-27B (24 GB), tier 4 Kimi-Linear-48B (32 GB).\n" +
  "- Roadmap: phases 1-4 delivered (genesis, economy, multi-model oracle, Proof-of-Model); phase 5 in research (sharded large models, reproducible inference); phase 6 next (Ethereum and Solana bridges, on-chain agent API).\n" +
  "- Software: keryxd node, keryx-miner (NVIDIA 8 GB+, Linux, Windows, HiveOS), web wallet, desktop wallet, browser extension, mobile wallet, explorer at keryx-labs.com.\n";

export interface WhitepaperSection {
  title: string;
  body: string;
}

let sections: WhitepaperSection[] | null = null;

/** Whitepaper split on its `##`/`###`/`####` headings, lazily, once. */
function whitepaperSections(): WhitepaperSection[] {
  if (sections) return sections;
  const out: WhitepaperSection[] = [];
  let title = "";
  let body: string[] = [];
  for (const line of WHITEPAPER_MD.split("\n")) {
    const m = /^#{2,4}\s+(.*)$/.exec(line);
    if (m) {
      if (title) out.push({ title, body: body.join("\n").trim() });
      title = m[1].trim();
      body = [];
    } else if (title) {
      body.push(line);
    }
  }
  if (title) out.push({ title, body: body.join("\n").trim() });
  sections = out.filter((s) => s.body.length > 0);
  return sections;
}

const terms = (text: string): string[] =>
  Array.from(new Set(text.toLowerCase().match(/\p{L}[\p{L}\p{N}-]{2,}/gu) ?? [])).filter((t) => !STOPWORDS.has(t));

const count = (haystack: string, needle: string): number => {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1 && n < 8) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
};

function truncateToBytes(s: string, maxBytes: number): string {
  let used = 0;
  let out = "";
  for (const ch of s) {
    const n = byteLength(ch);
    if (used + n > maxBytes) break;
    used += n;
    out += ch;
  }
  return out;
}

/** Longest follow-up (in words) that inherits the Keryx topic from the previous question. */
const FOLLOW_UP_MAX_WORDS = 8;

/** True when the message names Keryx itself (name, ticker or address), not just a related topic. */
export function namesKeryx(text: string): boolean {
  return /(?<!\p{L})(keryx|t?krx)(?!\p{L})/iu.test(text) || /\bkeryx(?:test)?:[a-z0-9]{61,}\b/i.test(text);
}

/** True when the message, or a short follow-up to a question about Keryx, is about Keryx. */
export function isKeryxQuestion(question: string, lastExchange?: { question: string; answer: string }): boolean {
  const direct = TRIGGER.test(question) || ADDRESS_RE.test(question);
  ADDRESS_RE.lastIndex = 0;
  if (direct) return true;
  if (!lastExchange) return false;
  // Only the user's own words carry the topic: the model describes Keryx in most answers.
  const words = question.trim().split(/\s+/).filter(Boolean).length;
  return words <= FOLLOW_UP_MAX_WORDS && !OTHER_SUBJECT.test(question) && !OTHER_ACRONYM.test(question) && TRIGGER.test(lastExchange.question);
}

/** A follow-up naming another asset has its own subject. */
const OTHER_SUBJECT =
  /(?<!\p{L})(btc|bitcoin|eth|ether(eum)?|sol|solana|xrp|ripple|doge(coin)?|bnb|usdt|usdc|tether|ada|cardano|ltc|litecoin|polkadot|tron|monero|xmr|gold|nvidia|apple|tesla)(?!\p{L})/iu;
/** An upper-case ticker or acronym other than Keryx's own words. */
const OTHER_ACRONYM = /(?<![\p{L}\d])(?!(?:KRX|TKRX|KAS|AI|IA|GPU|VRAM|DAA|POM|PoM|DAG)(?![\p{L}\d]))[A-Z]{2,6}(?![\p{L}\d])/u;

/** Whitepaper sections ranked by overlap with the question, cut to `maxBytes` in total. */
export function relevantSections(question: string, maxBytes: number, maxSections = 3, maxSectionBytes = 2_600): WhitepaperSection[] {
  const q = terms(question);
  if (q.length === 0) return [];
  const scored = whitepaperSections()
    .map((s) => {
      const title = s.title.toLowerCase();
      const body = s.body.toLowerCase();
      let score = 0;
      for (const t of q) score += count(title, t) * 4 + Math.min(count(body, t), 5);
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const picked: WhitepaperSection[] = [];
  let budget = maxBytes;
  for (const { s } of scored) {
    if (picked.length >= maxSections) break;
    const head = `### ${s.title}\n`;
    const room = Math.min(maxSectionBytes, budget) - byteLength(head) - 2;
    if (room < 300) break;
    const body = byteLength(s.body) <= room ? s.body : truncateToBytes(s.body, room - 4) + " […]";
    picked.push({ title: s.title, body });
    budget -= byteLength(head) + byteLength(body) + 2;
  }
  return picked;
}

export interface LiveFacts {
  fetchedAt: number;
  info: NetworkInfo | null;
  market: MarketData | null;
  providers: AiProviders | null;
  lookups: string[];
}

/** Live numbers and explorer lookups for the hashes and addresses found in `question`. */
export async function fetchLiveFacts(api: ExplorerApi, question: string, providers: AiProviders | null, info: NetworkInfo | null): Promise<LiveFacts> {
  const facts: LiveFacts = { fetchedAt: Date.now(), info, market: null, providers, lookups: [] };
  const jobs: Promise<void>[] = [];
  if (!info) jobs.push(api.info().then((i) => { facts.info = i; }).catch(() => {}));
  jobs.push(api.market().then((m) => { facts.market = m; }).catch(() => {}));
  const addresses = Array.from(new Set((question.match(ADDRESS_RE) ?? []).map((a) => a.toLowerCase()))).slice(0, 3);
  for (const addr of addresses) {
    jobs.push(
      Promise.all([api.balance(addr), api.inferencesServed(addr).catch(() => null)])
        .then(([b, served]) => {
          const extra = served ? `, inferences served: ${served.served}` : "";
          facts.lookups.push(`Address ${addr}: balance ${(b.balance_sompi / 1e8).toLocaleString("en-US", { maximumFractionDigits: 8 })} coins${extra}`);
        })
        .catch(() => { facts.lookups.push(`Address ${addr}: not found by the explorer`); })
    );
  }
  const hashes = Array.from(new Set((question.match(HASH_RE) ?? []).map((h) => h.toLowerCase()))).slice(0, 2);
  for (const h of hashes) {
    jobs.push(
      api.transaction(h)
        .then((tx) => {
          const t = tx as unknown as Record<string, unknown>;
          const parts = [`Transaction ${h}`];
          for (const k of ["block_hash", "timestamp_ms", "subnetwork", "mass", "payload_type", "model"]) if (t[k] !== undefined) parts.push(`${k}: ${String(t[k])}`);
          facts.lookups.push(parts.join(", "));
        })
        .catch(() =>
          api.block(h)
            .then((b) => { facts.lookups.push(`Block ${h}: timestamp ${new Date(b.timestamp_ms).toISOString()}, ${(b.parents ?? []).length} parents`); })
            .catch(() => { facts.lookups.push(`Hash ${h}: not found by the explorer as a transaction or a block`); })
        )
    );
  }
  await Promise.all(jobs);
  return facts;
}

const TIER_LABELS = ["Qwen3.5-9B (tier 0, 8 GB)", "GLM-4-9B (tier 1, 12 GB)", "Gemma-4-12B (tier 2, 16 GB)", "Qwen3.8-27B (tier 3, 24 GB)", "Kimi-Linear-48B (tier 4, 32 GB)"];

/** A price the model cannot mangle: digits with a dot, then the same amount in cents. */
function priceWords(usd: number): string {
  const digits = usd.toPrecision(3).replace(/\.?0+$/, "");
  if (usd >= 1) return `${digits} US dollars`;
  if (usd >= 0.01) return `${digits} US dollars, about ${(usd * 100).toPrecision(2)} cents`;
  return `${digits} US dollars, about ${(usd * 100).toPrecision(2)} US cents, which is less than one cent`;
}

function liveLines(f: LiveFacts): string[] {
  const lines: string[] = [];
  const when = new Date(f.fetchedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const testnet = !!f.info && f.info.network !== "mainnet";
  lines.push(`Data fetched from keryx-labs.com at ${when}.`);
  if (testnet) lines.push(`These live numbers describe the public testnet (${f.info!.network}), not mainnet: testnet coins have no value and its supply, hashrate and miner counts are much smaller than mainnet's.`);
  if (f.info) {
    const i = f.info;
    lines.push(
      `Network ${i.network}: DAA score ${i.last_daa_score.toLocaleString("en-US")}, hashrate ${formatHashrate(i.hashrate_hps)}, ` +
        `block reward ${i.block_reward_krx} coins, ${i.total_blocks.toLocaleString("en-US")} blocks, ${i.total_txs.toLocaleString("en-US")} transactions.`
    );
    lines.push(
      `Supply: ${Math.round(i.total_supply_krx).toLocaleString("en-US")} coins in circulation after burns, ` +
        `${Math.round(i.burned_krx).toLocaleString("en-US")} coins burned so far, max supply ${Math.round(i.max_supply_krx).toLocaleString("en-US")} coins ` +
        `(${(i.mined_pct * 100).toFixed(2)} % emitted). ${Math.round(i.total_escrow_krx).toLocaleString("en-US")} coins locked in miner escrow. ` +
        `${i.total_real_inferences.toLocaleString("en-US")} inferences served on-chain.`
    );
  }
  if (f.market && f.market.price_usd > 0) {
    const m = f.market;
    const change = `${m.change_24h_pct >= 0 ? "+" : ""}${m.change_24h_pct.toFixed(1)} % over 24 h`;
    lines.push(
      testnet
        ? `Market: one mainnet Keryx coin trades at about ${priceWords(m.price_usd)} (${change}). ` +
          "Testnet coins have no price and no value: never give a price, a market cap or a dollar value for testnet coins."
        : `Market: one Keryx coin trades at ${priceWords(m.price_usd)} (${change}), market cap ${Math.round(m.market_cap_usd).toLocaleString("en-US")} USD, ` +
            `24 h volume ${Math.round(m.volume_24h_usd).toLocaleString("en-US")} USD.`
    );
  } else {
    lines.push("Market: no live price available right now; do not quote one.");
  }
  const prov = f.providers;
  if (prov) {
    const perTier = TIER_LABELS.map((label, t) => `${label}: ${new Set(prov.cohort.filter((p) => p.tier === t).map((p) => p.escrow_pubkey)).size}`);
    lines.push(`Miners serving inference right now, by model: ${perTier.join("; ")}.`);
  }
  for (const l of f.lookups) lines.push(`Explorer: ${l}`);
  return lines;
}

const HEADER =
  "KERYX FACTS — authoritative, prefer them over your training knowledge. Use only the facts that help answer the question, " +
  "do not recite the whole list. Cite the fetch time when quoting a live number.\n\nCore facts:\n";
const FOOTER =
  "\nThese facts only concern Keryx. If a question about Keryx is not covered above, say so instead of guessing; " +
  "for any other subject answer normally from your knowledge and from the web results when they are attached. " +
  "Never invent exchange listings, prices or dates for Keryx. " +
  "Never cite these facts with a bracket label such as [Core Facts]; brackets [n] are only for web results. " +
  "Call the coin \"Keryx\" or \"Keryx coins\"; if you give its ticker, spell it with hyphens as K-R-X (T-K-R-X on the testnet) and never as one word. " +
  "Keep numbers exactly as written above, with a dot as decimal separator.\n\n";

/** The facts block for `question`, at most `maxBytes`. Empty when nothing useful fits. */
export function buildKeryxContext(question: string, facts: LiveFacts, maxBytes: number): string {
  const live = CORE_FACTS + "\nLive data:\n" + liveLines(facts).map((l) => `- ${l}`).join("\n") + "\n";
  const budget = maxBytes - byteLength(HEADER) - byteLength(FOOTER) - byteLength(live);
  if (budget < 0) return "";
  let picked = relevantSections(question, budget - 64);
  if (picked.length === 0) picked = relevantSections("abstract", budget - 64, 1);
  const excerpts = picked.length > 0 ? "\nWhitepaper excerpts:\n" + picked.map((s) => `### ${s.title}\n${s.body}\n`).join("\n") : "";
  return HEADER + live + excerpts + FOOTER;
}
