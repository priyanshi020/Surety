import "dotenv/config";
import { Contract, JsonRpcProvider, NonceManager, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { SURETY_ABI, USDC_ABI, REPUTATION_ABI, FEED_ABI } from "./abis";

export const NETWORK = (process.argv.includes("--local") ? "local" : process.env.SURETY_NETWORK || "fuji") as "fuji" | "avalanche" | "local";

const depPath = path.join(__dirname, "..", "deployments", `${NETWORK}.json`);
if (!fs.existsSync(depPath)) {
  throw new Error(`Missing ${depPath}. Run: npm run deploy:fuji`);
}
export const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));

const RPC =
  NETWORK === "local"
    ? "http://127.0.0.1:8545"
    : NETWORK === "fuji"
      ? process.env.FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc"
      : process.env.AVAX_RPC || "https://api.avax.network/ext/bc/C/rpc";

export const provider = new JsonRpcProvider(RPC, dep.chainId, { staticNetwork: true });
export const EXPLORER = NETWORK === "fuji" ? "https://explorer-test.avax.network/c-chain" : NETWORK === "local" ? "" : "https://subnets.avax.network/c-chain";
export const PORT = Number(process.env.PORT || 8787);

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing in .env`);
  return v;
}

const mk = (k: string) => {
  const wallet = new Wallet(need(k), provider);
  return { wallet, signer: new NonceManager(wallet) };
};

export const keeper = mk("DEPLOYER_KEY"); // pays gas for permissionless timeout claims
export const buyerW = mk("BUYER_KEY");

export type Mode = "honest" | "skew" | "stall";

export interface SellerCfg {
  key: "atlas" | "basil";
  name: string;
  blurb: string;
  wallet: Wallet;
  signer: NonceManager;
  agentId: bigint;
  priceUsdc: bigint; // 6 decimals
  mode: Mode;
}

const a = mk("SELLER_A_KEY");
const b = mk("SELLER_B_KEY");

export const sellers: SellerCfg[] = [
  {
    key: "atlas",
    name: "Atlas Oracle",
    blurb: "Premium price feed. Higher price, long track record.",
    ...a,
    agentId: BigInt(dep.agents?.atlas ?? need("SELLER_A_AGENT_ID")),
    priceUsdc: 300_000n, // 0.30
    mode: "honest",
  },
  {
    key: "basil",
    name: "Basil Feeds",
    blurb: "Budget price feed. Cheaper, so buyers try it first.",
    ...b,
    agentId: BigInt(dep.agents?.basil ?? need("SELLER_B_AGENT_ID")),
    priceUsdc: 200_000n, // 0.20
    mode: "honest",
  },
];

export const suretyRead = new Contract(dep.surety, SURETY_ABI, provider);
export const usdcRead = new Contract(dep.usdc, USDC_ABI, provider);
export const repRead = new Contract(dep.reputationRegistry, REPUTATION_ABI, provider);
export const feedRead = new Contract(dep.avaxUsdFeed, FEED_ABI, provider);

export const TOLERANCE_BPS = 300; // delivered price must be within 3% of the Chainlink AVAX/USD feed
export const DURATION_S = 20; // seller has 20s to deliver or anyone can force a refund

export const fmtUsdc = (v: bigint) => (Number(v) / 1e6).toFixed(2);
