// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev Test-only stand-ins that mimic the real ERC-8004 registries' behaviour that Surety depends on.
contract MockIdentityRegistry is ERC721 {
    uint256 public nextId = 1;

    constructor() ERC721("MockAgent", "AGENT") {}

    function register() external returns (uint256 id) {
        id = nextId++;
        _mint(msg.sender, id);
    }

    /// @dev mirrors the real registry's register(string agentURI)
    function register(string calldata) external returns (uint256 id) {
        id = nextId++;
        _mint(msg.sender, id);
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        address owner = ownerOf(agentId);
        return spender == owner || getApproved(agentId) == spender || isApprovedForAll(owner, spender);
    }
}

contract MockReputationRegistry {
    MockIdentityRegistry public identity;

    struct Entry {
        address client;
        int128 value;
        string tag1;
        string tag2;
    }

    mapping(uint256 => Entry[]) public feedback;
    bool public shouldRevert;

    constructor(MockIdentityRegistry identity_) {
        identity = identity_;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8,
        string calldata tag1,
        string calldata tag2,
        string calldata,
        string calldata,
        bytes32
    ) external {
        require(!shouldRevert, "registry down");
        require(!identity.isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed");
        feedback[agentId].push(Entry(msg.sender, value, tag1, tag2));
    }

    function count(uint256 agentId) external view returns (uint256) {
        return feedback[agentId].length;
    }

    /// @dev mirrors the real getSummary: only counts feedback authored by the given clients
    function getSummary(uint256 agentId, address[] calldata clients, string calldata tag1, string calldata)
        external
        view
        returns (uint64 n, int128 avg, uint8 decimals_)
    {
        require(clients.length > 0, "clientAddresses required");
        int256 sum;
        Entry[] storage list = feedback[agentId];
        for (uint256 i = 0; i < list.length; i++) {
            bool match_;
            for (uint256 j = 0; j < clients.length; j++) if (clients[j] == list[i].client) match_ = true;
            if (match_ && keccak256(bytes(list[i].tag1)) == keccak256(bytes(tag1))) {
                sum += list[i].value;
                n++;
            }
        }
        avg = n == 0 ? int128(0) : int128(sum / int256(uint256(n)));
        decimals_ = 0;
    }
}

contract MockAggregator {
    int256 public answer;

    constructor(int256 a) {
        answer = a;
    }

    function set(int256 a) external {
        answer = a;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
