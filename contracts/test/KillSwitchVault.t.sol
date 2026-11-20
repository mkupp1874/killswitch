// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {KillSwitchVault, IERC20} from "../src/KillSwitchVault.sol";
import {MockUSDC} from "./MockUSDC.sol";

contract KillSwitchVaultTest is Test {
    MockUSDC usdc;
    KillSwitchVault vault;

    address user = address(0x05E2);
    address agent = address(0xA6E7);
    address cloudTool = address(0xC10D);
    address weatherApi = address(0x3EA7);
    address rando = address(0xBAD);

    uint96 constant D = 1e6; // 1 USDC

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        vault = new KillSwitchVault(IERC20(address(usdc)), user, agent, 5 * D);
        usdc.mint(user, 100 * D);
        vm.startPrank(user);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(100 * D);
        vm.stopPrank();
    }

    function _trial() internal returns (uint256) {
        // CloudTool: $15 trial, max $15 per charge, ask if > $10, expires in 7 days
        vm.prank(user);
        return vault.createMandate(
            KillSwitchVault.MandateParams({
                merchant: cloudTool,
                capPerCharge: 15 * D,
                totalCap: 15 * D,
                askAbove: 10 * D,
                expiresAt: uint64(block.timestamp + 7 days),
                maxCharges: 0,
                agentCanPay: false,
                label: "CloudTool trial"
            })
        );
    }

    function _api() internal returns (uint256) {
        // Agent-created budget for an x402 weather API: 1 cent per call, $1 total, 1 day
        vm.prank(agent);
        return vault.createMandate(
            KillSwitchVault.MandateParams({
                merchant: weatherApi,
                capPerCharge: D / 100,
                totalCap: 1 * D,
                askAbove: 0,
                expiresAt: uint64(block.timestamp + 1 days),
                maxCharges: 0,
                agentCanPay: true,
                label: "WeatherAPI (x402)"
            })
        );
    }

    function _lastBlockReason() internal returns (KillSwitchVault.BlockReason) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("ChargeBlocked(uint256,address,uint256,uint8,string)");
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].topics[0] == sig) {
                (, uint8 reason,) = abi.decode(logs[i - 1].data, (uint256, uint8, string));
                return KillSwitchVault.BlockReason(reason);
            }
        }
        revert("no ChargeBlocked");
    }

    // ── Merchant pulls ──────────────────────────────────────────────
    function test_SmallChargeSettlesInstantly() public {
        uint256 id = _trial();
        vm.prank(cloudTool);
        (bool ok,) = vault.charge(id, 5 * D, "usage Nov");
        assertTrue(ok);
        assertEq(usdc.balanceOf(cloudTool), 5 * D);
        assertEq(vault.getMandate(id).spent, 5 * D);
    }

    function test_RenewalAboveCapIsBlockedAndNoFundsMove() public {
        uint256 id = _trial();
        vm.recordLogs();
        vm.prank(cloudTool);
        (bool ok,) = vault.charge(id, 29 * D, "Pro plan renewal");
        assertFalse(ok);
        assertEq(uint8(_lastBlockReason()), uint8(KillSwitchVault.BlockReason.OverPerChargeCap));
        assertEq(usdc.balanceOf(cloudTool), 0);
        assertEq(vault.balance(), 100 * D);
    }

    function test_ChargeAfterTrialExpiryIsBlocked() public {
        uint256 id = _trial();
        vm.warp(block.timestamp + 8 days);
        vm.recordLogs();
        vm.prank(cloudTool);
        (bool ok,) = vault.charge(id, 5 * D, "auto-renew");
        assertFalse(ok);
        assertEq(uint8(_lastBlockReason()), uint8(KillSwitchVault.BlockReason.Expired));
    }

    function test_KilledMandateBlocksEverything() public {
        uint256 id = _trial();
        vm.prank(user);
        vault.kill(id);
        vm.recordLogs();
        vm.prank(cloudTool);
        (bool ok,) = vault.charge(id, 1 * D, "sneaky");
        assertFalse(ok);
        assertEq(uint8(_lastBlockReason()), uint8(KillSwitchVault.BlockReason.Killed));
    }

    function test_WrongMerchantCannotUseMandate() public {
        uint256 id = _trial();
        vm.recordLogs();
        vm.prank(rando);
        (bool ok,) = vault.charge(id, 1 * D, "impostor");
        assertFalse(ok);
        assertEq(uint8(_lastBlockReason()), uint8(KillSwitchVault.BlockReason.NotMerchant));
        assertEq(vault.balance(), 100 * D);
    }

    function test_TotalCapEnforced() public {
        uint256 id = _trial();
        vm.startPrank(cloudTool);
        vault.charge(id, 9 * D, "a");
        vm.recordLogs();
        (bool ok,) = vault.charge(id, 9 * D, "b"); // 18 > 15 total
        vm.stopPrank();
        assertFalse(ok);
        assertEq(uint8(_lastBlockReason()), uint8(KillSwitchVault.BlockReason.OverTotalCap));
    }

    // ── Ask-first holds ─────────────────────────────────────────────
    function test_ChargeAboveAskThresholdIsHeldThenApproved() public {
        uint256 id = _trial();
        vm.prank(cloudTool);
        (bool ok, uint256 pid) = vault.charge(id, 12 * D, "first month");
        assertFalse(ok);
        assertEq(pid, 0);
        assertEq(usdc.balanceOf(cloudTool), 0); // held, not paid

        vm.prank(user);
        vault.approvePending(pid);
        assertEq(usdc.balanceOf(cloudTool), 12 * D);
        assertEq(uint8(vault.getPending(pid).status), uint8(KillSwitchVault.PendingStatus.Approved));
    }

    function test_RejectAndKillInOneTap() public {
        uint256 id = _trial();
        vm.prank(cloudTool);
        (, uint256 pid) = vault.charge(id, 12 * D, "first month");
        vm.prank(user);
        vault.rejectPending(pid, true);
        assertFalse(vault.getMandate(id).active);
        vm.prank(user);
        vm.expectRevert(KillSwitchVault.NotOpen.selector);
        vault.approvePending(pid);
    }

    function test_OnlyOwnerApproves() public {
        uint256 id = _trial();
        vm.prank(cloudTool);
        (, uint256 pid) = vault.charge(id, 12 * D, "x");
        vm.prank(agent);
        vm.expectRevert(KillSwitchVault.NotOwner.selector);
        vault.approvePending(pid);
    }

    // ── Agent pushes (x402) ─────────────────────────────────────────
    function test_AgentPaysPerRequest() public {
        uint256 id = _api();
        vm.startPrank(agent);
        for (uint256 i; i < 5; i++) {
            (bool ok,) = vault.pay(id, D / 100, "GET /forecast");
            assertTrue(ok);
        }
        vm.stopPrank();
        assertEq(usdc.balanceOf(weatherApi), 5 * D / 100);
    }

    function test_AgentCannotOverpayQuote() public {
        uint256 id = _api();
        vm.recordLogs();
        vm.prank(agent);
        (bool ok,) = vault.pay(id, D / 2, "inflated 402 quote");
        assertFalse(ok);
        assertEq(uint8(_lastBlockReason()), uint8(KillSwitchVault.BlockReason.OverPerChargeCap));
    }

    function test_AgentCannotPayNonAgentMandate() public {
        uint256 id = _trial();
        vm.recordLogs();
        vm.prank(agent);
        (bool ok,) = vault.pay(id, 1 * D, "x");
        assertFalse(ok);
        assertEq(uint8(_lastBlockReason()), uint8(KillSwitchVault.BlockReason.NotAgent));
    }

    function test_AgentMandateCeiling() public {
        vm.prank(agent);
        vm.expectRevert(KillSwitchVault.AgentCapExceeded.selector);
        vault.createMandate(
            KillSwitchVault.MandateParams({
                merchant: weatherApi,
                capPerCharge: 50 * D,
                totalCap: 50 * D,
                askAbove: 0,
                expiresAt: uint64(block.timestamp + 1 days),
                maxCharges: 0,
                agentCanPay: true,
                label: "greedy"
            })
        );
    }

    function test_RandomCannotCreateOrWithdraw() public {
        vm.startPrank(rando);
        vm.expectRevert(KillSwitchVault.NotOwner.selector);
        vault.withdraw(1);
        vm.stopPrank();
    }

    function test_Preview() public {
        uint256 id = _trial();
        (KillSwitchVault.BlockReason r, bool hold) = vault.preview(id, 12 * D);
        assertEq(uint8(r), 0);
        assertTrue(hold);
        (r,) = vault.preview(id, 29 * D);
        assertEq(uint8(r), uint8(KillSwitchVault.BlockReason.OverPerChargeCap));
    }

    function testFuzz_MerchantCanNeverTakeMoreThanCaps(uint96 a, uint96 b, uint96 c) public {
        uint256 id = _trial();
        vm.startPrank(cloudTool);
        vault.charge(id, uint96(bound(a, 0, 40 * D)), "a");
        vault.charge(id, uint96(bound(b, 0, 40 * D)), "b");
        vault.charge(id, uint96(bound(c, 0, 40 * D)), "c");
        vm.stopPrank();
        assertLe(usdc.balanceOf(cloudTool), 15 * D); // total cap
        assertEq(vault.balance() + usdc.balanceOf(cloudTool), 100 * D);
    }
}
