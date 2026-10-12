// One-shot demo setup on Fuji: fund wallets, register two ERC-8004 agents, post bonds.
import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, parseEther, id as keccakId } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { SURETY_ABI, USDC_ABI, IDENTITY_ABI } from "../server/abis";

const RPC = process.env.FUJI_RPC || "https://api.avax-test.network/ext/bc/C/rpc";
const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "fuji.json"), "utf8"));
const provider = new JsonRpcProvider(RPC, 43113);
const must = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} missing in .env (run npm run wallets)`);
  return v;
};

const deployer = new Wallet(must("DEPLOYER_KEY"), provider);
const sellers = [
  { name: "Atlas Oracle", wallet: new Wallet(must("SELLER_A_KEY"), provider), env: "SELLER_A_AGENT_ID" },
  { name: "Basil Feeds", wallet: new Wallet(must("SELLER_B_KEY"), provider), env: "SELLER_B_AGENT_ID" },
];
const buyer = new Wallet(must("BUYER_KEY"), provider);

const BOND = 100_000_000n; // 100 tUSDC (6 decimals)

function agentUri(name: string, address: string) {
  const card = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name,
    description: `${name}: sells AVAX/USD prices. Every sale is bonded by Surety and refundable on failure.`,
    services: [{ name: "surety-price", endpoint: "surety://price/avax-usd" }],
    x402Support: true,
    active: true,
    registrations: [{ agentId: 0, agentRegistry: `eip155:43113:${dep.identityRegistry}` }],
    wallet: address,
  };
  return "data:application/json;base64," + Buffer.from(JSON.stringify(card)).toString("base64");
}

async function sendAvax(to: string, amount: string) {
  const bal = await provider.getBalance(to);
  if (bal >= parseEther(amount)) return console.log(`  ${to} already has ${amount}+ AVAX`);
  await (await deployer.sendTransaction({ to, value: parseEther(amount) - bal })).wait();
  console.log(`  funded ${to} with AVAX`);
}

async function main() {
  console.log("Deployer balance:", (await provider.getBalance(deployer.address)).toString());
  const usdc = new Contract(dep.usdc, USDC_ABI, deployer);
  const identity = new Contract(dep.identityRegistry, IDENTITY_ABI, deployer);
  const surety = new Contract(dep.surety, SURETY_ABI, deployer);

  console.log("1) Funding gas");
  for (const s of sellers) await sendAvax(s.wallet.address, "0.15");
  await sendAvax(buyer.address, "0.15");

  console.log("2) Test USDC");
  for (const s of sellers) await (await usdc.faucet(s.wallet.address, 500_000_000n)).wait();
  await (await usdc.faucet(buyer.address, 200_000_000n)).wait();

  console.log("3) Register ERC-8004 agents + post bonds");
  const envAdd: string[] = [];
  for (const s of sellers) {
    const sc = surety.connect(s.wallet) as Contract;
    const existing = await sc.sellers(s.wallet.address);
    if (existing.registered) {
      console.log(`  ${s.name} already registered as agent ${existing.agentId}`);
      envAdd.push(`${s.env}=${existing.agentId}`);
      continue;
    }
    const idc = identity.connect(s.wallet) as Contract;
    const rc = await (await idc.register(agentUri(s.name, s.wallet.address))).wait();
    const transferTopic = keccakId("Transfer(address,address,uint256)");
    const log = rc.logs.find((l: any) => l.topics[0] === transferTopic && l.topics.length === 4);
    if (!log) throw new Error("could not find agent id in registration receipt");
    const agentId = BigInt(log.topics[3]);
    console.log(`  ${s.name} -> ERC-8004 agent #${agentId}`);

    await ((usdc.connect(s.wallet) as Contract).approve(dep.surety, BOND)).then((t: any) => t.wait());
    await (await sc.registerSeller(agentId, BOND)).wait();
    console.log(`  ${s.name} posted bond 100 tUSDC`);
    envAdd.push(`${s.env}=${agentId}`);
  }

  const envPath = path.join(__dirname, "..", ".env");
  let env = fs.readFileSync(envPath, "utf8");
  for (const line of envAdd) {
    const [k] = line.split("=");
    env = new RegExp(`^${k}=`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), line) : env + (env.endsWith("\n") ? "" : "\n") + line + "\n";
  }
  fs.writeFileSync(envPath, env);
  console.log("Done. Agent ids saved to .env. Next: npm start");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
