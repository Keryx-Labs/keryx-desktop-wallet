import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/** How often the NonKYC last price is re-read. A market quote does not need the 15s history poll. */
const POLL_MS = 60_000;

/**
 * How long the last good quote stays on screen once refreshes start failing. Past this the price
 * disappears: a number that quiet is no longer the market, and an old dollar figure next to a
 * live balance is worse than none.
 */
const STALE_MS = 10 * 60_000;

/** Sompi per KRX. Same scale `formatKrx` divides by. */
const SOMPI_SCALE = 8;

export interface KrxPrice {
  /** Exchange string, e.g. "0.00084214". Shown as the unit quote. */
  lastPrice: string;
  /** Digits of `lastPrice` with the decimal point removed. */
  priceInt: bigint;
  /** Digits after the decimal point in `lastPrice`. */
  priceScale: number;
  /** 24h change as the exchange printed it, e.g. "-3.20". Empty when it was not a number. */
  changePercent: string;
}

interface TickerResponse {
  last_price: string;
  change_percent: string;
}

let snapshot: KrxPrice | null = null;
let snapshotAt = 0;
const listeners = new Set<(price: KrxPrice | null) => void>();
let timer: number | null = null;
let inflight = false;

function parseTicker(raw: TickerResponse): KrxPrice | null {
  if (typeof raw?.last_price !== "string" || !/^\d{1,12}(\.\d{1,18})?$/.test(raw.last_price)) return null;
  const [whole, frac = ""] = raw.last_price.split(".");
  // A zero quote would print "$0.00" beside a real balance.
  if (BigInt(whole + frac) === 0n) return null;
  return {
    lastPrice: raw.last_price,
    priceInt: BigInt(whole + frac),
    priceScale: frac.length,
    changePercent: typeof raw.change_percent === "string" ? raw.change_percent : "",
  };
}

function publish(next: KrxPrice | null) {
  snapshot = next;
  for (const listener of listeners) listener(snapshot);
}

async function refresh() {
  if (inflight) return;
  inflight = true;
  try {
    const raw = await invoke<TickerResponse>("krx_market_price");
    const next = parseTicker(raw);
    if (!next) throw new Error("unusable ticker");
    snapshotAt = Date.now();
    publish(next);
  } catch {
    // Timeout, offline, exchange down or a bad payload. Keep the last good quote for a while so a
    // blip does not blank a number the user is looking at, then drop it once it is too old.
    // Polling carries on, so the price comes back by itself when the exchange does.
    if (snapshot && Date.now() - snapshotAt > STALE_MS) publish(null);
  } finally {
    inflight = false;
  }
}

function ensurePolling() {
  if (timer !== null) return;
  void refresh();
  timer = window.setInterval(() => void refresh(), POLL_MS);
}

function stopIfIdle() {
  if (listeners.size > 0 || timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

/** Shared NonKYC KRX/USDT quote. One poll for every balance on screen. */
export function useKrxPrice(): KrxPrice | null {
  const [price, setPrice] = useState<KrxPrice | null>(snapshot);
  useEffect(() => {
    listeners.add(setPrice);
    setPrice(snapshot);
    ensurePolling();
    return () => {
      listeners.delete(setPrice);
      stopIfIdle();
    };
  }, []);
  return price;
}

/**
 * Dollar value of a sompi balance at this quote.
 *
 * Integer arithmetic: USD = sompi * priceInt / 10^(8 + priceScale), then truncated (never
 * rounded up), the same way `formatKrx` treats a balance. Two decimals at $1 and above;
 * below that, four, and further only when four would still print $0.00.
 */
export function formatUsd(sompi: bigint, price: KrxPrice): string {
  if (sompi === 0n || price.priceInt === 0n) return "$0.00";
  const neg = sompi < 0n;
  const v = neg ? -sompi : sompi;
  const denom = 10n ** BigInt(SOMPI_SCALE + price.priceScale);
  // Eight fractional digits of USD, truncated.
  const scaled = (v * price.priceInt * 10n ** BigInt(SOMPI_SCALE)) / denom;
  const whole = scaled / 10n ** BigInt(SOMPI_SCALE);
  const frac8 = (scaled % 10n ** BigInt(SOMPI_SCALE)).toString().padStart(SOMPI_SCALE, "0");
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = neg ? "-" : "";
  if (whole >= 1n) return `${sign}$${wholeStr}.${frac8.slice(0, 2)}`;

  let places = 4;
  if (frac8.startsWith("0000")) {
    let i = 0;
    while (i < SOMPI_SCALE && frac8[i] === "0") i++;
    places = Math.min(SOMPI_SCALE, i + 2);
  }
  const frac = frac8.slice(0, places).replace(/0+$/, "");
  return `${sign}$${wholeStr}.${frac || "00"}`;
}

/** 24h change ready to print, or null when the exchange did not send a number. */
export function formatChange(
  changePercent: string
): { text: string; direction: "up" | "down" | "flat" } | null {
  if (!changePercent) return null;
  const n = Number(changePercent);
  if (!Number.isFinite(n)) return null;
  const text =
    changePercent.startsWith("+") || changePercent.startsWith("-") || n === 0
      ? `${changePercent}%`
      : `+${changePercent}%`;
  return { text, direction: n > 0 ? "up" : n < 0 ? "down" : "flat" };
}
