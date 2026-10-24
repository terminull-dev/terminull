// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20DAO {
    function transfer(address to, uint256 amount) external returns (bool);
}

contract CompanyDAO {
    struct Proposal {
        address token;
        address recipient;
        uint256 amount;
        uint64 createdAt;
        uint256 votesFor;
        uint256 votesAgainst;
        bool executed;
    }

    address public immutable owner;
    uint16 public quorumPercent = 51;
    uint64 public timelockSeconds = 24 hours;
    mapping(address => bool) public members;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    uint256 public proposalCount;
    uint256 private entered = 1;

    event MemberUpdated(address indexed member, bool active);
    event GovernanceUpdated(uint16 quorumPercent, uint64 timelockSeconds);
    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, address token, address recipient, uint256 amount);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support);
    event ProposalExecuted(uint256 indexed proposalId);

    modifier onlyOwner() {
        require(msg.sender == owner, "owner only");
        _;
    }

    modifier onlyMember() {
        require(members[msg.sender], "member only");
        _;
    }

    modifier nonReentrant() {
        require(entered == 1, "reentrant call");
        entered = 2;
        _;
        entered = 1;
    }

    constructor(address companyOwner) {
        require(companyOwner != address(0), "invalid owner");
        owner = companyOwner;
        members[companyOwner] = true;
        emit MemberUpdated(companyOwner, true);
        emit GovernanceUpdated(quorumPercent, timelockSeconds);
    }

    function setMember(address account, bool active) external onlyOwner {
        require(account != address(0), "invalid member");
        require(account != owner || active, "owner must remain a member");
        members[account] = active;
        emit MemberUpdated(account, active);
    }

    function setGovernance(uint16 quorum, uint64 delaySeconds) external onlyOwner {
        require(quorum > 0 && quorum <= 100, "invalid quorum");
        require(delaySeconds <= 365 days, "timelock too long");
        quorumPercent = quorum;
        timelockSeconds = delaySeconds;
        emit GovernanceUpdated(quorum, delaySeconds);
    }

    function createProposal(address token, address recipient, uint256 amount) external onlyMember returns (uint256 proposalId) {
        require(token != address(0) && recipient != address(0) && amount > 0, "invalid proposal");
        proposalId = ++proposalCount;
        proposals[proposalId] = Proposal({
            token: token,
            recipient: recipient,
            amount: amount,
            createdAt: uint64(block.timestamp),
            votesFor: 0,
            votesAgainst: 0,
            executed: false
        });
        emit ProposalCreated(proposalId, msg.sender, token, recipient, amount);
    }

    function vote(uint256 proposalId, bool support) external onlyMember {
        Proposal storage proposal = proposals[proposalId];
        require(proposal.createdAt != 0 && !proposal.executed, "proposal unavailable");
        require(!hasVoted[proposalId][msg.sender], "already voted");
        hasVoted[proposalId][msg.sender] = true;
        if (support) proposal.votesFor += 1;
        else proposal.votesAgainst += 1;
        emit VoteCast(proposalId, msg.sender, support);
    }

    function execute(uint256 proposalId) external nonReentrant {
        Proposal storage proposal = proposals[proposalId];
        require(proposal.createdAt != 0 && !proposal.executed, "proposal unavailable");
        uint256 votes = proposal.votesFor + proposal.votesAgainst;
        require(votes > 0 && proposal.votesFor * 100 >= votes * quorumPercent, "quorum not reached");
        require(block.timestamp >= uint256(proposal.createdAt) + timelockSeconds, "timelock active");
        proposal.executed = true;
        require(IERC20DAO(proposal.token).transfer(proposal.recipient, proposal.amount), "token transfer failed");
        emit ProposalExecuted(proposalId);
    }
}
