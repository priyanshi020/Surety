import { AbiCoder, Contract } from "ethers";
import { Router } from "express";
import { dep, DURATION_S, feedRead, sellers, SellerCfg, suretyRead, TOLERANCE_BPS, Mode } from "./config";
import { SURETY_ABI } from "./abis";

const coder = AbiCoder.defaultAbiCoder();

/** Live AVAX/USD price with 8 decimals: exchange API first, Chainlink feed as fallback. */
export async function liveAvaxUsd(): Promise<bigint> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3500);
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=AVAXUSDT", { signal: ctl.signal });
    clearTimeout(t);
    const j: any = await r.json();
    const p = Number(j.price);
    if (p > 0) return BigInt(Math.round(p * 1e8));
  } catch {}
  const [, answer] = await feedRead.latestRoundData();
  return BigInt(answer);
}

/** The terms a seller is willing to sell under. The seller never relays terms it did not offer itself. */
export function offerFor(s: SellerCfg) {
  return {
    seller: s.wallet.address,
    price: s.priceUsdc.toString(),
    duration: DURATION_S,
    verifier: dep.priceVerifier,
    params: coder.encode(["address", "uint256"], [dep.avaxUsdFeed, TOLERANCE_BPS]),
  };
}

export const sellerByKey = (k: string) => sellers.find((s) => s.key === k);

export function sellerRouter(): Router {
  const r = Router();

  // x402-style: unpaid request gets HTTP 402 with machine-readable payment terms.
  r.get("/seller/:id/price", (req, res) => {
    const s = sellerByKey(req.params.id);
    if (!s) return res.status(404).json({ error: "unknown seller" });
    res.status(402).json({
      x402Version: 1,
      scheme: "surety-escrow",
      network: `eip155:${dep.chainId}`,
      asset: dep.usdc,
      escrow: dep.surety,
      resource: "AVAX/USD spot price",
      seller: { name: s.name, agentId: s.agentId.toString(), address: s.wallet.address },
      terms: offerFor(s),
      guarantee: "If the delivered price deviates >3% from the Chainlink feed, or is late, you are refunded 2x from the seller's bond.",
    });
  });

  r.post("/seller/:id/mode", (req, res) => {
    const s = sellerByKey(req.params.id);
    if (!s) return res.status(404).json({ error: "unknown seller" });
    const mode = req.body?.mode as Mode;
    if (!["honest", "skew", "stall"].includes(mode)) return res.status(400).json({ error: "bad mode" });
    s.mode = mode;
    res.json({ seller: s.key, mode });
  });

  // The seller relays the buyer's signed authorization (buyer pays no gas), then delivers on-chain.
  r.post("/seller/:id/buy", async (req, res) => {
    const s = sellerByKey(req.params.id);
    if (!s) return res.status(404).json({ error: "unknown seller" });
    try {
      const { terms, auth } = req.body ?? {};
      const offer = offerFor(s);
      for (const k of ["seller", "verifier", "params"] as const) {
        if (String(terms?.[k]).toLowerCase() !== String(offer[k]).toLowerCase())
          return res.status(400).json({ error: `terms.${k} does not match this seller's offer` });
      }
      if (BigInt(terms.price) < BigInt(offer.price) || Number(terms.duration) !== DURATION_S)
        return res.status(400).json({ error: "terms.price/duration do not match this seller's offer" });

      const sc = new Contract(dep.surety, SURETY_ABI, s.signer);
      const openTx = await sc.openOrder(terms, auth);
      const rc = await openTx.wait();
      const ev = rc.logs
        .map((l: any) => {
          try {
            return suretyRead.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "OrderOpened");
      const orderId = Number(ev!.args[0]);

      if (s.mode === "stall") {
        // A cheating seller that simply never delivers. The timeout path refunds the buyer anyway.
        return res.json({ orderId, openTx: openTx.hash, delivered: false, mode: s.mode });
      }

      let price = await liveAvaxUsd();
      if (s.mode === "skew") price = (price * 112n) / 100n; // lies by +12%
      const deliverTx = await sc.deliver(orderId, coder.encode(["int256"], [price]));
      await deliverTx.wait();
      res.json({ orderId, openTx: openTx.hash, deliverTx: deliverTx.hash, delivered: true, mode: s.mode });
    } catch (e: any) {
      res.status(500).json({ error: e.shortMessage || e.message });
    }
  });

  return r;
}
