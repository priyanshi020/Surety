# Submission kit: Team1 India Speedrun (Build Anything on Avalanche)

## Required fields

**Project name:** Surety

**One-line description:** Money-back guarantees for AI agents: every API call an agent buys is backed by the seller's bond,
and a wrong or missing answer is refunded 2x automatically on Avalanche.

**Full description (paste):**
AI agents are starting to pay for data and services per call using x402. They pay first and trust blindly, and x402 has no
refund path. Surety adds a trust layer. Sellers are ERC-8004 agents that lock a USDC bond. Buyers pay into escrow through a
gasless EIP-3009 authorization whose nonce commits to the exact terms. The seller delivers the answer on-chain and a
deterministic verifier (for example "price within 3% of the Chainlink AVAX/USD feed") runs inside the transaction. Pass:
seller is paid and gets reputation. Fail or late: the buyer gets their payment back plus an equal amount slashed from the
seller's bond, and anyone can force the refund after the deadline. Reputation is written to the official ERC-8004 Reputation
Registry only after a settled order and only by the Surety contract, so reputation cannot be faked with fake clients. A buyer
agent reads that reputation, picks the cheapest trustworthy seller, and reroutes after a seller cheats. Target users: teams
building agents that buy data/APIs, and API sellers who want to prove they are reliable.

**Tech stack (Avalanche parts in bold):** **Avalanche C-Chain (Fuji)**, **ERC-8004 Identity + Reputation registries**,
**Chainlink AVAX/USD feed on Avalanche**, x402-style HTTP 402 flow, EIP-3009 (USDC `receiveWithAuthorization`), Solidity 0.8.24
(Hardhat, OpenZeppelin), TypeScript, ethers v6, Express, vanilla-JS dashboard.

**Live link / contracts:** Fuji deployment is live. Surety: https://testnet.snowtrace.io/address/0x18ccaE1b7F89c3aDB3C3A2a5Be738DbB944DaD70
(all contract addresses and example transactions for settle, lie-then-refund, and timeout-refund are in the README under
"Live on Avalanche Fuji"). Repo with setup instructions: https://github.com/priyanshi020/Surety

**Source code:** this repository (MIT).

**AI tools used:** Claude Code for implementation help and test writing (informational).

**Bonus criteria to claim (only if actually done):** open-sourced reusable verifier interface and terms-binding pattern (MIT).
Mainnet deployment: tick this only after you deploy with real USDC. eERC, ICM and own L1 are not used; do not claim them.

**Pre-existing work:** none. Everything in this repo was built during the sprint.

## 3-minute demo script

| Time | Say / do |
|---|---|
| 0:00-0:20 | "AI agents now pay for APIs per call. If the seller returns garbage, the money is gone. There is no return policy." |
| 0:20-0:40 | "Surety is the return policy. Sellers lock a bond, payments sit in escrow, a contract checks the answer. Wrong answer: refund and the seller gets slashed." |
| 0:40-1:30 | Show dashboard: two sellers with bonds and ERC-8004 reputation. Click **Run buyer agent**. Read the log: 402 quote, gasless signature, order opened, delivered, **SETTLED**. Click the tx link to Snowtrace. |
| 1:30-2:20 | Click **Make it lie** on the cheaper seller. Run the agent again. It picks the cheap seller, gets a wrong price, and the log shows **REFUNDED, 2x**. Point at the bond dropping and the reputation falling. Run again: the agent now avoids that seller. |
| 2:20-2:50 | "The verifier is a pure Solidity function anyone can re-run. Reputation only exists behind settled payments, written by the Surety contract to the official ERC-8004 registry. If a seller goes silent, anyone can force the refund." Optionally click **Make it go silent** and show the timeout refund. |
| 2:50-3:00 | "Surety makes every agent API call refundable. Open source, live on Avalanche." |

Tip: for the cleanest recording run `npm run deploy:fuji` and `npm run setup:fuji` fresh so both sellers start with no history,
and use the swarm button only after the single-agent story is told.

## Questions judges may ask, and honest answers

- **"Escrow for agents already exists."** Yes, on other chains. We add bond + slashing, reputation that can only come from settled
  payments (via the official ERC-8004 registries), and contract-run verification, live on Avalanche.
- **"Who decides what a bad answer is?"** Only checks a contract can run: price within a tolerance of Chainlink, exact hash, deadline.
  Subjective quality needs validators; that is the roadmap, not claimed.
- **"Why Avalanche?"** The official ERC-8004 registries and Avalanche x402 facilitators are live there, finality is fast enough that
  per-call escrow and refunds feel instant, and fees make small per-call orders viable. It would work technically on other EVM chains.
- **"Can a seller cheat and not get caught?"** Not on checked dimensions: a wrong price or silence always ends in refund + slash.
  A seller that passes the check but is useless in some unchecked way is out of scope for this MVP.
- **"Can the relayer steal funds?"** No. The signed EIP-3009 nonce is a hash of the exact terms (seller, price, duration, verifier,
  params), and the escrow contract rejects any mismatch. Covered by tests.
- **"What if the reputation registry is down?"** Feedback is best-effort with a gas cap; funds never depend on it. Covered by a test.

## Slide outline (8 slides)
1. Problem: agents pay blindly, no refunds. 2. Solution in one sentence. 3. How it works (the 4-step strip from the dashboard).
4. Demo screenshot (lie -> refund 2x). 5. Why it is trustworthy (terms-bound payment, deterministic verifier, payment-gated reputation).
6. Avalanche usage (ERC-8004 registries, Chainlink feed, C-Chain, x402 flow). 7. Roadmap (AI validators, more verifiers, agent credit, cross-L1 reputation via ICM).
8. Links + team.
