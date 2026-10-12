// Human-readable ABIs shared by the server and setup scripts.

export const SURETY_ABI = [
  "function usdc() view returns (address)",
  "function orderCount() view returns (uint256)",
  "function sellerCount() view returns (uint256)",
  "function sellerList(uint256) view returns (address)",
  "function sellers(address) view returns (uint256 agentId, uint128 bond, uint128 locked, uint32 completed, uint32 failed, uint128 volume, bool registered)",
  "function orders(uint256) view returns (address buyer, address seller, uint128 price, uint64 openedAt, uint64 deadline, uint8 status, address verifier, bytes params)",
  "function termsHash((address seller,uint128 price,uint32 duration,address verifier,bytes params) t, bytes32 salt) view returns (bytes32)",
  "function openOrder((address seller,uint128 price,uint32 duration,address verifier,bytes params) t, (address buyer,uint256 validAfter,uint256 validBefore,bytes32 salt,uint8 v,bytes32 r,bytes32 s) a) returns (uint256)",
  "function deliver(uint256 orderId, bytes result)",
  "function claimTimeout(uint256 orderId)",
  "function registerSeller(uint256 agentId, uint128 bondAmount)",
  "function addBond(uint128 amount)",
  "function withdrawBond(uint128 amount)",
  "event OrderOpened(uint256 indexed orderId, address indexed buyer, address indexed seller, uint256 price, uint64 deadline, address verifier, bytes params)",
  "event ResultDelivered(uint256 indexed orderId, bytes result, bool ok, string reason)",
  "event OrderSettled(uint256 indexed orderId, address indexed seller, uint256 paid)",
  "event OrderRefunded(uint256 indexed orderId, address indexed buyer, address indexed seller, uint256 refund, uint256 slashed, string reason)",
  "event FeedbackFailed(uint256 indexed orderId)",
];

export const USDC_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function faucet(address to, uint256 amount)",
  "function decimals() view returns (uint8)",
];

export const IDENTITY_ABI = [
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

export const REPUTATION_ABI = [
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
];

export const FEED_ABI = [
  "function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)",
  "function decimals() view returns (uint8)",
];

// Official ERC-8004 deployments (verified with eth_getCode on Fuji; confirm mainnet before use).
export const ERC8004 = {
  fuji: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    avaxUsdFeed: "0x5498BB86BC934c8D34FDA08E81D444153d0D06aD",
  },
  avalanche: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
    // Chainlink AVAX/USD on C-Chain mainnet; verify before deploying.
    avaxUsdFeed: "0x0A77230d17318075983913bC2145DB16C7366156",
  },
} as const;
