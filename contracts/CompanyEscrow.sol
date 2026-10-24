// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Escrow {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract CompanyEscrow {
    struct Escrow {
        bytes32 invoiceId;
        address token;
        address supplier;
        uint256 amount;
        uint64 refundAfter;
        bool released;
        bool refunded;
    }

    address public immutable company;
    address public immutable token;
    mapping(uint256 => Escrow) public escrows;
    uint256 public escrowCount;
    uint256 private entered = 1;

    event EscrowCreated(uint256 indexed escrowId, bytes32 indexed invoiceId, address indexed supplier, address token, uint256 amount, uint64 refundAfter);
    event EscrowReleased(uint256 indexed escrowId, address indexed supplier, uint256 amount);
    event EscrowRefunded(uint256 indexed escrowId, address indexed company, uint256 amount);

    modifier onlyCompany() {
        require(msg.sender == company, "company only");
        _;
    }

    modifier nonReentrant() {
        require(entered == 1, "reentrant call");
        entered = 2;
        _;
        entered = 1;
    }

    constructor(address companyOwner, address usdt) {
        require(companyOwner != address(0) && usdt != address(0), "invalid company or token");
        company = companyOwner;
        token = usdt;
    }

    function createEscrow(bytes32 invoiceId, address supplier, uint256 amount, uint64 refundAfter)
        external
        onlyCompany
        nonReentrant
        returns (uint256 escrowId)
    {
        require(invoiceId != bytes32(0) && supplier != address(0), "invalid address or invoice");
        require(supplier != company && amount > 0, "invalid amount or supplier");
        require(refundAfter > block.timestamp, "refund deadline must be in future");
        require(IERC20Escrow(token).transferFrom(company, address(this), amount), "funding failed");
        escrowId = ++escrowCount;
        escrows[escrowId] = Escrow(invoiceId, token, supplier, amount, refundAfter, false, false);
        emit EscrowCreated(escrowId, invoiceId, supplier, token, amount, refundAfter);
    }

    function release(uint256 escrowId) external onlyCompany nonReentrant {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.amount > 0 && !escrow.released && !escrow.refunded, "escrow unavailable");
        require(block.timestamp < escrow.refundAfter, "refund deadline passed");
        escrow.released = true;
        require(IERC20Escrow(escrow.token).transfer(escrow.supplier, escrow.amount), "release failed");
        emit EscrowReleased(escrowId, escrow.supplier, escrow.amount);
    }

    function refund(uint256 escrowId) external onlyCompany nonReentrant {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.amount > 0 && !escrow.released && !escrow.refunded, "escrow unavailable");
        require(block.timestamp >= escrow.refundAfter, "refund deadline active");
        escrow.refunded = true;
        require(IERC20Escrow(escrow.token).transfer(company, escrow.amount), "refund failed");
        emit EscrowRefunded(escrowId, company, escrow.amount);
    }
}
