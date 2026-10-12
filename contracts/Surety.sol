// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IERC3009Receive {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @dev Minimal view of the ERC-8004 Identity Registry (ERC-721 based).
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}

/// @dev Minimal view of the ERC-8004 Reputation Registry.
interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;
}

/// @notice A deterministic check a contract can run on a delivered result.
interface IVerifier {
    function verify(bytes calldata params, bytes calldata result, uint256 openedAt, uint256 deliveredAt)
        external
        view
        returns (bool ok, string memory reason);
}

/// @title Surety
/// @notice Bonded, refundable agent APIs. Sellers (ERC-8004 agents) lock a USDC bond. Buyers pay into
/// escrow through an EIP-3009 authorization (x402-style, gasless for the buyer). The seller delivers the
/// result on-chain and a deterministic verifier checks it. Pass: seller is paid. Fail or timeout: buyer is
/// refunded PLUS the seller's bond is slashed to the buyer. Reputation is written to the ERC-8004
/// Reputation Registry only after a settled order, with this contract as the sole feedback author.
contract Surety is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Settled,
        Refunded
    }

    struct Seller {
        uint256 agentId; // ERC-8004 identity
        uint128 bond; // total USDC bond
        uint128 locked; // bond locked behind open orders
        uint32 completed;
        uint32 failed;
        uint128 volume; // lifetime USDC settled to the seller
        bool registered;
    }

    struct Order {
        address buyer;
        address seller;
        uint128 price;
        uint64 openedAt;
        uint64 deadline;
        Status status;
        address verifier;
        bytes params;
    }

    struct Terms {
        address seller;
        uint128 price;
        uint32 duration; // seconds the seller has to deliver
        address verifier;
        bytes params;
    }

    struct Auth {
        address buyer;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 salt;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    int128 public constant SCORE_PASS = 100;
    int128 public constant SCORE_FAIL = 0;
    uint256 public constant FEEDBACK_GAS = 400_000;
    uint32 public constant MIN_DURATION = 5;
    uint32 public constant MAX_DURATION = 1 days;
    uint256 public constant MAX_RESULT_BYTES = 1024;

    IERC20 public immutable usdc;
    IIdentityRegistry public immutable identity;
    IReputationRegistry public immutable reputation;

    mapping(address => Seller) public sellers;
    address[] public sellerList;
    mapping(address => bool) public allowedVerifiers;
    mapping(uint256 => Order) public orders;
    uint256 public orderCount;

    event SellerRegistered(address indexed seller, uint256 indexed agentId, uint256 bond);
    event BondAdded(address indexed seller, uint256 amount);
    event BondWithdrawn(address indexed seller, uint256 amount);
    event VerifierSet(address indexed verifier, bool allowed);
    event OrderOpened(
        uint256 indexed orderId,
        address indexed buyer,
        address indexed seller,
        uint256 price,
        uint64 deadline,
        address verifier,
        bytes params
    );
    event ResultDelivered(uint256 indexed orderId, bytes result, bool ok, string reason);
    event OrderSettled(uint256 indexed orderId, address indexed seller, uint256 paid);
    event OrderRefunded(
        uint256 indexed orderId, address indexed buyer, address indexed seller, uint256 refund, uint256 slashed, string reason
    );
    event FeedbackFailed(uint256 indexed orderId);

    constructor(address usdc_, address identity_, address reputation_) Ownable(msg.sender) {
        usdc = IERC20(usdc_);
        identity = IIdentityRegistry(identity_);
        reputation = IReputationRegistry(reputation_);
    }

    // ---------------------------------------------------------------- admin

    function setVerifier(address verifier, bool allowed) external onlyOwner {
        allowedVerifiers[verifier] = allowed;
        emit VerifierSet(verifier, allowed);
    }

    // --------------------------------------------------------------- sellers

    /// @notice Register as a seller. Caller must own the ERC-8004 agent NFT. Requires prior USDC approval.
    function registerSeller(uint256 agentId, uint128 bondAmount) external nonReentrant {
        Seller storage s = sellers[msg.sender];
        require(!s.registered, "already registered");
        require(bondAmount > 0, "bond required");
        require(identity.ownerOf(agentId) == msg.sender, "not agent owner");

        s.agentId = agentId;
        s.bond = bondAmount;
        s.registered = true;
        sellerList.push(msg.sender);
        usdc.safeTransferFrom(msg.sender, address(this), bondAmount);
        emit SellerRegistered(msg.sender, agentId, bondAmount);
    }

    function addBond(uint128 amount) external nonReentrant {
        Seller storage s = sellers[msg.sender];
        require(s.registered, "not a seller");
        s.bond += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit BondAdded(msg.sender, amount);
    }

    /// @notice Withdraw only bond that is not backing an open order.
    function withdrawBond(uint128 amount) external nonReentrant {
        Seller storage s = sellers[msg.sender];
        require(s.registered, "not a seller");
        require(s.bond - s.locked >= amount, "bond locked");
        s.bond -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- orders

    /// @notice The nonce a buyer must sign in their EIP-3009 authorization. Binds the payment to exact terms,
    /// so a relayer cannot redirect the money to a different seller, price, or verifier.
    function termsHash(Terms calldata t, bytes32 salt) public view returns (bytes32) {
        return keccak256(
            abi.encode(address(this), block.chainid, t.seller, t.price, t.duration, t.verifier, keccak256(t.params), salt)
        );
    }

    /// @notice Open an order. Anyone may relay (the seller usually does, so the buyer needs no gas).
    function openOrder(Terms calldata t, Auth calldata a) external nonReentrant returns (uint256 orderId) {
        Seller storage s = sellers[t.seller];
        require(s.registered, "unknown seller");
        require(allowedVerifiers[t.verifier], "verifier not allowed");
        require(t.price > 0, "price required");
        require(t.duration >= MIN_DURATION && t.duration <= MAX_DURATION, "bad duration");
        require(s.bond - s.locked >= t.price, "insufficient free bond");

        s.locked += t.price;
        orderId = ++orderCount;
        uint64 deadline = uint64(block.timestamp) + t.duration;
        orders[orderId] = Order({
            buyer: a.buyer,
            seller: t.seller,
            price: t.price,
            openedAt: uint64(block.timestamp),
            deadline: deadline,
            status: Status.Open,
            verifier: t.verifier,
            params: t.params
        });

        // Pull the buyer's funds into escrow. Reverts if the signed nonce does not match these exact terms.
        IERC3009Receive(address(usdc)).receiveWithAuthorization(
            a.buyer, address(this), t.price, a.validAfter, a.validBefore, termsHash(t, a.salt), a.v, a.r, a.s
        );

        emit OrderOpened(orderId, a.buyer, t.seller, t.price, deadline, t.verifier, t.params);
    }

    /// @notice Seller delivers the result on-chain. The verifier runs immediately: pass pays, fail refunds+slashes.
    function deliver(uint256 orderId, bytes calldata result) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.status == Status.Open, "not open");
        require(msg.sender == o.seller, "not seller");
        require(block.timestamp <= o.deadline, "deadline passed");
        require(result.length <= MAX_RESULT_BYTES, "result too large");

        bool ok;
        string memory reason;
        try IVerifier(o.verifier).verify(o.params, result, o.openedAt, block.timestamp) returns (bool ok_, string memory r_) {
            ok = ok_;
            reason = r_;
        } catch {
            ok = false;
            reason = "verifier reverted";
        }
        emit ResultDelivered(orderId, result, ok, reason);

        if (ok) {
            _settle(orderId, o, keccak256(result));
        } else {
            _refund(orderId, o, reason, keccak256(result));
        }
    }

    /// @notice Anyone can force a refund once the deadline has passed. Funds can never be stuck.
    function claimTimeout(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.status == Status.Open, "not open");
        require(block.timestamp > o.deadline, "not expired");
        _refund(orderId, o, "timeout", bytes32(0));
    }

    // -------------------------------------------------------------- internals

    function _settle(uint256 orderId, Order storage o, bytes32 evidence) internal {
        Seller storage s = sellers[o.seller];
        uint128 price = o.price;
        o.status = Status.Settled;
        s.locked -= price;
        s.completed += 1;
        s.volume += price;
        usdc.safeTransfer(o.seller, price);
        emit OrderSettled(orderId, o.seller, price);
        _feedback(orderId, s.agentId, SCORE_PASS, "settled", evidence);
    }

    function _refund(uint256 orderId, Order storage o, string memory reason, bytes32 evidence) internal {
        Seller storage s = sellers[o.seller];
        uint128 price = o.price;
        o.status = Status.Refunded;
        s.locked -= price;
        s.bond -= price; // slash: bond equal to the price goes to the buyer
        s.failed += 1;
        usdc.safeTransfer(o.buyer, uint256(price) * 2); // refund + slash
        emit OrderRefunded(orderId, o.buyer, o.seller, price, price, reason);
        _feedback(orderId, s.agentId, SCORE_FAIL, "refunded", evidence);
    }

    /// @dev Reputation is best-effort: a registry problem must never block or trap user funds.
    function _feedback(uint256 orderId, uint256 agentId, int128 value, string memory tag2, bytes32 evidence) internal {
        try reputation.giveFeedback{gas: FEEDBACK_GAS}(agentId, value, 0, "surety", tag2, "", "", evidence) {}
        catch {
            emit FeedbackFailed(orderId);
        }
    }

    // ------------------------------------------------------------------ views

    function sellerCount() external view returns (uint256) {
        return sellerList.length;
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return orders[orderId];
    }
}
