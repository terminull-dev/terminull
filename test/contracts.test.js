const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const solc = require('solc');

test('DAO and escrow contracts compile for the Paris EVM target', () => {
  const sources = {};
  for (const name of ['CompanyDAO.sol', 'CompanyEscrow.sol']) {
    sources[name] = { content: fs.readFileSync(path.join(__dirname, '..', 'contracts', name), 'utf8') };
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
  for (const name of ['CompanyDAO', 'CompanyEscrow']) {
    const contract = output.contracts[`${name}.sol`][name];
    assert.ok(contract.abi.length > 0);
    assert.match(contract.evm.bytecode.object, /^[0-9a-f]+$/i);
  }
});

test('dashboard inline JavaScript parses', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(script => script.trim());
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new (require('node:vm').Script)(scripts[0]));
});
