// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "../Surety.sol";

/// @notice Passes if keccak256(result) equals a hash the buyer committed to up front
/// (e.g. "deliver the exact file whose hash I already know").
/// params = abi.encode(bytes32 expectedHash)
contract HashCommitVerifier is IVerifier {
    function verify(bytes calldata params, bytes calldata result, uint256, uint256)
        external
        pure
        returns (bool ok, string memory reason)
    {
        if (params.length != 32) return (false, "bad params");
        bytes32 expected = abi.decode(params, (bytes32));
        if (keccak256(result) != expected) return (false, "hash mismatch");
        return (true, "hash match");
    }
}
