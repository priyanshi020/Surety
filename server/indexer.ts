import { AbiCoder } from "ethers";
import { dep, provider, suretyRead } from "./config";

const coder = AbiCoder.defaultAbiCoder();

export interface OrderRec {
  id: number;
  buyer: string;
  seller: string;
  price: string; // raw 6-dec
  deadline: number;
  status: "open" | "settled" | "refunded";
  reason?: string;
  deliveredPrice?: string; // USD with 8 decimals scaled to number string
  openTx?: string;
  finalTx?: string;
  slashed?: string;
  block: number;
  seenAt: number;
}

/** Tiny event indexer: scans Surety logs in <=2000-block chunks and folds them into per-order records. */
export class Indexer {
  orders = new Map<number, OrderRec>();
  private last = dep.deployBlock - 1;
  private inflight?: Promise<void>;

  /** Callers share one in-flight scan, so awaiting poll() really waits for fresh data. */
  poll(): Promise<void> {
    if (!this.inflight) this.inflight = this.scan().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async scan() {
    try {
      const head = await provider.getBlockNumber();
      while (this.last < head) {
        const from = this.last + 1;
        const to = Math.min(from + 1999, head);
        const logs = await provider.getLogs({ address: dep.surety, fromBlock: from, toBlock: to });
        for (const l of logs) this.apply(l);
        this.last = to;
      }
    } catch (e) {
      console.error("indexer:", (e as Error).message);
    }
  }

  private apply(l: any) {
    let p;
    try {
      p = suretyRead.interface.parseLog(l);
    } catch {
      return;
    }
    if (!p) return;
    const id = Number(p.args[0]);
    switch (p.name) {
      case "OrderOpened":
        this.orders.set(id, {
          id,
          buyer: p.args.buyer,
          seller: p.args.seller,
          price: p.args.price.toString(),
          deadline: Number(p.args.deadline),
          status: "open",
          openTx: l.transactionHash,
          block: l.blockNumber,
          seenAt: Date.now(),
        });
        break;
      case "ResultDelivered": {
        const o = this.orders.get(id);
        if (!o) break;
        o.reason = p.args.reason;
        try {
          o.deliveredPrice = (Number(coder.decode(["int256"], p.args.result)[0]) / 1e8).toFixed(4);
        } catch {}
        break;
      }
      case "OrderSettled": {
        const o = this.orders.get(id);
        if (!o) break;
        o.status = "settled";
        o.finalTx = l.transactionHash;
        break;
      }
      case "OrderRefunded": {
        const o = this.orders.get(id);
        if (!o) break;
        o.status = "refunded";
        o.reason = p.args.reason;
        o.slashed = p.args.slashed.toString();
        o.finalTx = l.transactionHash;
        break;
      }
    }
  }

  recent(n: number): OrderRec[] {
    return [...this.orders.values()].sort((a, b) => b.id - a.id).slice(0, n);
  }
}

export const indexer = new Indexer();
