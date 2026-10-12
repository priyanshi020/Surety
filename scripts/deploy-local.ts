// Full local stack on `npx hardhat node`: mock ERC-8004 registries + feed, Surety, two bonded sellers.
// Lets the whole product (server, dashboard, agents, swarm) be exercised without faucet funds.
import "dotenv/config";
import { ethers, network } from "hardhat";
import { Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

async function main() {
  if (network.name !== "localhost") throw new Error("Run with --network localhost");
  const provider = ethers.provider;
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} missing (npm run wallets)`);
    return v;
  };
  const deployer = new Wallet(need("DEPLOYER_KEY"), provider);
  const sellerA = new Wallet(need("SELLER_A_KEY"), provider);
  const sellerB = new Wallet(need("SELLER_B_KEY"), provider);
  const buyer = new Wallet(need("BUYER_KEY"), provider);

  for (const w of [deployer, sellerA, sellerB, buyer]) {
    await provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]); // 100 AVAX
  }

  let refPrice = 10.32;
  try {
    const j: any = await (await fetch("https://api.binance.com/api/v3/ticker/price?symbol=AVAXUSDT")).json();
    if (Number(j.price) > 0) refPrice = Number(j.price);
  } catch {}

  const F = async (n: string, ...a: any[]) => {
    const c = await (await ethers.getContractFactory(n, deployer)).deploy(...a);
    await c.waitForDeployment();
    return c;
  };
  const usdc = await F("SuretyUSDC");
  const identity = await F("MockIdentityRegistry");
  const rep = await F("MockReputationRegistry", await identity.getAddress());
  const feed = await F("MockAggregator", BigInt(Math.round(refPrice * 1e8)));
  const priceV = await F("PriceReferenceVerifier");
  const hashV = await F("HashCommitVerifier");
  const surety = await F("Surety", await usdc.getAddress(), await identity.getAddress(), await rep.getAddress());
  await (await (surety as any).setVerifier(await priceV.getAddress(), true)).wait();
  await (await (surety as any).setVerifier(await hashV.getAddress(), true)).wait();
  const deployBlock = (await surety.deploymentTransaction()!.wait())!.blockNumber;

  const BOND = 100_000_000n;
  const agents: Record<string, number> = {};
  for (const [key, w] of [["atlas", sellerA], ["basil", sellerB]] as const) {
    await (await (usdc as any).faucet(w.address, 500_000_000n)).wait();
    const idc = identity.connect(w) as any;
    const rc = await (await idc["register(string)"]("data:,local")).wait();
    const t = ethers.id("Transfer(address,address,uint256)");
    const log = rc.logs.find((l: any) => l.topics[0] === t && l.topics.length === 4);
    const agentId = BigInt(log.topics[3]);
    agents[key] = Number(agentId);
    await (await (usdc.connect(w) as any).approve(await surety.getAddress(), BOND)).wait();
    await (await (surety.connect(w) as any).registerSeller(agentId, BOND)).wait();
  }
  await (await (usdc as any).faucet(buyer.address, 200_000_000n)).wait();

  const out = {
    network: "local",
    chainId: 31337,
    deployedAt: new Date().toISOString(),
    deployBlock,
    usdc: await usdc.getAddress(),
    usdcDomain: { name: "Surety Test USDC", version: "2" },
    surety: await surety.getAddress(),
    priceVerifier: await priceV.getAddress(),
    hashVerifier: await hashV.getAddress(),
    identityRegistry: await identity.getAddress(),
    reputationRegistry: await rep.getAddress(),
    avaxUsdFeed: await feed.getAddress(),
    agents,
  };
  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "deployments", "local.json"), JSON.stringify(out, null, 2));
  console.log("local stack ready", out);
}
main().catch((e) => { console.error(e); process.exit(1); });
