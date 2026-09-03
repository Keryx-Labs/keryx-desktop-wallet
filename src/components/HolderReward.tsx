import { useCallback, useEffect, useState } from "react";
import {
  wallet,
  HolderReward as HolderRewardData,
  ServiceStanding,
  groupKrx,
  formatKrx,
} from "../lib/wallet";
import { useWalletState } from "../lib/useWallet";

/** The bracket only moves as coins ripen and blocks land — a slow poll is plenty. */
const POLL_MS = 60_000;

/*
 * A note on colour, because it was got wrong once here: `keryx-muted` (#35443a) is the site's
 * BORDER tone and measures 1.83:1 on the card gradient — it fails even the 3:1 floor for large
 * text, and every label in this panel is 9-11px. Nothing in here may carry text in it. The
 * quietest legible step is `keryx-dim` (5.48:1); `mid`, `text` and `ink` are 9:1 and up.
 */

/**
 * H6 tier-reward schedule, mirroring `TIER_REWARD_BPS_H6` in the node: 10-point steps with the
 * top tier as the 100% reference. Names are the models each tier proves possession of.
 *
 * Duplicated here rather than fetched because the node exposes no schedule RPC. If a fork changes
 * the table this list goes stale, so it is used ONLY for labelling — every figure shown is
 * computed from the node's own bucket amounts, never from these bps.
 */
const TIER_LABELS = ["Qwen3.5-9B", "tier 1", "Gemma-4-12B", "Qwen3.6-27B", "Kimi-48B"];
const TIER_BPS = [6_000n, 7_000n, 8_000n, 9_000n, 10_000n];

/** bps out of 10_000 → a percentage string with no trailing ".0" ("7500" → "75%"). */
function bpsPercent(bps: bigint): string {
  const tenths = Number(bps) / 100;
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)}%`;
}

/**
 * Whole KRX, grouped — these are headline figures where the 8 decimals of a sompi amount are
 * noise. `formatKrx` first so the bigint never goes through a float.
 */
function krxWhole(sompi: bigint): string {
  return groupKrx(formatKrx(sompi).split(".")[0]);
}

/**
 * A DAA count as an elapsed-time label. The chain runs at 10 blocks (and so 10 DAA) per second,
 * which is what makes the reward window's 864,000 DAA exactly 24h.
 */
function spanLabel(daa: bigint): string {
  const minutes = Number(daa) / 600;
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))}min`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/**
 * Days as a coarse, honestly-imprecise label. Rounded hard on purpose: the input is an
 * extrapolation of a few hours of mining, so "~3 weeks" is the true precision and "21.3 days"
 * would dress a guess up as a measurement.
 */
function etaLabel(days: number): string {
  if (days === 0) return "reached";
  if (days < 1) return "~today";
  if (days < 14) return `~${Math.round(days)} days`;
  if (days < 60) return `~${Math.round(days / 7)} weeks`;
  return `~${Math.round(days / 30)} months`;
}

/** `a / b` to one decimal, done in bigint so a 15-digit sompi value keeps its precision. */
function ratio1dp(a: bigint, b: bigint): string {
  if (b === 0n) return "—";
  return (Number((a * 10n) / b) / 10).toFixed(1);
}

/**
 * The node's holder-reward (ratio-reward) verdict for the active receive address.
 *
 * Renders nothing at all unless the node says this address actually mined inside the window
 * (`productionRaw > 0`): the bracket scales a MINER cut, so for a plain holding address there is
 * no such thing as a holder reward and a card full of zeros would just be misleading. Same reason
 * the chain explorer hides it for non-miners.
 */
