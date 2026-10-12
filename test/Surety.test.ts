import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { AbiCoder, keccak256, randomBytes, hexlify } from "ethers";

const coder = AbiCoder.defaultAbiCoder();
const USDC = (n: number) => BigInt(Math.round(n * 1e6));

describe("Surety", () => {
  async function setup() {
    const [deployer, sellerA, buyer, relayer, stranger] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory("SuretyUSDC")).deploy();
    const identity = await (await ethers.getContractFactory("MockIdentityRegistry")).deploy();
    const rep = await (await ethers.getContractFactory("MockReputationRegistry")).deploy(await identity.getAddress());
    const feed = await (await ethers.getContractFactory("MockAggregator")).deploy(10n * 10n ** 8n); // $10.00
    const priceV = await (await ethers.getContractFactory("PriceReferenceVerifier")).deploy();
    const hashV = await (await ethers.getContractFactory("HashCommitVerifier")).deploy();
    const surety = await (
      await ethers.getContractFactory("Surety")
    ).deploy(await usdc.getAddress(), await identity.getAddress(), await rep.getAddress());

    await surety.setVerifier(await priceV.getAddress(), true);
    await surety.setVerifier(await hashV.getAddress(), true);

    // seller: register agent identity + bond 100 USDC
    await identity.connect(sellerA)["register()"]();
    await usdc.faucet(sellerA.address, USDC(500));
    await usdc.connect(sellerA).approve(await surety.getAddress(), USDC(500));
    await surety.connect(sellerA).registerSeller(1, USDC(100));

    await usdc.faucet(buyer.address, USDC(50));

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = {
      name: "Surety Test USDC",
      version: "2",
      chainId,
      verifyingContract: await usdc.getAddress(),
    };
    const types = {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    };

    async function signedOrder(terms: any, price = terms.price) {
      const salt = hexlify(randomBytes(32));
      const nonce = await surety.termsHash(terms, salt);
      const validAfter = 0n;
      const validBefore = BigInt((await time.latest()) + 3600);
      const sig = await buyer.signTypedData(domain, types, {
        from: buyer.address,
        to: await surety.getAddress(),
        value: price,
        validAfter,
        validBefore,
        nonce,
      });
      const { v, r, s } = ethers.Signature.from(sig);
      return { buyer: buyer.address, validAfter, validBefore, salt, v, r, s };
    }

    const priceTerms = (priceUsdc = 1, dur = 60, devBps = 300) => ({
      seller: sellerA.address,
      price: USDC(priceUsdc),
      duration: dur,
      verifier: priceV.target as string,
      params: coder.encode(["address", "uint256"], [feed.target, devBps]),
    });
    const priceResult = (p: number) => coder.encode(["int256"], [BigInt(Math.round(p * 1e8))]);

    return { deployer, sellerA, buyer, relayer, stranger, usdc, identity, rep, feed, priceV, hashV, surety, signedOrder, priceTerms, priceResult };
  }

  it("settles a correct delivery: seller paid, bond unlocked, reputation +100", async () => {
    const { surety, usdc, sellerA, relayer, signedOrder, priceTerms, priceResult, rep } = await setup();
    const t = priceTerms(1);
    const a = await signedOrder(t);
    await surety.connect(relayer).openOrder(t, a); // relayer pays gas, buyer needs none
    expect((await surety.sellers(sellerA.address)).locked).to.equal(USDC(1));

    const before = await usdc.balanceOf(sellerA.address);
    await surety.connect(sellerA).deliver(1, priceResult(10.1)); // +1% vs $10 ref, within 3%
    expect((await usdc.balanceOf(sellerA.address)) - before).to.equal(USDC(1));

    const s = await surety.sellers(sellerA.address);
    expect(s.completed).to.equal(1);
    expect(s.locked).to.equal(0);
    expect(s.bond).to.equal(USDC(100));
    expect((await surety.orders(1)).status).to.equal(2); // Settled
    expect((await rep.feedback(1, 0)).value).to.equal(100);
  });

  it("refunds buyer 2x and slashes bond when result fails verification", async () => {
    const { surety, usdc, sellerA, buyer, signedOrder, priceTerms, priceResult, rep } = await setup();
    const t = priceTerms(2);
    const a = await signedOrder(t);
    await surety.openOrder(t, a);
    const buyerBefore = await usdc.balanceOf(buyer.address); // already paid 2 into escrow

    await expect(surety.connect(sellerA).deliver(1, priceResult(12.0))) // +20%: cheating
      .to.emit(surety, "OrderRefunded")
      .withArgs(1, buyer.address, sellerA.address, USDC(2), USDC(2), "price deviates from reference");

    expect((await usdc.balanceOf(buyer.address)) - buyerBefore).to.equal(USDC(4)); // price back + equal slash
    const s = await surety.sellers(sellerA.address);
    expect(s.failed).to.equal(1);
    expect(s.bond).to.equal(USDC(98));
    expect(s.locked).to.equal(0);
    expect((await rep.feedback(1, 0)).value).to.equal(0);
  });

  it("anyone can force refund after the deadline (seller goes silent)", async () => {
    const { surety, usdc, buyer, stranger, signedOrder, priceTerms } = await setup();
    const t = priceTerms(1, 10);
    await surety.openOrder(t, await signedOrder(t));
    await expect(surety.connect(stranger).claimTimeout(1)).to.be.revertedWith("not expired");
    await time.increase(11);
    const before = await usdc.balanceOf(buyer.address);
    await surety.connect(stranger).claimTimeout(1);
    expect((await usdc.balanceOf(buyer.address)) - before).to.equal(USDC(2));
    expect((await surety.orders(1)).status).to.equal(3); // Refunded
  });

  it("seller cannot deliver after the deadline", async () => {
    const { surety, sellerA, signedOrder, priceTerms, priceResult } = await setup();
    const t = priceTerms(1, 10);
    await surety.openOrder(t, await signedOrder(t));
    await time.increase(11);
    await expect(surety.connect(sellerA).deliver(1, priceResult(10))).to.be.revertedWith("deadline passed");
  });

  it("payment is bound to exact terms: a relayer cannot redirect it", async () => {
    const { surety, stranger, signedOrder, priceTerms } = await setup();
    const t = priceTerms(1);
    const a = await signedOrder(t);
    const tampered = { ...t, price: USDC(5) };
    await expect(surety.openOrder(tampered, a)).to.be.revertedWith("invalid signature");
    const otherVerifier = { ...t, verifier: stranger.address };
    await expect(surety.openOrder(otherVerifier, a)).to.be.revertedWith("verifier not allowed");
  });

  it("an authorization cannot be replayed", async () => {
    const { surety, signedOrder, priceTerms } = await setup();
    const t = priceTerms(1);
    const a = await signedOrder(t);
    await surety.openOrder(t, a);
    await expect(surety.openOrder(t, a)).to.be.revertedWith("auth used");
  });

  it("locks bond behind open orders and blocks overselling", async () => {
    const { surety, sellerA, signedOrder, priceTerms } = await setup();
    const t = priceTerms(60);
    // buyer only has 50, so fund more for this test
    await expect(surety.connect(sellerA).withdrawBond(USDC(100))).not.to.be.reverted; // nothing locked yet
    // bond is now 0, so any order must fail
    await expect(surety.openOrder(t, await signedOrder(t))).to.be.revertedWith("insufficient free bond");
  });

  it("cannot withdraw bond that backs an open order", async () => {
    const { surety, sellerA, signedOrder, priceTerms } = await setup();
    const t = priceTerms(10);
    await surety.openOrder(t, await signedOrder(t));
    await expect(surety.connect(sellerA).withdrawBond(USDC(95))).to.be.revertedWith("bond locked");
    await surety.connect(sellerA).withdrawBond(USDC(90)); // exactly the free part
  });

  it("a broken reputation registry never traps funds", async () => {
    const { surety, usdc, sellerA, signedOrder, priceTerms, priceResult, rep } = await setup();
    await rep.setShouldRevert(true);
    const t = priceTerms(1);
    await surety.openOrder(t, await signedOrder(t));
    const before = await usdc.balanceOf(sellerA.address);
    await expect(surety.connect(sellerA).deliver(1, priceResult(10)))
      .to.emit(surety, "FeedbackFailed")
      .withArgs(1);
    expect((await usdc.balanceOf(sellerA.address)) - before).to.equal(USDC(1));
  });

  it("only the agent's owner can register as its seller", async () => {
    const { surety, stranger, usdc } = await setup();
    await usdc.faucet(stranger.address, USDC(10));
    await usdc.connect(stranger).approve(await surety.getAddress(), USDC(10));
    await expect(surety.connect(stranger).registerSeller(1, USDC(10))).to.be.revertedWith("not agent owner");
  });

  it("only the seller can deliver", async () => {
    const { surety, stranger, signedOrder, priceTerms, priceResult } = await setup();
    const t = priceTerms(1);
    await surety.openOrder(t, await signedOrder(t));
    await expect(surety.connect(stranger).deliver(1, priceResult(10))).to.be.revertedWith("not seller");
  });

  it("HashCommitVerifier: exact bytes pass, anything else is slashed", async () => {
    const { surety, sellerA, hashV, signedOrder } = await setup();
    const doc = ethers.toUtf8Bytes("the exact file the buyer asked for");
    const terms = {
      seller: sellerA.address,
      price: USDC(1),
      duration: 60,
      verifier: hashV.target as string,
      params: coder.encode(["bytes32"], [keccak256(doc)]),
    };
    await surety.openOrder(terms, await signedOrder(terms));
    await expect(surety.connect(sellerA).deliver(1, doc)).to.emit(surety, "OrderSettled");

    await surety.openOrder(terms, await signedOrder(terms));
    await expect(surety.connect(sellerA).deliver(2, ethers.toUtf8Bytes("something else"))).to.emit(
      surety,
      "OrderRefunded"
    );
  });
});
