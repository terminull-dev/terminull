const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ethers } = require('ethers');
const solc = require('solc');
const { createBlock } = require('@ethereumjs/block');
const { createCustomCommon, Hardfork, Mainnet } = require('@ethereumjs/common');
const { createTxFromRLP } = require('@ethereumjs/tx');
const { createAddressFromPrivateKey, createAddressFromString, createAccount, hexToBytes, bytesToHex } = require('@ethereumjs/util');
const { createVM, runTx } = require('@ethereumjs/vm');

const root = path.join(__dirname, '..');

function compileContracts() {
  const sources = {};
  for (const [file, directory] of [
    ['CompanyDAO.sol', 'contracts'],
    ['CompanyEscrow.sol', 'contracts'],
    ['TestToken.sol', 'test/fixtures']
  ]) {
    sources[file] = { content: fs.readFileSync(path.join(root, directory, file), 'utf8') };
  }
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources,
    settings: {
      evmVersion: 'paris',
      optimizer: { enabled: true, runs: 300 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  })));
  const errors = (output.errors || []).filter(error => error.severity === 'error');
  assert.deepEqual(errors, []);
  return Object.fromEntries(Object.values(output.contracts).flatMap(contracts =>
    Object.entries(contracts).map(([name, artifact]) => [name, {
      abi: artifact.abi,
      bytecode: `0x${artifact.evm.bytecode.object}`
    }])
  ));
}