export function HolderRewardPanel() {
  const w = useWalletState();
  const [data, setData] = useState<HolderRewardData | null>(null);
  const [standing, setStanding] = useState<ServiceStanding | null>(null);

  const addr = w.receiveAddress;

  const refresh = useCallback(async () => {
    const r = await wallet.holderReward();
    setData(r);
    // Standing is fetched for the address the reward answer actually came from — the panel sweeps
    // to find the mining address, so the active receive address is often not the one that mines.
    setStanding(r ? await wallet.serviceStandingFor(r.address) : null);
  }, []);

  // Re-read on address or connection change, then poll. Keyed on the address so switching wallet
  // never leaves the previous address's bracket on screen under the new balance.
  useEffect(() => {
    setData(null);
    setStanding(null);
    if (!addr || w.conn !== "connected") return;
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh, addr, w.conn]);

  if (!data || data.productionRaw === 0n) return null;

  const { effBalance, production, productionRaw, bracketBps, nextBracketBps, nextBracketBalance } = data;
  // Escrow is mining income too, but it is CSV-locked and still forfeitable to a service penalty,
  // so it is shown beside what actually landed rather than folded into it.
  const mined = data.paid;
  const escrow = data.escrow;
  const burned = data.burned;
  // Won by serving inference, not by producing a block — outside the base entitlement, so it is
  // never part of the burn.
  const inference = data.inference;
  // How many windows of its own production the address holds, and how many the top rung wants.
  const held = ratio1dp(effBalance, production);
  const fullMultiple = production > 0n ? Number(data.fullBracketBalance / production) : 0;
  const atTop = nextBracketBps === null || nextBracketBalance === null;
  // Progress toward the NEXT rung, not toward 100% — that is the number the holder can act on.
  const windowLabel = Number(data.windowDaa) === 864_000 ? "24h" : "window";
  // The income figures come from node-side indexes built forward from the boot that created them,
  // so on a node that has just grown them they describe minutes, not the full window. Labelling
  // them "24h" regardless would report a night of mining as a night of burning, so the rows carry
  // the span the node says it actually covers — and vanish entirely when it covers nothing.
  const incomeDaa = data.incomeWindowDaa;
  const incomeCovered = incomeDaa > 0n;
  const incomePartial = incomeCovered && incomeDaa < data.windowDaa;
  const incomeLabel = incomePartial ? spanLabel(incomeDaa) : windowLabel;

  // What fraction of the base entitlement actually reached the wallet, over the span the node
  // covers. EXACT and already in hand — `burned` is defined as entitlement minus paid, so
  // `paid + burned` IS the entitlement for that span and this division closes by construction.
  // It is the honest home for the tier: the holder bracket above is only one of the two
  // multipliers, and without this line the card cannot explain why 75% of the entitlement did not
  // arrive. The remainder is the tier bracket and the service-standing gate (plus any movement of
  // the holder bracket inside the span), which is why the tooltip attributes it rather than
  // claiming an exact product.
  const entitlementInSpan = mined + burned;
  const payoutRateBps = entitlementInSpan > 0n ? (mined * 10_000n) / entitlementInSpan : null;

  // Days to a target effective balance, at the income rate the node just measured.
  //
  // Rate comes from the covered span scaled to a day; the target comes from the node's own 24h
  // production. Those two can disagree — they do right after a restart, when the 24h window still
  // holds hours the payout index never saw — so this is an estimate at the CURRENT rate and is
  // labelled as one, never a promise. Below an hour of coverage the rate is noise, so no estimate
  // is offered at all rather than a confident wrong number.
  const MIN_ETA_DAA = 36_000n; // 1h at 10 blocks/s
  const paidPerDay = incomeDaa > 0n ? (mined * data.windowDaa) / incomeDaa : 0n;
  const etaDays = (target: bigint | null): number | null => {
    if (target === null || paidPerDay === 0n || incomeDaa < MIN_ETA_DAA) return null;
    if (target <= effBalance) return 0;
    return Number(((target - effBalance) * 10n) / paidPerDay) / 10;
  };
  const etaNext = etaDays(nextBracketBalance);
  const etaFull = etaDays(data.fullBracketBalance);

  // The tier MIX over the same span. Shares are taken over the sum of the buckets, never over the
  // entitlement: a block whose tier the node could not resolve is absent from the buckets, and
  // dividing by the entitlement would silently attribute it to no tier while shrinking every
  // share. `tieredBase` can therefore be below `entitlementInSpan` — that is expected, not a bug.
  const tierBase = data.tierBase;
  const tieredBase = tierBase.reduce((a, b) => a + b, 0n);
  // Production-weighted tier, the single number that says what the blend is worth. Recoverable
  // from the buckets; the buckets are not recoverable from it, which is why the node sends these.
  const tierEffBps =
    tieredBase > 0n
      ? tierBase.reduce((acc, amount, t) => acc + amount * (TIER_BPS[t] ?? 10_000n), 0n) / tieredBase
      : null;
  // Descending by contribution, dropping tiers this miner never ran.
  const tierMix = tierBase
    .map((amount, t) => ({ t, amount }))
    .filter((row) => row.amount > 0n)
    .sort((a, b) => (b.amount > a.amount ? 1 : -1));
  const pct =
    atTop || nextBracketBalance! === 0n
      ? 100
      : Math.max(0, Math.min(100, Number((effBalance * 100n) / nextBracketBalance!)));

  return (
    <div className="mt-4 border-t border-keryx-border pt-3">
      <div className="flex items-baseline justify-between">
        <p className="section-label mb-0">Holder reward</p>
        <span className="text-[9px] uppercase tracking-wider text-keryx-dim">
          {Number(data.windowDaa) === 864_000 ? "24h window" : `${groupKrx(String(data.windowDaa))} daa`}
        </span>
      </div>

      <p
        className={`num mt-1 text-2xl font-bold leading-none ${
          bracketBps >= 10_000n ? "text-keryx-green" : "text-keryx-bright"
        }`}
      >
        {bpsPercent(bracketBps)}
        <span className="ml-2 text-[10px] font-medium tracking-label text-keryx-dim">
          OF MINER CUT
        </span>
      </p>

      {/* Not yet in force: the figures are a preview of a reward rule that is not scaling
          anything today, and saying "75% of miner cut" without that caveat would be wrong. */}
      {!data.active && (
        <p className="mt-1 text-[10px] uppercase tracking-wider text-keryx-warn">
          Not yet active on this network
        </p>
      )}

      {/* Income first, entitlement second. The node's production figure is the sum of the BASE
          (un-scaled) miner cuts of this address's paid blocks; what actually lands is that base
          scaled by this bracket AND the tier bracket, and the shortfall is burned. Reporting only
          the base — as this panel first did under the label "Production" — reads as income and
          overstates it by exactly the burn. */}
      <dl className="mt-3 space-y-1.5 text-xs">
        {incomeCovered && (
        <>
        <div className="flex items-baseline justify-between gap-2">
          <dt
            className="text-keryx-dim"
            title="Miner cut the coinbases actually paid this address over the span shown, after the holder-reward and tier brackets. This is what reached the wallet."
          >
            Mined ({incomeLabel})
          </dt>
          <dd className="num font-semibold text-keryx-bright">{krxWhole(mined)} KRX</dd>
        </div>
        {/* Only for a miner running the inference service; a standard miner's escrow slice is
            paid to the burn address at emission and accrues to nobody, so the row would be a
            flat zero that invites "where is my escrow?". */}
        {escrow > 0n && (
          <div className="flex items-baseline justify-between gap-2">
            <dt
              className="text-keryx-dim"
              title="Escrow slice that accrued to this address over the window. CSV-locked, and still forfeitable to a service penalty until it is claimed — earned, but not yet in hand."
            >
              + escrow (locked)
            </dt>
            <dd className="num text-keryx-mid">{krxWhole(escrow)} KRX</dd>
          </div>
        )}
        {inference > 0n && (
          <div className="flex items-baseline justify-between gap-2">
            <dt
              className="text-keryx-dim"
              title="Inference rewards routed to this address over the window — won by serving an inference, not by producing a block. Outside the base entitlement, so the brackets never scale it."
            >
              + inference
            </dt>
            <dd className="num text-keryx-mid">{krxWhole(inference)} KRX</dd>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <dt
            className="text-keryx-dim"
            title="Entitlement minus what was paid, over the same span as Mined: the shortfall the holder-reward and tier brackets destroyed. Raising the bracket is what shrinks this."
          >
            Burned ({incomeLabel})
          </dt>
          <dd className={`num ${burned > 0n ? "text-keryx-warn" : "text-keryx-mid"}`}>
            {krxWhole(burned)} KRX
          </dd>
        </div>
        {/* Sits directly under Mined and Burned so the reader can verify it from the two rows
            above: mined ÷ (mined + burned). Deliberately not next to "Base entitlement", which
            is a 24h figure — adjacent, it would invite dividing by the wrong number. */}
        {payoutRateBps !== null && (
          <div className="flex items-baseline justify-between gap-2">
            <dt
              className="text-keryx-dim"
              title="Share of the base entitlement that actually reached the wallet, over the span above. The holder bracket is only one of the two multipliers — the rest of the gap is the model-tier bracket and the service-standing gate."
            >
              Payout rate ({incomeLabel})
            </dt>
            <dd className="num text-keryx-mid">{bpsPercent(payoutRateBps)}</dd>
          </div>
        )}
        {/* The second multiplier, and the reason the payout rate above sits below the holder
            bracket. Reported as the production-weighted blend because a miner runs rigs on
            different models — see the mix underneath. */}
        {tierEffBps !== null && (
          <div className="flex items-baseline justify-between gap-2">
            <dt
              className="text-keryx-dim"
              title="Model-tier bracket, weighted by how much of your production came from each tier. The other multiplier on the miner cut, alongside the holder bracket above."
            >
              Tier (weighted)
            </dt>
            <dd className="num text-keryx-mid">{bpsPercent(tierEffBps)}</dd>
          </div>
        )}

        </>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <dt
            className="text-keryx-dim"
            title="Sum of the base, un-scaled miner cuts of the blocks this address was paid for — the ceiling the two brackets scale down from."
          >
            Base entitlement
          </dt>
          <dd className="num text-keryx-dim">{krxWhole(productionRaw)} KRX</dd>
        </div>

        <div className="flex items-baseline justify-between gap-2 border-t border-keryx-border pt-1.5">
          <dt className="text-keryx-dim">Held / production</dt>
          <dd className="num text-keryx-mid">
            {held}×{" "}
            <span className="text-keryx-dim">({fullMultiple}× = full)</span>
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          {/* Named "effective", not "balance": it is the coin-age figure, and it sits below the
              balance shown above whenever coins are still ripening. Users notice. */}
          <dt className="text-keryx-dim" title="Coin-age effective balance: coins younger than the maturity window count at a prorata of their age.">
            Effective balance
          </dt>
          <dd className="num text-keryx-mid">{krxWhole(effBalance)} KRX</dd>
        </div>
      </dl>

      {/* The mix behind the weighted tier above. Shown only when more than one tier contributed:
          for a single-model miner the weighted figure already says everything and a one-row
          "100%" breakdown would be noise. Shares are over the sum of the buckets — see the note
          on `tieredBase`. */}
      {tierMix.length > 1 && (
        <dl className="mt-3 space-y-1 border-t border-keryx-border pt-2">
          <p className="section-label mb-1">Tier mix ({incomeLabel})</p>
          {tierMix.map(({ t, amount }) => (
            <div key={t} className="flex items-baseline justify-between gap-2 text-[11px]">
              <dt className="truncate text-keryx-dim">
                {TIER_LABELS[t] ?? `tier ${t}`}{" "}
                {/* "pays" is load-bearing: without it the row shows two percentages of different
                    kinds — the tier's reward rate and its share of production — and the reader has
                    no way to tell which is which. */}
                <span className="text-keryx-dim">· pays {bpsPercent(TIER_BPS[t] ?? 10_000n)}</span>
              </dt>
              <dd className="num shrink-0 text-keryx-mid">
                {Number((amount * 1000n) / tieredBase) / 10}%
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* Service standing. Rendered only when there is something to say: a clean identity would
          otherwise add three zero rows to an already dense card. It belongs here and not in a
          separate panel because in H6 a failing standing pays the tier bonus at the ENTRY tier's
          rate whatever model was proven — it is a direct multiplier on the numbers above, not
          side information. */}
      {standing !== null &&
        (standing.suspendedUntilDaaScore !== null ||
          standing.consecutiveMisses > 0 ||
          standing.pendingBurnSompi > 0n ||
          standing.lifetimeStrikes > 0) && (
          <dl className="mt-3 space-y-1 border-t border-keryx-border pt-2 text-[11px]">
            <p className="section-label mb-1">Service standing</p>
            {standing.suspendedUntilDaaScore !== null && (
              <div className="flex items-baseline justify-between gap-2">
                <dt
                  className="text-keryx-warn"
                  title="While suspended the ENTIRE miner cut of this identity's blocks is burned — not reduced, burned."
                >
                  Suspended until DAA
                </dt>
                <dd className="num text-keryx-warn">
                  {groupKrx(String(standing.suspendedUntilDaaScore))}
                </dd>
              </div>
            )}
            {standing.consecutiveMisses > 0 && (
              <div className="flex items-baseline justify-between gap-2">
                <dt
                  className="text-keryx-dim"
                  title="Consecutive unanswered inference requests standing against this identity. Resets on a served response or an executed suspension — never by waiting."
                >
                  Consecutive misses
                </dt>
                <dd className="num text-keryx-warn">{standing.consecutiveMisses}</dd>
              </div>
            )}
            {standing.pendingBurnSompi > 0n && (
              <div className="flex items-baseline justify-between gap-2">
                <dt
                  className="text-keryx-dim"
                  title="Escrow already forfeited by a finality-deep miss. This is locked collateral you have lost, not a reduced reward."
                >
                  Escrow burned ({standing.pendingBurnCount})
                </dt>
                <dd className="num text-keryx-warn">
                  {krxWhole(standing.pendingBurnSompi)} KRX
                </dd>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-2">
              <dt
                className="text-keryx-dim"
                title="Strikes over this identity's whole life. Kept apart from the consecutive count, which resets — this one does not, and probation is judged on standing."
              >
                Lifetime strikes
              </dt>
              <dd className="num text-keryx-mid">{standing.lifetimeStrikes}</dd>
            </div>
          </dl>
        )}

      {/* Why the income rows read short, or are missing: the node builds those indexes forward from
          the boot that created them, so they start empty and widen to the full window. Saying so is
          what keeps a short "Mined" from looking like lost coin. */}
      {incomePartial && (
        <p className="mt-2 text-[10px] leading-snug text-keryx-dim">
          Mined / burned cover the last {incomeLabel} — widening to {windowLabel} as the node's
          payout index fills.
        </p>
      )}
      {!incomeCovered && (
        <p className="mt-2 text-[10px] leading-snug text-keryx-dim">
          Mined / burned split not available from this node yet.
        </p>
      )}

      {atTop ? (
        <p className="mt-3 text-[10px] uppercase tracking-wider text-keryx-green">
          ✓ Full miner reward
        </p>
      ) : (
        <div className="mt-3">
          <div className="h-1 w-full overflow-hidden rounded-sm bg-keryx-border">
            <div
              className="h-full bg-keryx-green transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[10px] uppercase tracking-wider text-keryx-dim">
            Next {bpsPercent(nextBracketBps!)} — hold{" "}
            <span className="text-keryx-bright">
              +{krxWhole(nextBracketBalance! - effBalance)} KRX
            </span>{" "}
            effective
            {etaNext !== null && <span className="text-keryx-mid"> · {etaLabel(etaNext)}</span>}
          </p>
          {/* The estimate the holder actually asked for, and the one worth a caveat: it assumes
              everything mined is held and the hashrate holds. It is NOT a countdown — the top rung
              is 90× your own production, so mining harder raises the bar as fast as it fills it. */}
          {etaFull !== null && (
            <p className="mt-1 text-[10px] uppercase tracking-wider text-keryx-dim">
              100% in <span className="text-keryx-mid">{etaLabel(etaFull)}</span> if held at this
              rate
            </p>
          )}
        </div>
      )}
    </div>
  );
}
