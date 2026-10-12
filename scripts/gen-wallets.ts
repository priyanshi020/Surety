// Generates throwaway demo wallets into .env (gitignored). Prints ADDRESSES only, never keys.
import { Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

const envPath = path.join(__dirname, "..", ".env");
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";

const roles = ["DEPLOYER", "SELLER_A", "SELLER_B", "BUYER"];
let out = existing;
for (const r of roles) {
  const key = `${r}_KEY`;
  if (new RegExp(`^${key}=`, "m").test(out)) {
    console.log(`${r}: already in .env, keeping`);
    continue;
  }
  const w = Wallet.createRandom();
  out += `${out && !out.endsWith("\n") ? "\n" : ""}${key}=${w.privateKey}\n`;
}
fs.writeFileSync(envPath, out);

const get = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(out)?.[1]?.trim();
for (const r of roles) {
  const k = get(`${r}_KEY`);
  if (k) console.log(`${r.padEnd(9)} ${new Wallet(k).address}`);
}
console.log("\nFund DEPLOYER with ~3 Fuji AVAX from https://core.app/tools/testnet-faucet/?subnet=c&token=c");
