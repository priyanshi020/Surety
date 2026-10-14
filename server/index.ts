import express from "express";
import * as path from "path";
import { Contract } from "ethers";
import {
  buyerW, dep, EXPLORER, fmtUsdc, keeper, NETWORK, PORT, provider, repRead, sellers, suretyRead, usdcRead, DURATION_S, TOLERANCE_BPS,
} from "./config";
import { SURETY_ABI } from "./abis";
import { indexer } from "./indexer";
import { sellerRouter } from "./sellers";
import { runBuyer, LogLine } from "./buyer";

const app = express();
app.use(express.json());
app.use("/api", sellerRouter());

// ---------------------------------------------------------------- state API
let cache: { at: number; data: any } | null = null;

async function buildState() {
  const sellerStates = [];
  for (const s of sellers) {
    const st = await suretyRead.sellers(s.wallet.address);
    let rep = { count: 0, avg: null as number | null };
    try {
      const [c, v, d] = await repRead.getSummary(s.agentId, [dep.surety], "surety", "");
      rep = { count: Number(c), avg: Number(c) ? Number(v) / 10 ** Number(d) : null };
    } catch {}
    sellerStates.push({
      key: s.key,
      name: s.name,
      blurb: s.blurb,
      address: s.wallet.address,
      agentId: s.agentId.toString(),
      price: fmtUsdc(s.priceUsdc),
      mode: s.mode,
      bond: fmtUsdc(BigInt(st.bond)),
      locked: fmtUsdc(BigInt(st.locked)),
      completed: Number(st.completed),
      failed: Number(st.failed),
      volume: fmtUsdc(BigInt(st.volume)),
      rep,
    });
  }
  const orders = indexer.recent(25);
  let slashed = 0n;
  let refunded = 0;
  let settled = 0;
  for (const o of indexer.orders.values()) {
    if (o.status === "refunded") {
      refunded++;
      slashed += BigInt(o.slashed ?? 0);
    }
    if (o.status === "settled") settled++;
  }
  return {
    network: NETWORK,
    chainId: dep.chainId,
    explorer: EXPLORER,
    contracts: {
      surety: dep.surety,
      usdc: dep.usdc,
      identity: dep.identityRegistry,
      reputation: dep.reputationRegistry,
      priceVerifier: dep.priceVerifier,
      feed: dep.avaxUsdFeed,
    },
    rules: { toleranceBps: TOLERANCE_BPS, durationSeconds: DURATION_S },
    buyer: { address: buyerW.wallet.address, usdc: fmtUsdc(BigInt(await usdcRead.balanceOf(buyerW.wallet.address))) },
    sellers: sellerStates,
    totals: { orders: indexer.orders.size, settled, refunded, slashedUsdc: fmtUsdc(slashed) },
    orders,
  };
}

app.get("/api/state", async (_req, res) => {
  try {
    if (!cache || Date.now() - cache.at > 1200) cache = { at: Date.now(), data: await buildState() };
    res.json(cache.data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------- buyer agent / swarm (SSE)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One demo run at a time. A public deployment must not let strangers drain the demo wallets with parallel runs.
let runInProgress = false;

app.get("/api/agent/run", async (req, res) => {
  const n = Math.min(Math.max(Number(req.query.agents) || 1, 1), 6);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const send = (event: string, data: any) => res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);

  if (runInProgress) {
    send("log", { agent: "Demo", kind: "bad", text: "Another demo run is in progress. Wait for it to finish, then try again." });
    send("done", { results: [] });
    return res.end();
  }
  runInProgress = true;
  const emit = (l: LogLine) => {
    cache = null;
    send("log", l);
  };

  try {
    // Swarm agents start staggered so later agents can learn from earlier outcomes.
    const jobs = Array.from({ length: n }, (_, i) =>
      (async () => {
        await sleep(i * 6000);
        return runBuyer(n === 1 ? "Buyer agent" : `Agent ${i + 1}`, emit);
      })().catch((e) => {
        emit({ agent: `Agent ${i + 1}`, text: `Error: ${e.shortMessage || e.message}`, kind: "bad" });
        return { ok: false };
      })
    );
    const results = await Promise.all(jobs);
    send("done", { results });
  } finally {
    runInProgress = false;
    res.end();
  }
});

// ------------------------------------- keeper: permissionless timeout refunds
// Anyone may call claimTimeout once a deadline passes. This loop is just one such "anyone".
const claiming = new Set<number>();
async function keeperTick() {
  await indexer.poll();
  const now = Math.max((await provider.getBlock("latest"))!.timestamp, Math.floor(Date.now() / 1000));
  for (const o of indexer.orders.values()) {
    if (o.status !== "open" || o.deadline >= now || claiming.has(o.id)) continue;
    claiming.add(o.id);
    try {
      const c = new Contract(dep.surety, SURETY_ABI, keeper.signer);
      const tx = await c.claimTimeout(o.id);
      await tx.wait();
      console.log(`keeper: claimed timeout on order #${o.id}`);
      cache = null;
    } catch (e: any) {
      console.error(`keeper: order #${o.id}:`, e.shortMessage || e.message);
    } finally {
      claiming.delete(o.id);
    }
  }
}

app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, async () => {
  console.log(`Surety demo on http://localhost:${PORT}  (${NETWORK}, surety ${dep.surety})`);
  await indexer.poll();
  console.log(`indexed ${indexer.orders.size} existing orders`);
  setInterval(() => indexer.poll(), 3000);
  setInterval(() => keeperTick().catch((e) => console.error("keeper:", e.message)), 4000);
});
