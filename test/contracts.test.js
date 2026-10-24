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
  assert.match(homepage, /class="container hero"/);
  assert.match(homepage, /href="\/app">Enter TermiNull/);
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
  assert.match(script, /formatBalance\(balance, 18\)\} USDT/);
  assert.match(script, /formatBalance\(lun\.value, 18\)\} LUN/);
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
  assert.match(html, /rgba\(170,136,255/);
  assert.match(html, /--accent:#a58aff/);
});

test('dashboard has collapsible function groups and charts only confirmed activity', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .find(content => content.includes('const tabsFor'));
  assert.match(html, /brand-mark/);
  assert.match(html, /--accent:#a58aff/);
  assert.match(html, /<strong>TermiNull<\/strong><small>ENTERPRISE FINANCIAL SUITE<\/small>/);
  assert.doesNotMatch(html, /<small>\/ TREASURY<\/small>|Enterprise financial suite · Lunul PoA/);
  assert.match(script, /<details class="nav-group" data-group=/);
  assert.match(script, /name:'People & partners'/);

  const chartFunction = script.match(/function renderTreasuryChart\(rows\) \{[\s\S]*?\n    \}/)[0];
  const renderer = new (require('node:vm').Script)(`${chartFunction}\nrenderTreasuryChart`).runInNewContext({
    escapeHtml: value => String(value).replace(/[&<>"']/g, '')
  });
  assert.match(renderer([]), /No confirmed transaction history to chart yet/);
  const chart = renderer([
    { status:'CONFIRMED', timestamp:'2026-01-05T10:00:00.000Z' },
    { status:'CONFIRMED', timestamp:'2026-02-05T10:00:00.000Z' },
    { status:'PENDING', timestamp:'2026-02-06T10:00:00.000Z' }
  ]);
  assert.match(chart, /Confirmed monthly transaction counts:/);
  assert.match(chart, /1 confirmed transactions/);
  assert.equal((chart.match(/<circle /g) || []).length, 2);

  const balanceFunction = script.match(/function formatBalance\(raw, decimals = 18\) \{[\s\S]*?\n    \}/)[0];
  const formatBalance = new (require('node:vm').Script)(
    `${balanceFunction}\nformatBalance`
  ).runInNewContext({ Intl });
  assert.equal(formatBalance(1234567890123456789012n), '1,234.57');
  assert.equal(formatBalance(19999999999999999n), '0.02');
  assert.equal(formatBalance(9999999999999999n), '0.01');
  assert.equal(formatBalance(10000000000000000n), '0.01');
  assert.equal(formatBalance(1200000000000000000n), '1.20');
  assert.equal(formatBalance(123456789n, 6), '123.46');
});

test('treasury fees are separate confirmed transfers on the configured chain', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .find(content => content.includes('async function payTreasuryFee'));
  const feeFunction = script.match(/async function payTreasuryFee\(action,[\s\S]*?\n    \}/)[0];
  const source = `
    const CHAIN_ID_HEX = '0x6d600';
    const FEE_TREASURY_ADDRESS = '0x8632fa855d5Dc6b59A3cF892d72CF4a94F182AAE';
    const BASE_TRANSACTION_FEE = '0.01';
    ${feeFunction}
    payTreasuryFee`;
  const transactions = [];
  const prompts = [];
  const environment = {
    BigInt,
    provider: { getNetwork: async () => ({ chainId: 448000n }) },
    signer: {
      getAddress: async () => '0x1111111111111111111111111111111111111111',
      sendTransaction: async transaction => {
        transactions.push(transaction);
        return { wait: async () => ({ status: 1, hash: '0xfee' }) };
      }
    },
    wallet: '0x1111111111111111111111111111111111111111',
    ethers: {
      getAddress: address => address,
      parseEther: amount => amount === '10' ? 10n * 10n ** 18n : 10n ** 16n
    },
    confirm: message => { prompts.push(message); return true; },
    showNotice: () => {}
  };
  const payTreasuryFee = new (require('node:vm').Script)(source).runInNewContext(environment);

  assert.equal(await payTreasuryFee('USDT payment'), '0xfee');
  assert.equal(transactions[0].to, '0x8632fa855d5Dc6b59A3cF892d72CF4a94F182AAE');
  assert.equal(transactions[0].value, 10n ** 16n);
  assert.match(prompts[0], /0\.01 LUN/);
  assert.match(prompts[0], /0x8632fa855d5Dc6b59A3cF892d72CF4a94F182AAE/);
  assert.match(prompts[0], /not be refunded/);

  assert.equal(await payTreasuryFee('company creation', '10'), '0xfee');
  assert.equal(transactions[1].value, 10n * 10n ** 18n);

  environment.confirm = () => false;
  assert.equal(await payTreasuryFee('cancelled action'), null);
  assert.equal(transactions.length, 2);

  environment.provider.getNetwork = async () => ({ chainId: 1n });
  await assert.rejects(payTreasuryFee('wrong-chain action'), /Switch the wallet to Lunul PoA/);
  assert.equal(transactions.length, 2);
});

test('all app-initiated on-chain actions collect the applicable LUN fee', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .find(content => content.includes('async function payTreasuryFee'));
  const actions = [
    'registerCompany', 'createProject', 'proposeProjectRelease', 'voteProjectProposal',
    'executeProjectProposal', 'sendUsdtPayment', 'executeMassPayments', 'deployEscrow',
    'fundInvoice', 'escrowAction', 'deployDao', 'saveDaoSettings', 'addDaoMember',
    'createDaoProposal', 'voteDao', 'executeDao', 'fundDao'
  ];
  for (const action of actions) {
    const start = script.indexOf(`async function ${action}(`);
    assert.notEqual(start, -1, `Expected to find ${action}()`);
    const end = script.indexOf('\n    }', start);
    assert.notEqual(end, -1, `Expected ${action}() to end`);
    assert.match(script.slice(start, end), /payTreasuryFee\(/, `${action}() must collect a LUN fee`);
  }
  const fundInvoice = script.match(/async function fundInvoice\([^)]*\) \{([\s\S]*?)\n    \}/)[1];
  assert.equal((fundInvoice.match(/payTreasuryFee\(/g) || []).length, 3);
  assert.match(script, /const BASE_TRANSACTION_FEE = '0\.01'/);
  assert.match(script, /const COMPANY_CREATION_FEE = '10'/);
  assert.match(script, /const DAO_DEPLOYMENT_FEE = '10'/);
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
