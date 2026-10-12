import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { ERC8004 } from "../server/abis";

async function main() {
  const net = network.name as "fuji" | "avalanche";
  const reg = ERC8004[net];
  if (!reg) throw new Error(`No ERC-8004 config for network ${net}`);

  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer ${deployer.address} on ${net}, balance ${ethers.formatEther(bal)} AVAX`);
  if (bal === 0n) throw new Error("Deployer has no AVAX. Use the faucet first.");

  // Testnet uses our open-faucet EIP-3009 token; mainnet must use real USDC (set USDC_ADDRESS).
  let usdcAddr = process.env.USDC_ADDRESS;
  if (!usdcAddr) {
    if (net === "avalanche") throw new Error("Set USDC_ADDRESS for mainnet (Circle USDC).");
    const usdc = await (await ethers.getContractFactory("SuretyUSDC")).deploy();
    await usdc.waitForDeployment();
    usdcAddr = await usdc.getAddress();
    console.log("SuretyUSDC (test token):", usdcAddr);
  }

  const priceV = await (await ethers.getContractFactory("PriceReferenceVerifier")).deploy();
  await priceV.waitForDeployment();
  const hashV = await (await ethers.getContractFactory("HashCommitVerifier")).deploy();
  await hashV.waitForDeployment();

  const surety = await (await ethers.getContractFactory("Surety")).deploy(usdcAddr, reg.identity, reg.reputation);
  await surety.waitForDeployment();

  await (await surety.setVerifier(await priceV.getAddress(), true)).wait();
  await (await surety.setVerifier(await hashV.getAddress(), true)).wait();

  const deployBlock = (await surety.deploymentTransaction()!.wait())!.blockNumber;
  const isTestToken = !process.env.USDC_ADDRESS;
  const out = {
    network: net,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deployBlock,
    usdc: usdcAddr,
    // EIP-712 domain of the payment token (Circle USDC on Avalanche is "USDC" / "2")
    usdcDomain: isTestToken
      ? { name: "Surety Test USDC", version: "2" }
      : { name: process.env.USDC_EIP712_NAME || "USDC", version: process.env.USDC_EIP712_VERSION || "2" },
    surety: await surety.getAddress(),
    priceVerifier: await priceV.getAddress(),
    hashVerifier: await hashV.getAddress(),
    identityRegistry: reg.identity,
    reputationRegistry: reg.reputation,
    avaxUsdFeed: reg.avaxUsdFeed,
  };
  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "deployments", `${net}.json`), JSON.stringify(out, null, 2));
  console.log(out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
