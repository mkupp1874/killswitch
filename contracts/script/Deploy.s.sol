// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {KillSwitchVault, IERC20} from "../src/KillSwitchVault.sol";

/// Deploys a KillSwitchVault on Arc Testnet against Arc's USDC ERC-20 interface (6 decimals).
///   PRIVATE_KEY=0x... AGENT_ADDRESS=0x... forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast
/// The deployer becomes the vault owner (the user's app wallet).
contract Deploy is Script {
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address owner = vm.addr(pk);
        address agent = vm.envOr("AGENT_ADDRESS", owner);
        uint96 agentCeiling = uint96(vm.envOr("AGENT_MAX_CAP_USDC", uint256(5)) * 1e6);

        vm.startBroadcast(pk);
        KillSwitchVault vault = new KillSwitchVault(IERC20(ARC_USDC), owner, agent, agentCeiling);
        vm.stopBroadcast();

        console.log("KillSwitchVault:", address(vault));
        console.log("Owner:          ", owner);
        console.log("Agent:          ", agent);
    }
}
