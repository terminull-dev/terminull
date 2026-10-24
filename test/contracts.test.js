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
  const homepage = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /class="hero glass-panel"/);
  assert.match(html, /class="workspace-layout"/);
  assert.match(homepage, /class="hero"/);
  assert.match(homepage, /Open company workspace/);
  assert.doesNotMatch(`${html}\n${homepage}`, /27,500|35,000|SQLite-backed demo|TERM-ORG-DEMO/);
  assert.match(html, /Shielding and unshielding are disabled/);
  assert.match(html, /pool deposits and withdrawals are disabled/);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(script => script.trim());
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new (require('node:vm').Script)(scripts[0]));

  const connectWallet = scripts[0].match(/async function connectWallet\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(connectWallet);
  assert.doesNotMatch(connectWallet[1], /networkReady|USDT_ADDRESS/);
  assert.match(connectWallet[1], /injectedProvider = getEvmProvider\(\)/);
  assert.match(connectWallet[1], /new ethers\.BrowserProvider\(injectedProvider\)/);
  assert.doesNotMatch(scripts[0], /window\.ethereum\.request/);
  assert.match(scripts[0], /\n    function installWalletListeners\(evmProvider\)/);
  assert.match(scripts[0], /function getEvmProvider\(\)[\s\S]*ethereum\.providers\.find\(item => item\.isMetaMask\)/);
  assert.match(scripts[0], /Chain configuration unavailable:.*Wallet sign-in is still available/s);
});

test('wallet selection prefers MetaMask when multiple injected providers exist', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .find(content => content.includes('function getEvmProvider'));
  const getProvider = script.match(/function getEvmProvider\(\) \{[\s\S]*?\n    \}/)[0];
  const metamask = { isMetaMask: true };
  const otherWallet = { isMetaMask: false };
  const getSelectedProvider = new (require('node:vm').Script)(
    `${getProvider}\ngetEvmProvider()`
  );
  const selected = getSelectedProvider.runInNewContext({
    window: { ethereum: { providers: [otherWallet, metamask] } }
  });
  assert.equal(selected, metamask);

  const legacyProvider = {};
  const legacySelected = getSelectedProvider.runInNewContext({
    window: { ethereum: legacyProvider }
  });
  assert.equal(legacySelected, legacyProvider);
});

test('workspace navigation exposes company tools and unlinked-wallet actions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .find(content => content.includes('const tabsFor'));
  const tabsFor = script.match(/const tabsFor = \(type, org\) => \{[\s\S]*?\n    \};/)[0];
  const tabs = new (require('node:vm').Script)(`${tabsFor}\ntabsFor`).runInNewContext();
  const ownerOrg = { roles:['owner'], permissions:{} };
  assert.deepEqual(Array.from(tabs('company')), ['overview','privacy']);
  assert.deepEqual(Array.from(tabs('company', ownerOrg)), [
    'overview','accounts','profile','employees','organogram','suppliers','invoices','projects','clients','accounting',
    'escrow','dao','reports','settings','privacy'
  ]);
  assert.deepEqual(Array.from(tabs('new')), ['overview', 'company', 'join', 'invoice', 'privacy']);
  assert.match(script, /\['overview','accounts'\]\.includes\(activeTab\) \? walletUsdtBalance\(\)/);
  assert.match(script, /async function sendUsdtPayment\(\)/);
  assert.match(script, /activeTab === 'escrow'/);
  assert.match(script, /activeTab === 'reports'/);
  assert.match(html, /id="lunBalanceDisplay"/);
  assert.match(html, /id="daoBalanceDisplay"/);
  assert.match(script, /provider\.getBalance\(wallet\)/);
  assert.match(script, /token\.balanceOf\(org\.dao_address\)/);
  assert.match(script, /ethers\.formatUnits\(balance, 18\)\} USDT/);
  assert.match(script, /settings:'Company settings'/);
  assert.match(script, /async function saveCompanySettings\(\)/);
  assert.match(script, /Privacy preferences saved\. Current transactions remain public/);
  assert.match(script, /async function renderOrganogram\(\)/);
  assert.match(script, /toggleOrgNode/);
  assert.match(script, /async function renderProjects/);
  assert.match(script, /async function renderAccounting/);
  assert.match(script, /async function renderClients/);
});

test('company privacy preferences are editable but clearly not enforced', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
  const settingsRenderer = html.match(/async function renderCompanySettings\(org[^)]*\) \{[\s\S]*?\n    \}/)[0];
  assert.match(settingsRenderer, /employee_payment_privacy_level/);
  assert.match(settingsRenderer, /supplier_payment_privacy_level/);
  assert.match(settingsRenderer, /dao_transaction_privacy_level/);
  assert.match(settingsRenderer, /Preferences only — not yet enforced/);
  assert.match(settingsRenderer, /remain publicly visible on-chain/);
  assert.match(html, /rgba\(45,212,191/);
  assert.match(html, /rgba\(56,189,248/);
});

test('ZK workspace previews shielding and withdrawals with every control disabled', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .find(content => content.includes('const tabsFor'));
  const tabsFor = script.match(/const tabsFor = \(type, org\) => \{[\s\S]*?\n    \};/)[0];
  const tabs = new (require('node:vm').Script)(`${tabsFor}\ntabsFor`).runInNewContext();
  for (const role of ['company', 'employee', 'supplier', 'new']) {
    assert.ok(Array.from(tabs(role)).includes('privacy'), `${role} workspace should expose the privacy preview`);
  }

  const renderFunction = script.match(/function renderPrivacyWorkspace\(\) \{[\s\S]*?\n    \}/)[0];
  const target = { innerHTML: '' };
  const document = { getElementById: () => target };
  new (require('node:vm').Script)(`${renderFunction}\nrenderPrivacyWorkspace()`)
    .runInNewContext({ document });
  const markup = target.innerHTML;
  assert.match(markup, /Shield assets into the private pool/);
  assert.match(markup, /Unshield \/ withdraw/);
  assert.match(markup, /Private asset view/);
  assert.match(markup, /Shielded transactions/);
  assert.match(markup, /No balance is inferred/);
  assert.doesNotMatch(markup, /onclick=/);
  assert.equal((markup.match(/\sdisabled(?:\s|>)/g) || []).length, 9);
});
