# Surety

**Money-back guarantees for the machine economy, on Avalanche.**

AI agents are starting to pay for data and services per call (x402). Today they pay first and trust blindly: if the
seller returns garbage there is no refund path. Surety makes every call refundable.

- The seller (an ERC-8004 agent) locks a **USDC bond**.
- The buyer pays into **escrow** with a gasless EIP-3009 authorization (x402-style: HTTP 402, then a signed payment).
- The seller **delivers the result on-chain** and a **deterministic verifier** (a pure Solidity function) checks it.
- **Pass:** seller is paid and earns reputation. **Fail or late:** buyer is refunded **2x** (their price back plus an
  equal amount slashed from the seller's bond). Anyone can force the refund after the deadline, so funds cannot get stuck.
- Reputation is written to the **ERC-8004 Reputation Registry only after a settled order**, with the Surety contract as
  the sole feedback author. Buyers filter on that author, so reputation cannot be farmed with fake clients.

## Live on Avalanche Fuji (chain 43113)

Links open the official Avalanche explorer (`explorer-test.avax.network`). Snowtrace and SnowScan also index Fuji but may show a bot check.

| Contract | Address |
|---|---|
| Surety | [`0x18ccaE1b7F89c3aDB3C3A2a5Be738DbB944DaD70`](https://explorer-test.avax.network/c-chain/address/0x18ccaE1b7F89c3aDB3C3A2a5Be738DbB944DaD70) |
| PriceReferenceVerifier | [`0x2Bc51d4e96879Be794585Cc494F2e6f0B89E6dE6`](https://explorer-test.avax.network/c-chain/address/0x2Bc51d4e96879Be794585Cc494F2e6f0B89E6dE6) |
| HashCommitVerifier | [`0x7272AE862758893F3891861185e7E47bCD1AFab6`](https://explorer-test.avax.network/c-chain/address/0x7272AE862758893F3891861185e7E47bCD1AFab6) |
| Test USDC (EIP-3009) | [`0x491B5dcFa9bfb1d0608cbF18D7C724850543e6A1`](https://explorer-test.avax.network/c-chain/address/0x491B5dcFa9bfb1d0608cbF18D7C724850543e6A1) |
| ERC-8004 Identity Registry (official) | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://explorer-test.avax.network/c-chain/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) |
| ERC-8004 Reputation Registry (official) | [`0x8004B663056A597Dffe9eCcC1965A193B7388713`](https://explorer-test.avax.network/c-chain/address/0x8004B663056A597Dffe9eCcC1965A193B7388713) |
| Chainlink AVAX/USD (official) | [`0x5498BB86BC934c8D34FDA08E81D444153d0D06aD`](https://explorer-test.avax.network/c-chain/address/0x5498BB86BC934c8D34FDA08E81D444153d0D06aD) |

Sellers are real ERC-8004 agents: Atlas Oracle is agent #255 and Basil Feeds is agent #256.

Real transactions you can open (each is one of the scenarios from the demo):

| Scenario | Transaction |
|---|---|
| Honest delivery, verified against Chainlink, seller paid | [order #1 settle](https://explorer-test.avax.network/c-chain/tx/0xccf71a264f9a9e5dd8df2ce9ce613b5813c5778364426726025dbe7a2ce9b2f7) |
| Seller lied (+12%): buyer refunded 2x, bond slashed | [order #2 refund](https://explorer-test.avax.network/c-chain/tx/0x97b27ebca297387885f9676dc14c293840d24e5f48f50f9eae7c0a110171a3cd) |
| Seller went silent: anyone forces the refund after the deadline | [order #4 timeout refund](https://explorer-test.avax.network/c-chain/tx/0x2ebb10ca43854e70d2174a268577c2c0041fd65e535fe3bae5d1800e3f485524) |

Verified by running the full flow on Fuji with the official registries: honest buy, lie then refund+slash, the buyer agent
rerouting away from the cheater using only the ERC-8004 reputation, timeout refund, and a 3-agent swarm.

**Found by testing on the real registry:** a first deployment wrote no reputation, because the caught `giveFeedback` call ran out
of gas under the transaction's estimated gas limit. That also meant a cheating seller could under-gas `deliver` to skip its bad
mark. Surety now requires enough gas for the feedback call or the whole transaction reverts (covered by a test).

## Why it is different

Escrow for agents exists on other chains (MeshLedger, PayCrow, x402r, Fortytwo's escrow). Surety's combination:

1. **Bond + slashing** (the seller has skin in the game, the buyer is paid for the inconvenience, not just refunded).
2. **Payment-gated reputation** through the official ERC-8004 registries on Avalanche (self-feedback is blocked by the
   registry, `getSummary` requires a client list, so Surety-authored entries are the trusted set).
3. **Verification a contract can run**, not a promise: price vs Chainlink within a tolerance, or exact-hash match.
4. **Terms-bound payments:** the EIP-3009 nonce is a hash of the exact terms, so a relayer cannot redirect the money.

## Honest scope

- Verifiers are deterministic only (price vs on-chain feed, hash commit, deadline). Subjective quality ("was this summary
  good?") needs an AI/validator layer; that is roadmap, not shipped.
- A cheater can still be detected only for checks the contract can run. A seller that can pass the check while being
  useless to the buyer is outside this MVP.
- Testnet uses an open-faucet test token with the same EIP-3009 interface as Circle's USDC. Mainnet uses real USDC.

## Architecture

```
contracts/
  Surety.sol                    bond registry, escrow, deliver / settle / refund+slash, timeout, ERC-8004 feedback
  verifiers/PriceReferenceVerifier.sol   price within N bps of a Chainlink feed
  verifiers/HashCommitVerifier.sol       exact bytes the buyer committed to
  SuretyUSDC.sol                testnet token (EIP-3009 receiveWithAuthorization)
server/                         Express: seller endpoints (HTTP 402), buyer agent (+swarm), indexer, keeper, state API
public/index.html               dashboard: sellers, "make it lie", agent log, live orders
```

Flow: `GET /price -> 402 + terms` -> buyer signs EIP-3009 (nonce = hash of terms) -> seller relays `openOrder`
(buyer needs no gas) -> seller `deliver(result)` -> verifier runs inside the tx -> `OrderSettled` or `OrderRefunded`
+ `giveFeedback` on the ERC-8004 Reputation Registry.

## Run it

Requires Node 20+.

```bash
npm install
npm run wallets          # creates throwaway wallets in .env (gitignored) and prints addresses
```

### Local (no faucet needed)
```bash
npm run local:node       # terminal 1
npm run local:deploy     # terminal 2 (mock ERC-8004 registries + feed, two bonded sellers)
npm run start:local      # terminal 2, then open http://localhost:8787
```

### Avalanche Fuji
1. Fund the DEPLOYER address printed by `npm run wallets` from the Fuji faucet (about 3 AVAX).
2. ```bash
   npm run deploy:fuji     # deploys Surety + verifiers + test USDC against the OFFICIAL ERC-8004 registries
   npm run setup:fuji      # funds the other wallets, registers two ERC-8004 agents, posts bonds
   npm start               # http://localhost:8787
   ```
3. Optional mainnet: set `USDC_ADDRESS` to Circle USDC and run `npm run deploy:mainnet`, then `SURETY_NETWORK=avalanche npm start`.

### Tests
```bash
npm test                 # 13 contract tests
```

## Official addresses used (verified by eth_getCode on Fuji)

| Item | Fuji |
|---|---|
| ERC-8004 Identity Registry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation Registry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Chainlink AVAX/USD | `0x5498BB86BC934c8D34FDA08E81D444153d0D06aD` |

## License
MIT. The SDK-style pieces (verifier interface, EIP-3009 terms binding) are meant to be reused by other builders.