test('Paris DAO and escrow execute treasury operations on an isolated EVM', async () => {
  const common = createCustomCommon({ chainId: 448000 }, Mainnet, { hardfork: Hardfork.Paris });
  const vm = await createVM({ common });
  const artifacts = compileContracts();
  const owner = new ethers.Wallet(`0x${'11'.repeat(32)}`);
  const supplier = new ethers.Wallet(`0x${'22'.repeat(32)}`);
  const projectVoter = new ethers.Wallet(`0x${'33'.repeat(32)}`);
  const secondProjectVoter = new ethers.Wallet(`0x${'44'.repeat(32)}`);
  const outsider = new ethers.Wallet(`0x${'55'.repeat(32)}`);
  const ownerAddress = createAddressFromPrivateKey(hexToBytes(owner.privateKey));
  await vm.stateManager.putAccount(ownerAddress, createAccount({ nonce: 0n, balance: 10n ** 30n }));
  for (const signer of [projectVoter, secondProjectVoter, outsider]) {
    const address = createAddressFromPrivateKey(hexToBytes(signer.privateKey));
    await vm.stateManager.putAccount(address, createAccount({ nonce: 0n, balance: 10n ** 30n }));
  }

  const nonces = new Map([[owner.address.toLowerCase(), 0]]);
  let blockNumber = 1n;
  let timestamp = 1_000n;
  async function transact(to, data, signer = owner) {
    const key = signer.address.toLowerCase();
    const nonce = nonces.get(key) || 0;
    nonces.set(key, nonce + 1);
    const raw = await signer.signTransaction({
      chainId: 448000,
      nonce,
      gasLimit: 12_000_000,
      gasPrice: 1_000_000_000,
      ...(to ? { to } : {}),
      data
    });
    const block = createBlock({
      header: { number: blockNumber++, timestamp: timestamp++, gasLimit: 30_000_000n }
    }, { common, skipConsensusFormatValidation: true });
    const result = await runTx(vm, { tx: createTxFromRLP(hexToBytes(raw), { common }), block });
    return result;
  }

  async function deploy(artifact, args = []) {
    const constructor = artifact.abi.find(item => item.type === 'constructor');
    const encodedArgs = constructor
      ? ethers.AbiCoder.defaultAbiCoder().encode(constructor.inputs.map(input => input.type), args).slice(2)
      : '';
    const result = await transact(undefined, `${artifact.bytecode}${encodedArgs}`);
    assert.equal(result.execResult.exceptionError, undefined);
    assert.ok(result.createdAddress);
    return result.createdAddress.toString();
  }

  async function call(address, iface, method, args = []) {
    const block = createBlock({
      header: { number: blockNumber, timestamp, gasLimit: 30_000_000n }
    }, { common, skipConsensusFormatValidation: true });
    const result = await vm.evm.runCall({
      to: createAddressFromString(address),
      caller: ownerAddress,
      origin: ownerAddress,
      data: hexToBytes(iface.encodeFunctionData(method, args)),
      gasLimit: 1_000_000n,
      block,
      isStatic: true,
      skipNonceIncrement: true
    });
    assert.equal(result.execResult.exceptionError, undefined);
    return iface.decodeFunctionResult(method, bytesToHex(result.execResult.returnValue));
  }

  const token = await deploy(artifacts.TestToken);
  const dao = await deploy(artifacts.CompanyDAO, [owner.address]);
  const escrow = await deploy(artifacts.CompanyEscrow, [owner.address, token]);
  const tokenInterface = new ethers.Interface(artifacts.TestToken.abi);
  const daoInterface = new ethers.Interface(artifacts.CompanyDAO.abi);
  const escrowInterface = new ethers.Interface(artifacts.CompanyEscrow.abi);
  const amount = ethers.parseUnits('25', 18);

  let result = await transact(dao, daoInterface.encodeFunctionData('setGovernance', [51, 0]));
  assert.equal(result.execResult.exceptionError, undefined);
  result = await transact(token, tokenInterface.encodeFunctionData('transfer', [dao, amount]));
  assert.equal(result.execResult.exceptionError, undefined);
  result = await transact(dao, daoInterface.encodeFunctionData('createProposal', [token, supplier.address, amount]));
  assert.equal(result.execResult.exceptionError, undefined);
  result = await transact(dao, daoInterface.encodeFunctionData('vote', [1, true]));
  assert.equal(result.execResult.exceptionError, undefined);
  result = await transact(dao, daoInterface.encodeFunctionData('execute', [1]));
  assert.equal(result.execResult.exceptionError, undefined);
  assert.equal((await call(token, tokenInterface, 'balanceOf', [supplier.address]))[0], amount);
  result = await transact(dao, daoInterface.encodeFunctionData('execute', [1]));
  assert.ok(result.execResult.exceptionError, 'executed DAO proposals cannot pay twice');

  const projectId = ethers.id('integration-project');
  result = await transact(token, tokenInterface.encodeFunctionData('transfer', [dao, amount * 2n]));
  assert.equal(result.execResult.exceptionError, undefined);
  result = await transact(dao, daoInterface.encodeFunctionData('setProjectBudget', [projectId, amount * 2n]));
  assert.equal(result.execResult.exceptionError, undefined);
  result = await transact(dao, daoInterface.encodeFunctionData('createProjectProposal', [
    projectId, token, supplier.address, amount, [projectVoter.address, secondProjectVoter.address]
  ]));
  assert.equal(result.execResult.exceptionError, undefined);
  const projectProposalId = 2;
  result = await transact(dao, daoInterface.encodeFunctionData('vote', [projectProposalId, true]), outsider);
  assert.ok(result.execResult.exceptionError, 'non-team wallets cannot vote on project releases');
  result = await transact(dao, daoInterface.encodeFunctionData('vote', [projectProposalId, true]), projectVoter);
  assert.equal(result.execResult.exceptionError, undefined);
  result = await transact(dao, daoInterface.encodeFunctionData('execute', [projectProposalId]));
  assert.ok(result.execResult.exceptionError, 'project quorum requires participation from both snapshotted voters');
  result = await transact(dao, daoInterface.encodeFunctionData('vote', [projectProposalId, true]), secondProjectVoter);
  assert.equal(result.execResult.exceptionError, undefined);
  result = await transact(dao, daoInterface.encodeFunctionData('execute', [projectProposalId]));
  assert.equal(result.execResult.exceptionError, undefined);
  assert.equal((await call(dao, daoInterface, 'projectSpent', [projectId]))[0], amount);
  assert.equal((await call(dao, daoInterface, 'projectCommitted', [projectId]))[0], amount);
  assert.equal((await call(token, tokenInterface, 'balanceOf', [supplier.address]))[0], amount * 2n);

  result = await transact(dao, daoInterface.encodeFunctionData('createProjectProposal', [
    projectId, token, supplier.address, amount * 2n, [projectVoter.address]
  ]));
  assert.ok(result.execResult.exceptionError, 'project releases cannot exceed the remaining budget');
  result = await transact(dao, daoInterface.encodeFunctionData('setProjectBudget', [projectId, amount - 1n]));
  assert.ok(result.execResult.exceptionError, 'project budget cannot be reduced below committed releases');
  result = await transact(dao, daoInterface.encodeFunctionData('createProjectProposal', [
    projectId, token, supplier.address, amount, [projectVoter.address]
  ]));
  assert.equal(result.execResult.exceptionError, undefined);
  result = await transact(dao, daoInterface.encodeFunctionData('cancelProjectProposal', [3]));
  assert.equal(result.execResult.exceptionError, undefined);
  assert.equal((await call(dao, daoInterface, 'projectCommitted', [projectId]))[0], amount);

  result = await transact(token, tokenInterface.encodeFunctionData('approve', [escrow, amount * 2n]));
  assert.equal(result.execResult.exceptionError, undefined);
  const invoiceId = ethers.id('local-evm-invoice-1');
  result = await transact(escrow, escrowInterface.encodeFunctionData('createEscrow', [
    invoiceId, supplier.address, amount, timestamp + 100n
  ]));
  assert.equal(result.execResult.exceptionError, undefined);
  result = await transact(escrow, escrowInterface.encodeFunctionData('release', [1]));
  assert.equal(result.execResult.exceptionError, undefined);
  assert.equal((await call(token, tokenInterface, 'balanceOf', [supplier.address]))[0], amount * 3n);

  result = await transact(escrow, escrowInterface.encodeFunctionData('createEscrow', [
    ethers.id('local-evm-invoice-2'), supplier.address, amount, timestamp + 1n
  ]));
  assert.equal(result.execResult.exceptionError, undefined);
  result = await transact(escrow, escrowInterface.encodeFunctionData('refund', [2]));
  assert.equal(result.execResult.exceptionError, undefined);
  result = await transact(escrow, escrowInterface.encodeFunctionData('refund', [2]));
  assert.ok(result.execResult.exceptionError, 'refunded escrows cannot be refunded twice');
});
