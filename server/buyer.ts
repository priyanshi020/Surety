import { hexlify, randomBytes, Signature } from "ethers";
import { buyerW, dep, fmtUsdc, PORT, repRead, sellers, suretyRead } from "./config";
import { indexer } from "./indexer";

export interface LogLine {
  agent: string;
  text: string;
  kind: "info" | "good" | "bad" | "chain";
  tx?: string;
}
export type Emit = (l: LogLine) => void;

interface Candidate {
  key: string;
  name: string;
  address: string;
  price: bigint;
  count: number;
  avg: number;
  successes: number;
  failures: number;
  bond: bigint;
  cost: number; // expected USDC cost per successful delivery
}

/** The buyer's belief about a seller comes from the ERC-8004 Reputation Registry, filtered to Surety as the only trusted author. */
async function assess(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const s of sellers) {
    const st = await suretyRead.sellers(s.wallet.address);
    let count = 0;
    let avg = 0;
    try {
      const [c, v, d] = await repRead.getSummary(s.agentId, [dep.surety], "surety", "");
      count = Number(c);
      avg = Number(v) / 10 ** Number(d);
    } catch {
      // registry unreachable: fall back to Surety's own counters
      count = Number(st.completed) + Number(st.failed);
      avg = count ? (Number(st.completed) / count) * 100 : 0;
    }
    const successes = Math.round((avg * count) / 100);
    const failures = count - successes;
    // Laplace-smoothed success probability; a failure weighs 3x because it costs the buyer time.
    const p = (successes + 1) / (successes + 3 * failures + 2);
    out.push({
      key: s.key,
      name: s.name,
      address: s.wallet.address,
      price: s.priceUsdc,
      count,
      avg,
      successes,
      failures,
      bond: BigInt(st.bond) - BigInt(st.locked),
      cost: Number(s.priceUsdc) / 1e6 / p,
    });
  }
  return out.sort((a, b) => a.cost - b.cost);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runBuyer(agent: string, emit: Emit) {
  const say = (text: string, kind: LogLine["kind"] = "info", tx?: string) => emit({ agent, text, kind, tx });
  say("Looking for a seller of AVAX/USD prices. I read reputation from the ERC-8004 registry, not from the seller.");
  const cands = await assess();
  for (const c of cands) {
    say(
      `${c.name}: $${fmtUsdc(c.price)}/call, ERC-8004 score ${c.count ? c.avg.toFixed(0) : "n/a"}/100 over ${c.count} sale(s) ` +
        `(${c.failures} failed), free bond $${fmtUsdc(c.bond)} -> expected cost per good answer $${c.cost.toFixed(2)}`
    );
  }
  const pick = cands[0];
  say(`Choosing ${pick.name} (lowest expected cost).`, "good");

  // 1. unpaid request -> HTTP 402 with machine-readable terms
  const base = `http://127.0.0.1:${PORT}/api/seller/${pick.key}`;
  const r402 = await fetch(`${base}/price`);
  const quote: any = await r402.json();
  say(`GET /price -> HTTP ${r402.status} Payment Required: $${fmtUsdc(BigInt(quote.terms.price))} escrowed, ${quote.terms.duration}s to deliver.`);

  // 2. never sign terms that do not match what we expect
  const t = quote.terms;
  if (t.seller.toLowerCase() !== pick.address.toLowerCase() || t.verifier.toLowerCase() !== dep.priceVerifier.toLowerCase() || BigInt(t.price) > 500_000n) {
    say("Terms look wrong (seller/verifier/price). Refusing to sign.", "bad");
    return { ok: false };
  }

  // 3. sign an EIP-3009 authorization to the escrow contract, with a nonce that commits to these exact terms
  const salt = hexlify(randomBytes(32));
  const nonce: string = await suretyRead.termsHash(t, salt);
  const validBefore = Math.floor(Date.now() / 1000) + 600;
  const sig = await buyerW.wallet.signTypedData(
    { name: dep.usdcDomain.name, version: dep.usdcDomain.version, chainId: dep.chainId, verifyingContract: dep.usdc },
    {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    { from: buyerW.wallet.address, to: dep.surety, value: t.price, validAfter: 0, validBefore, nonce }
  );
  const { v, r, s } = Signature.from(sig);
  say("Signed a gasless payment authorization bound to these exact terms. The money goes to escrow, not to the seller.");

  // 4. seller relays it and delivers
  const resp = await fetch(`${base}/buy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terms: t, auth: { buyer: buyerW.wallet.address, validAfter: 0, validBefore, salt, v, r, s } }),
  });
  const body: any = await resp.json();
  if (!resp.ok) {
    say(`Seller error: ${body.error}`, "bad");
    return { ok: false };
  }
  const orderId: number = body.orderId;
  say(`Order #${orderId} opened, funds locked in escrow.`, "chain", body.openTx);
  if (body.deliverTx) say("Seller delivered its answer on-chain; the verifier ran inside the transaction.", "chain", body.deliverTx);
  else say(`Seller has gone quiet. Deadline is ${t.duration}s. Anyone can force the refund after that.`, "bad");

  // 5. wait for the on-chain outcome
  let status = 1;
  for (let i = 0; i < 60 && status === 1; i++) {
    await sleep(1500);
    status = Number((await suretyRead.orders(orderId)).status);
  }
  // the indexer may lag the chain by a poll; wait until it has folded in the final event
  let rec = indexer.orders.get(orderId);
  for (let i = 0; i < 8 && (!rec || rec.status === "open"); i++) {
    await indexer.poll();
    rec = indexer.orders.get(orderId);
    if (rec && rec.status !== "open") break;
    await sleep(700);
  }
  // Net result for THIS order (the swarm shares one wallet, so wallet balance deltas would mix agents)
  const price = rec ? BigInt(rec.price) : 0n;
  const delta = status === 3 ? price : status === 2 ? -price : 0n;

  if (status === 2) {
    say(`SETTLED. Delivered price $${rec?.deliveredPrice ?? "?"} is within 3% of the Chainlink feed. ${pick.name} was paid and earned +1 reputation.`, "good", rec?.finalTx);
    return { ok: true, orderId, outcome: "settled", seller: pick.name, delta: delta.toString() };
  }
  if (status === 3) {
    say(
      `REFUNDED (${rec?.reason ?? "failed"}). I got my payment back PLUS an equal amount slashed from ${pick.name}'s bond: net +$${fmtUsdc(delta)}.`,
      "bad",
      rec?.finalTx
    );
    return { ok: true, orderId, outcome: "refunded", seller: pick.name, reason: rec?.reason, delta: delta.toString() };
  }
  say("Timed out waiting for the outcome.", "bad");
  return { ok: false, orderId };
}
