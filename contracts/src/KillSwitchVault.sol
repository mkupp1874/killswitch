// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title KillSwitchVault
/// @notice A USDC spending firewall on Arc for people and their AI agents.
///
/// Instead of handing a merchant (a SaaS trial, an API, an MCP tool, a GPU box) an open-ended card or an
/// unlimited ERC-20 allowance, the owner grants a *mandate*: a capped, expiring, revocable permission.
///
/// Enforcement is synchronous and on-chain. Every charge, whether merchant-pulled (`charge`) or
/// agent-pushed (`pay`, e.g. for an x402 API), is checked *before* any USDC moves. Bad charges are not
/// reverted. They are recorded as `ChargeBlocked` events, so QuickNode Streams can push them off-chain
/// and the app can speak an alert. Nothing has to "react in time": the money never left.
///
/// Charges above a mandate's `askAbove` threshold are held as pending until the owner approves or kills.
contract KillSwitchVault {
    // ───────────────────────────── Types ─────────────────────────────
    enum BlockReason {
        None,
        Killed,
        Expired,
        OverPerChargeCap,
        OverTotalCap,
        MaxChargesReached,
        NotMerchant,
        NotAgent,
        InsufficientFunds
    }

    enum PendingStatus {
        Open,
        Approved,
        Rejected
    }

    struct Mandate {
        address merchant;
        uint96 capPerCharge; // USDC (6 decimals)
        uint96 totalCap;
        uint96 spent;
        uint96 askAbove; // charges above this are held for approval (0 = never ask)
        uint64 expiresAt;
        uint32 maxCharges; // 0 = unlimited count (still bounded by totalCap)
        uint32 charges;
        bool active;
        bool agentCanPay; // the AI agent may push payments to this merchant (x402 / API usage)
        string label;
    }

    struct Pending {
        uint256 mandateId;
        uint96 amount;
        uint64 createdAt;
        PendingStatus status;
        string memo;
    }

    struct MandateParams {
        address merchant;
        uint96 capPerCharge;
        uint96 totalCap;
        uint96 askAbove;
        uint64 expiresAt;
        uint32 maxCharges;
        bool agentCanPay;
        string label;
    }

    // ──────────────────────────── Storage ────────────────────────────
    IERC20 public immutable usdc;
    address public owner; // the person (an app-managed "invisible" wallet in the demo)
    address public agent; // the AI payment agent
    uint96 public agentMaxCapPerCharge; // hard ceiling on any mandate the *agent* creates

    Mandate[] internal _mandates;
    Pending[] internal _pending;

    // ──────────────────────────── Events ─────────────────────────────
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event MandateCreated(
        uint256 indexed id,
        address indexed merchant,
        string label,
        uint96 capPerCharge,
        uint96 totalCap,
        uint96 askAbove,
        uint64 expiresAt,
        bool agentCanPay,
        address createdBy
    );
    event MandateKilled(uint256 indexed id, address indexed by);
    event MandateExtended(uint256 indexed id, uint64 expiresAt, uint96 totalCap);
    event ChargeSettled(
        uint256 indexed mandateId, address indexed merchant, uint256 amount, bool viaAgent, string memo
    );
    event ChargeBlocked(
        uint256 indexed mandateId, address indexed caller, uint256 amount, BlockReason reason, string memo
    );
    event ChargeHeld(
        uint256 indexed pendingId, uint256 indexed mandateId, address indexed merchant, uint256 amount, string memo
    );
    event PendingResolved(uint256 indexed pendingId, uint256 indexed mandateId, bool approved);
    event AgentUpdated(address agent, uint96 maxCapPerCharge);

    // ──────────────────────────── Errors ─────────────────────────────
    error NotOwner();
    error NotOwnerOrAgent();
    error AgentCapExceeded();
    error BadMandate();
    error NotOpen();
    error MandateDead();
    error Insufficient();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IERC20 _usdc, address _owner, address _agent, uint96 _agentMaxCapPerCharge) {
        usdc = _usdc;
        owner = _owner;
        agent = _agent;
        agentMaxCapPerCharge = _agentMaxCapPerCharge;
    }

    // ─────────────────────────── Funding ─────────────────────────────
    function deposit(uint256 amount) external {
        require(usdc.transferFrom(msg.sender, address(this), amount), "transferFrom");
        emit Deposited(msg.sender, amount);
    }

    function withdraw(uint256 amount) external onlyOwner {
        require(usdc.transfer(owner, amount), "transfer");
        emit Withdrawn(owner, amount);
    }

    function balance() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    // ────────────────────────── Mandates ─────────────────────────────
    /// @notice Owner, or the agent within its ceiling, grants a capped + expiring permission.
    function createMandate(MandateParams calldata p) external returns (uint256 id) {
        if (msg.sender != owner && msg.sender != agent) revert NotOwnerOrAgent();
        if (msg.sender == agent && p.capPerCharge > agentMaxCapPerCharge) revert AgentCapExceeded();
        if (p.merchant == address(0) || p.capPerCharge == 0 || p.totalCap < p.capPerCharge) revert BadMandate();
        if (p.expiresAt <= block.timestamp) revert BadMandate();

        id = _mandates.length;
        _mandates.push(
            Mandate({
                merchant: p.merchant,
                capPerCharge: p.capPerCharge,
                totalCap: p.totalCap,
                spent: 0,
                askAbove: p.askAbove,
                expiresAt: p.expiresAt,
                maxCharges: p.maxCharges,
                charges: 0,
                active: true,
                agentCanPay: p.agentCanPay,
                label: p.label
            })
        );
        emit MandateCreated(
            id, p.merchant, p.label, p.capPerCharge, p.totalCap, p.askAbove, p.expiresAt, p.agentCanPay, msg.sender
        );
    }

    /// @notice The kill switch. Owner or agent can kill instantly; only the owner can grant more.
    function kill(uint256 id) external {
        if (msg.sender != owner && msg.sender != agent) revert NotOwnerOrAgent();
        _mandates[id].active = false;
        emit MandateKilled(id, msg.sender);
    }

    function extend(uint256 id, uint64 newExpiresAt, uint96 newTotalCap) external onlyOwner {
        Mandate storage m = _mandates[id];
        if (!m.active) revert MandateDead();
        if (newTotalCap < m.spent) revert BadMandate();
        m.expiresAt = newExpiresAt;
        m.totalCap = newTotalCap;
        emit MandateExtended(id, newExpiresAt, newTotalCap);
    }

    // ─────────────────────────── Charges ─────────────────────────────
    /// @notice Merchant-initiated pull (subscription renewal, usage bill).
    /// Never reverts on a policy violation: it records ChargeBlocked and returns false, so the blocked
    /// attempt is a permanent on-chain fact that Streams can deliver.
    function charge(uint256 mandateId, uint96 amount, string calldata memo)
        external
        returns (bool settled, uint256 pendingId)
    {
        Mandate storage m = _mandates[mandateId];
        if (msg.sender != m.merchant) {
            emit ChargeBlocked(mandateId, msg.sender, amount, BlockReason.NotMerchant, memo);
            return (false, type(uint256).max);
        }
        return _process(mandateId, m, amount, memo, false);
    }

    /// @notice Agent-initiated push (e.g. paying an x402 "402 Payment Required" quote for an API call).
    function pay(uint256 mandateId, uint96 amount, string calldata memo)
        external
        returns (bool settled, uint256 pendingId)
    {
        Mandate storage m = _mandates[mandateId];
        if (msg.sender != agent || !m.agentCanPay) {
            emit ChargeBlocked(mandateId, msg.sender, amount, BlockReason.NotAgent, memo);
            return (false, type(uint256).max);
        }
        return _process(mandateId, m, amount, memo, true);
    }

    function _process(uint256 id, Mandate storage m, uint96 amount, string calldata memo, bool viaAgent)
        internal
        returns (bool, uint256)
    {
        BlockReason r = _check(m, amount);
        if (r != BlockReason.None) {
            emit ChargeBlocked(id, msg.sender, amount, r, memo);
            return (false, type(uint256).max);
        }
        if (m.askAbove != 0 && amount > m.askAbove) {
            uint256 pid = _pending.length;
            _pending.push(
                Pending({
                    mandateId: id,
                    amount: amount,
                    createdAt: uint64(block.timestamp),
                    status: PendingStatus.Open,
                    memo: memo
                })
            );
            emit ChargeHeld(pid, id, m.merchant, amount, memo);
            return (false, pid);
        }
        _settle(id, m, amount, memo, viaAgent);
        return (true, type(uint256).max);
    }

    function _check(Mandate storage m, uint96 amount) internal view returns (BlockReason) {
        if (!m.active) return BlockReason.Killed;
        if (block.timestamp > m.expiresAt) return BlockReason.Expired;
        if (amount > m.capPerCharge) return BlockReason.OverPerChargeCap;
        if (uint256(m.spent) + amount > m.totalCap) return BlockReason.OverTotalCap;
        if (m.maxCharges != 0 && m.charges >= m.maxCharges) return BlockReason.MaxChargesReached;
        if (usdc.balanceOf(address(this)) < amount) return BlockReason.InsufficientFunds;
        return BlockReason.None;
    }

    function _settle(uint256 id, Mandate storage m, uint96 amount, string memory memo, bool viaAgent) internal {
        m.spent += amount;
        m.charges += 1;
        require(usdc.transfer(m.merchant, amount), "transfer");
        emit ChargeSettled(id, m.merchant, amount, viaAgent, memo);
    }

    // ─────────────────────────── Approvals ───────────────────────────
    /// @notice Owner approves a held charge. Explicit human consent: the mandate must still be alive,
    /// but the per-charge threshold is waived (that's what "ask first" means). Total cap still applies.
    function approvePending(uint256 pendingId) external onlyOwner {
        Pending storage p = _pending[pendingId];
        if (p.status != PendingStatus.Open) revert NotOpen();
        Mandate storage m = _mandates[p.mandateId];
        if (!m.active || block.timestamp > m.expiresAt) revert MandateDead();
        if (uint256(m.spent) + p.amount > m.totalCap) revert Insufficient();
        if (usdc.balanceOf(address(this)) < p.amount) revert Insufficient();
        p.status = PendingStatus.Approved;
        emit PendingResolved(pendingId, p.mandateId, true);
        _settle(p.mandateId, m, p.amount, p.memo, false);
    }

    /// @notice Reject a held charge, optionally killing the whole mandate in the same tx.
    function rejectPending(uint256 pendingId, bool alsoKill) external {
        if (msg.sender != owner && msg.sender != agent) revert NotOwnerOrAgent();
        Pending storage p = _pending[pendingId];
        if (p.status != PendingStatus.Open) revert NotOpen();
        p.status = PendingStatus.Rejected;
        emit PendingResolved(pendingId, p.mandateId, false);
        if (alsoKill) {
            _mandates[p.mandateId].active = false;
            emit MandateKilled(p.mandateId, msg.sender);
        }
    }

    // ──────────────────────────── Admin ──────────────────────────────
    function setAgent(address _agent, uint96 _maxCapPerCharge) external onlyOwner {
        agent = _agent;
        agentMaxCapPerCharge = _maxCapPerCharge;
        emit AgentUpdated(_agent, _maxCapPerCharge);
    }

    // ──────────────────────────── Views ──────────────────────────────
    function mandateCount() external view returns (uint256) {
        return _mandates.length;
    }

    function getMandate(uint256 id) external view returns (Mandate memory) {
        return _mandates[id];
    }

    function pendingCount() external view returns (uint256) {
        return _pending.length;
    }

    function getPending(uint256 id) external view returns (Pending memory) {
        return _pending[id];
    }

    /// @notice Dry-run a charge without sending a tx (merchants / agents can pre-check).
    function preview(uint256 mandateId, uint96 amount) external view returns (BlockReason reason, bool wouldHold) {
        Mandate storage m = _mandates[mandateId];
        reason = _check(m, amount);
        wouldHold = reason == BlockReason.None && m.askAbove != 0 && amount > m.askAbove;
    }
}
