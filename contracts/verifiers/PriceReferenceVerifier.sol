// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerifier} from "../Surety.sol";

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Passes if the delivered price is within `maxDeviationBps` of an on-chain Chainlink feed.
/// params = abi.encode(address feed, uint256 maxDeviationBps)
/// result = abi.encode(int256 price) in the feed's own decimals
contract PriceReferenceVerifier is IVerifier {
    function verify(bytes calldata params, bytes calldata result, uint256, uint256)
        external
        view
        returns (bool ok, string memory reason)
    {
        if (params.length != 64) return (false, "bad params");
        if (result.length != 32) return (false, "bad result");

        (address feed, uint256 maxDeviationBps) = abi.decode(params, (address, uint256));
        int256 price = abi.decode(result, (int256));

        (, int256 ref,,,) = IAggregatorV3(feed).latestRoundData();
        if (ref <= 0 || price <= 0) return (false, "non-positive price");

        uint256 p = uint256(price);
        uint256 r = uint256(ref);
        uint256 diff = p > r ? p - r : r - p;
        if (diff * 10_000 > r * maxDeviationBps) return (false, "price deviates from reference");
        return (true, "within tolerance");
    }
}
