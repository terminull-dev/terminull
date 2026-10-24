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
    mapping(uint256 => bool) public isProjectProposal;
    mapping(uint256 => bool) public proposalCancelled;
    mapping(uint256 => bytes32) public proposalProjectIds;
    mapping(uint256 => mapping(address => bool)) public proposalVoters;
    mapping(uint256 => uint256) public proposalVoterCount;
    mapping(uint256 => uint256) public proposalVotesCast;
    mapping(bytes32 => uint256) public projectBudgets;
    mapping(bytes32 => uint256) public projectCommitted;
    mapping(bytes32 => uint256) public projectSpent;
    uint256 public proposalCount;
    uint256 private entered = 1;

    event MemberUpdated(address indexed member, bool active);
    event GovernanceUpdated(uint16 quorumPercent, uint64 timelockSeconds);
    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, address token, address recipient, uint256 amount);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProjectBudgetSet(bytes32 indexed projectId, uint256 amount);
    event ProjectProposalCreated(uint256 indexed proposalId, bytes32 indexed projectId, address recipient, uint256 amount, uint256 voterCount);
    event ProjectProposalCancelled(uint256 indexed proposalId);

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

    function setProjectBudget(bytes32 projectId, uint256 amount) external onlyOwner {
        require(projectId != bytes32(0), "invalid project");
        require(amount >= projectCommitted[projectId], "budget below committed releases");
        projectBudgets[projectId] = amount;
        emit ProjectBudgetSet(projectId, amount);
    }

    function createProjectProposal(
        bytes32 projectId,
        address token,
        address recipient,
        uint256 amount,
        address[] calldata voters
    ) external onlyOwner returns (uint256 proposalId) {
        require(projectId != bytes32(0) && token != address(0) && recipient != address(0) && amount > 0, "invalid project proposal");
        require(voters.length > 0 && voters.length <= 100, "invalid voter count");
        require(projectBudgets[projectId] > 0, "project budget not set");
        require(projectCommitted[projectId] + amount <= projectBudgets[projectId], "project budget exceeded");
        proposalId = proposalCount + 1;
        for (uint256 i; i < voters.length; i++) {
            require(voters[i] != address(0) && !proposalVoters[proposalId][voters[i]], "invalid or duplicate voter");
            proposalVoters[proposalId][voters[i]] = true;
        }
        proposalCount = proposalId;
        proposals[proposalId] = Proposal({
            token: token,
            recipient: recipient,
            amount: amount,
            createdAt: uint64(block.timestamp),
            votesFor: 0,
            votesAgainst: 0,
            executed: false
        });
        isProjectProposal[proposalId] = true;
        proposalProjectIds[proposalId] = projectId;
        proposalVoterCount[proposalId] = voters.length;
        projectCommitted[projectId] += amount;
        emit ProjectProposalCreated(proposalId, projectId, recipient, amount, voters.length);
    }

    function vote(uint256 proposalId, bool support) external {
        Proposal storage proposal = proposals[proposalId];
        require(proposal.createdAt != 0 && !proposal.executed && !proposalCancelled[proposalId], "proposal unavailable");
        if (isProjectProposal[proposalId]) {
            require(proposalVoters[proposalId][msg.sender], "project team voter only");
            proposalVotesCast[proposalId] += 1;
        } else {
            require(members[msg.sender], "member only");
        }
        require(!hasVoted[proposalId][msg.sender], "already voted");
        hasVoted[proposalId][msg.sender] = true;
        if (support) proposal.votesFor += 1;
        else proposal.votesAgainst += 1;
        emit VoteCast(proposalId, msg.sender, support);
    }

    function cancelProjectProposal(uint256 proposalId) external onlyOwner {
        require(isProjectProposal[proposalId] && !proposals[proposalId].executed && !proposalCancelled[proposalId], "project proposal unavailable");
        proposalCancelled[proposalId] = true;
        projectCommitted[proposalProjectIds[proposalId]] -= proposals[proposalId].amount;
        emit ProjectProposalCancelled(proposalId);
    }

    function execute(uint256 proposalId) external nonReentrant {
        Proposal storage proposal = proposals[proposalId];
        require(proposal.createdAt != 0 && !proposal.executed && !proposalCancelled[proposalId], "proposal unavailable");
        uint256 votes = proposal.votesFor + proposal.votesAgainst;
        if (isProjectProposal[proposalId]) {
            uint256 requiredVotes = (proposalVoterCount[proposalId] * quorumPercent + 99) / 100;
            require(votes >= requiredVotes && proposal.votesFor > proposal.votesAgainst, "team quorum or majority not reached");
        } else {
            require(votes > 0 && proposal.votesFor * 100 >= votes * quorumPercent, "quorum not reached");
        }
        require(block.timestamp >= uint256(proposal.createdAt) + timelockSeconds, "timelock active");
        proposal.executed = true;
        require(IERC20DAO(proposal.token).transfer(proposal.recipient, proposal.amount), "token transfer failed");
        if (isProjectProposal[proposalId]) projectSpent[proposalProjectIds[proposalId]] += proposal.amount;
        emit ProposalExecuted(proposalId);
    }
}
