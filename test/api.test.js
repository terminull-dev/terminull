const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ethers } = require('ethers');

const root = path.join(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('wallet authentication scopes company, employee, and supplier APIs', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminull-api-'));
  const rpcTransactions = new Map();
  const rpcReceipts = new Map();
  const rpcCallResults = new Map();
  const rpcLogs = [];
  const rpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const respond = item => {
        const defaults = {
          eth_chainId:'0x6d600',
          net_version:'448000',
          eth_blockNumber:'0x1',
          eth_getCode:'0x60006000',
          eth_call:`0x${'0'.repeat(62)}12`
        };
        const hash = item.params?.[0];
        let result = defaults[item.method] ?? null;
        if (item.method === 'eth_getTransactionByHash') result = rpcTransactions.get(hash) || null;
        if (item.method === 'eth_getTransactionReceipt') result = rpcReceipts.get(hash) || null;
        if (item.method === 'eth_getLogs') result = rpcLogs;
        if (item.method === 'eth_call') {
          result = rpcCallResults.get(item.params?.[0]?.data?.slice(0, 10)) || defaults.eth_call;
        }
        if (item.method === 'eth_getBlockByNumber') {
          result = {
            number:item.params?.[0] || '0x2',
            hash:`0x${'b'.repeat(64)}`,
            parentHash:`0x${'c'.repeat(64)}`,
            timestamp:'0x6553f100',
            nonce:'0x0000000000000000',
            difficulty:'0x0',
            gasLimit:'0x1c9c380',
            gasUsed:'0x5208',
            miner:'0x0000000000000000000000000000000000000000',
            extraData:'0x',
            transactions:[]
          };
        }
        return { jsonrpc:'2.0', id:item.id, result };
      };
      const request = JSON.parse(body);
      res.writeHead(200, { 'Content-Type':'application/json' });
      res.end(JSON.stringify(Array.isArray(request) ? request.map(respond) : respond(request)));
    });
  });
  await new Promise(resolve => rpc.listen(0, '127.0.0.1', resolve));
  const rpcPort = rpc.address().port;
  const serverPort = await new Promise(resolve => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  const process = spawn(global.process.execPath, ['server.js'], {
    cwd:root,
    env:{
      ...global.process.env,
      PORT:String(serverPort),
      RPC_URL:`http://127.0.0.1:${rpcPort}`,
      DATA_DIR:directory,
      SESSION_SECRET:'test-only-session-secret'
    },
    stdio:'ignore'
  });
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) {
      process.kill('SIGTERM');
      await new Promise(resolve => process.once('exit', resolve));
    }
    await new Promise(resolve => rpc.close(resolve));
    fs.rmSync(directory, { recursive:true, force:true });
  });

  const base = `http://127.0.0.1:${serverPort}`;
  let ready = false;
  for (let attempt=0; attempt<100; attempt++) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch {}
    if (process.exitCode !== null) break;
    await wait(100);
  }
  assert.equal(ready, true, 'API server should start against the test RPC');

  const appResponse = await fetch(`${base}/app`);
  assert.equal(appResponse.status, 200);
  assert.match(await appResponse.text(), /src="\/public\/ethers\.umd\.min\.js"/);
  const ethersResponse = await fetch(`${base}/public/ethers.umd.min.js`);
  assert.equal(ethersResponse.status, 200);
  assert.match(ethersResponse.headers.get('content-type') || '', /javascript/);

  async function signIn(signer) {
    const challengeResponse = await fetch(`${base}/api/auth/challenge`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ wallet:signer.address })
    });
    assert.equal(challengeResponse.status, 200);
    const challenge = await challengeResponse.json();
    const signature = await signer.signMessage(challenge.message);
    const response = await fetch(`${base}/api/auth/verify`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ wallet:signer.address, signature })
    });
    assert.equal(response.status, 200);
    return { wallet:signer.address, headers:{ Authorization:`Bearer ${(await response.json()).token}`, 'Content-Type':'application/json' } };
  }

  async function request(auth, endpoint, method = 'GET', body) {
    const response = await fetch(`${base}${endpoint}`, {
      method,
      headers:auth.headers,
      ...(body === undefined ? {} : { body:JSON.stringify(body) })
    });
    return { response, data:await response.json() };
  }

  function registerTransaction(hash, from, to, events = [], { data = '0x', contractAddress = null } = {}) {
    const blockNumber = '0x2';
    const blockHash = `0x${'b'.repeat(64)}`;
    rpcTransactions.set(hash, {
      hash,
      from,
      to,
      input:data,
      nonce:'0x0',
      gas:'0x5208',
      gasPrice:'0x3b9aca00',
      value:'0x0',
      v:'0x1',
      r:`0x${'1'.repeat(64)}`,
      s:`0x${'1'.repeat(64)}`,
      chainId:'0x6d600',
      blockNumber,
      blockHash,
      transactionIndex:'0x0',
      type:'0x0'
    });
    rpcReceipts.set(hash, {
      transactionHash:hash,
      transactionIndex:'0x0',
      blockHash,
      blockNumber,
      from,
      to,
      cumulativeGasUsed:'0x5208',
      gasUsed:'0x5208',
      contractAddress,
      logsBloom:`0x${'0'.repeat(512)}`,
      status:'0x1',
      type:'0x0',
      logs:events.map(({ address, iface, name, args }, index) => {
        const encoded = iface.encodeEventLog(iface.getEvent(name), args);
        return {
          address,
          topics:encoded.topics,
          data:encoded.data,
          blockNumber,
          transactionHash:hash,
          transactionIndex:'0x0',
          blockHash,
          logIndex:`0x${index.toString(16)}`,
          removed:false
        };
      })
    });
  }

  function registerConfirmedTransfer(hash, from, to, amount) {
    const tokenAddress = '0x7ec3659A8225ED474D7c662126616aE08545C29b';
    const transferInterface = new ethers.Interface([
      'event Transfer(address indexed from,address indexed to,uint256 value)'
    ]);
    registerTransaction(hash, from, tokenAddress, [{
      address:tokenAddress,
      iface:transferInterface,
      name:'Transfer',
      args:[from, to, amount]
    }]);
  }

  function registerRpcTransferLog(hash, from, to, amount) {
    const tokenAddress = '0x7ec3659A8225ED474D7c662126616aE08545C29b';
    const transferInterface = new ethers.Interface([
      'event Transfer(address indexed from,address indexed to,uint256 value)'
    ]);
    const encoded = transferInterface.encodeEventLog(transferInterface.getEvent('Transfer'), [from, to, amount]);
    rpcLogs.push({
      address:tokenAddress,
      topics:encoded.topics,
      data:encoded.data,
      blockNumber:'0x1',
      transactionHash:hash,
      transactionIndex:'0x0',
      blockHash:`0x${'b'.repeat(64)}`,
      logIndex:'0x0',
      removed:false
    });
  }

  const owner = ethers.Wallet.createRandom();
  const employee = ethers.Wallet.createRandom();
  const supplier = ethers.Wallet.createRandom();
  const ownerAuth = await signIn(owner);
  const registered = await request(ownerAuth, '/api/org/register', 'POST', { name:'Integration Test Org' });
  assert.equal(registered.response.status, 201);
  const serial = registered.data.company.serial;
  const profileSaved = await request(ownerAuth, `/api/org/${serial}/profile`, 'PUT', {
    legal_name:'Integration Test Holdings Ltd', registration_number:'REG-448000',
    registration_jurisdiction:'Paris 8.2', employee_size:'11-50', website:'https://example.test',
    locations:[{ name:'Paris office', location_type:'OFFICE', city:'Paris', country:'France', email:'ops@example.test' }]
  });
  assert.equal(profileSaved.response.status, 200);
  const profile = await request(ownerAuth, `/api/org/${serial}/profile`);
  assert.equal(profile.data.profile.legal_name, 'Integration Test Holdings Ltd');
  assert.equal(profile.data.profile.registration_number, 'REG-448000');
  assert.equal(profile.data.locations[0].city, 'Paris');

  const added = await request(ownerAuth, `/api/org/${serial}/employees`, 'POST', {
    name:'Test Employee', wallet:employee.address, title:'Engineer', salary:'125.25',
    department:'Engineering', work_email:'employee@example.test', work_phone:'+33123456789',
    employment_type:'FULL_TIME', start_date:'2025-01-15', location:'Paris',
    reports_to_wallet:owner.address
  });
  assert.equal(added.response.status, 201);
  assert.equal(added.data.reportsToWallet, owner.address);
  const employeeList = await request(ownerAuth, `/api/org/${serial}/employees`);
  assert.equal(employeeList.data[0].department, 'Engineering');
  assert.equal(employeeList.data[0].work_email, 'employee@example.test');
  const selfReportingEmployee = await request(ownerAuth, `/api/org/${serial}/employees`, 'POST', {
    name:'Invalid Reporting Employee', wallet:ethers.Wallet.createRandom().address,
    title:'Analyst', reports_to_wallet:ethers.Wallet.createRandom().address
  });
  assert.equal(selfReportingEmployee.response.status, 400);
  const organogram = await request(ownerAuth, `/api/org/${serial}/organogram`);
  assert.equal(organogram.response.status, 200);
  assert.equal(organogram.data.ownerWallet.toLowerCase(), owner.address.toLowerCase());
  assert.equal(organogram.data.employees[0].reports_to_wallet.toLowerCase(), owner.address.toLowerCase());
  const invalidImport = await request(ownerAuth, `/api/org/${serial}/bulk/employees`, 'POST', {
    rows:[
      { name:'Would Roll Back', wallet:ethers.Wallet.createRandom().address, title:'Engineer', salary:'1' },
      { name:'Bad Wallet', wallet:'not-an-address', title:'Engineer', salary:'1' }
    ]
  });
  assert.equal(invalidImport.response.status, 400);
  assert.equal((await request(ownerAuth, `/api/org/${serial}/employees`)).data.length, 1);

  const importedEmployee = ethers.Wallet.createRandom();
  const employeeImport = await request(ownerAuth, `/api/org/${serial}/bulk/employees`, 'POST', {
    rows:[{ name:'Imported Employee', wallet:importedEmployee.address, title:'Analyst', salary:'50' }]
  });
  assert.equal(employeeImport.response.status, 201);
  assert.equal(employeeImport.data.imported, 1);
  const importedEmployees = await request(ownerAuth, `/api/org/${serial}/employees`);
  const originalEmployeeRecord = importedEmployees.data.find(row => row.wallet.toLowerCase() === employee.address.toLowerCase());
  const importedEmployeeRecord = importedEmployees.data.find(row => row.wallet.toLowerCase() === importedEmployee.address.toLowerCase());
  assert.equal((await request(ownerAuth, `/api/org/${serial}/employees/${originalEmployeeRecord.id}`, 'PUT', {
    reports_to_wallet:importedEmployee.address
  })).response.status, 200);
  assert.equal((await request(ownerAuth, `/api/org/${serial}/employees/${importedEmployeeRecord.id}`, 'PUT', {
    reports_to_wallet:employee.address
  })).response.status, 400);

  const supplierAdded = await request(ownerAuth, `/api/org/${serial}/suppliers`, 'POST', {
    name:'Test Supplier', wallet:supplier.address, email:'supplier@example.test',
    legal_name:'Test Supplier SAS', registration_number:'SUP-448',
    tax_id:'FR-123456', website:'https://supplier.example.test',
    phone:'+33111222333', billing_address:'1 Rue Test, Paris', payment_terms:'NET30'
  });
  assert.equal(supplierAdded.response.status, 201);
  assert.equal(supplierAdded.data.registrationNumber, 'SUP-448');
  const importedSupplier = ethers.Wallet.createRandom();
  const supplierImport = await request(ownerAuth, `/api/org/${serial}/bulk/suppliers`, 'POST', {
    rows:[{ name:'Imported Supplier', wallet:importedSupplier.address, email:'imported@example.test' }]
  });
  assert.equal(supplierImport.response.status, 201);
  assert.equal(supplierImport.data.imported, 1);
  assert.equal((await request(ownerAuth, `/api/org/${serial}/suppliers`)).data.length, 2);
  assert.equal((await request(ownerAuth, `/api/org/${serial}/treasury`)).data.dao, null);
  assert.equal((await request(ownerAuth, `/api/org/${serial}/escrow`)).data.escrow, null);
  const initialSettings = await request(ownerAuth, `/api/org/${serial}/settings`);
  assert.equal(initialSettings.response.status, 200);
  assert.deepEqual(initialSettings.data.settings, {
    employee_payment_privacy_level:'PUBLIC',
    supplier_payment_privacy_level:'PUBLIC',
    dao_transaction_privacy_level:'PUBLIC',
    updated_at:null
  });
  const invalidSettings = await request(ownerAuth, `/api/org/${serial}/settings`, 'PUT', {
    employee_payment_privacy_level:'SECRET',
    supplier_payment_privacy_level:'PUBLIC',
    dao_transaction_privacy_level:'PUBLIC'
  });
  assert.equal(invalidSettings.response.status, 400);
  const savedSettings = await request(ownerAuth, `/api/org/${serial}/settings`, 'PUT', {
    employee_payment_privacy_level:'ZK_PRIVATE',
    supplier_payment_privacy_level:'SHIELDED',
    dao_transaction_privacy_level:'PUBLIC'
  });
  assert.equal(savedSettings.response.status, 200);
  assert.deepEqual({
    employee:savedSettings.data.settings.employee_payment_privacy_level,
    supplier:savedSettings.data.settings.supplier_payment_privacy_level,
    dao:savedSettings.data.settings.dao_transaction_privacy_level
  }, { employee:'ZK_PRIVATE', supplier:'SHIELDED', dao:'PUBLIC' });
  assert.equal((await request(ownerAuth, `/api/org/${serial}/settings`)).data.settings.supplier_payment_privacy_level, 'SHIELDED');
  const contractsResponse = await fetch(`${base}/api/contracts`, { headers:ownerAuth.headers });
  assert.equal(contractsResponse.status, 200);
  const contracts = await contractsResponse.json();
  assert.ok(contracts.CompanyDAO.abi.length > 0);
  assert.ok(contracts.CompanyEscrow.abi.length > 0);

  const employeeAuth = await signIn(employee);
  assert.equal((await request(employeeAuth, `/api/org/${serial}/employees`)).response.status, 200);
  assert.equal((await request(employeeAuth, `/api/org/${serial}/invoices`)).response.status, 403);
  assert.equal((await request(employeeAuth, `/api/org/${serial}/report`)).response.status, 403);
  assert.equal((await request(employeeAuth, `/api/org/${serial}/settings`)).response.status, 403);

  const supplierAuth = await signIn(supplier);
  assert.equal((await request(supplierAuth, `/api/org/${serial}/suppliers`)).data.length, 1);
  assert.equal((await request(supplierAuth, `/api/org/${serial}/settings`, 'PUT', {
    employee_payment_privacy_level:'PUBLIC',
    supplier_payment_privacy_level:'PUBLIC',
    dao_transaction_privacy_level:'PUBLIC'
  })).response.status, 403);
  const invoice = await request(supplierAuth, `/api/org/${serial}/invoices`, 'POST', {
    invoiceNumber:'INV-1', amount:'10.50', dueDate:'2030-01-01', description:'Integration test invoice'
  });
  assert.equal(invoice.response.status, 201);
  assert.equal((await request(supplierAuth, `/api/org/${serial}/activity`)).response.status, 200);
  assert.equal((await request(supplierAuth, `/api/org/${serial}/employees`)).response.status, 403);
  const nominee = ethers.Wallet.createRandom();
  const nomination = await request(ownerAuth, `/api/org/${serial}/executives`, 'POST', {
    name:'Accepted CFO', office:'CFO', wallet:nominee.address,
    email:'cfo@example.test',
    permissions:{ profile:'VIEW', employees:'VIEW', projects:'MANAGE', clients:'MANAGE', accounting:'VIEW' }
  });
  assert.equal(nomination.response.status, 201);
  assert.equal(nomination.data.status, 'PENDING');
  const wrongExecutiveAuth = await signIn(ethers.Wallet.createRandom());
  assert.equal((await request(wrongExecutiveAuth, `/api/org/${serial}/executives/${nomination.data.id}/accept`, 'POST', {})).response.status, 404);
  assert.equal((await request(wrongExecutiveAuth, `/api/org/${serial}/projects`)).response.status, 403);
  const nomineeAuth = await signIn(nominee);
  assert.equal((await request(nomineeAuth, `/api/org/${serial}/executives/${nomination.data.id}/accept`, 'POST', {})).response.status, 200);
  assert.equal((await request(nomineeAuth, `/api/org/${serial}/profile`)).response.status, 200);
  assert.equal((await request(nomineeAuth, `/api/org/${serial}/employees`)).response.status, 200);
  assert.equal((await request(nomineeAuth, `/api/org/${serial}/suppliers`)).response.status, 403);
  assert.equal((await request(nomineeAuth, `/api/org/${serial}/employees`, 'POST', {
    name:'Unauthorized Employee', wallet:ethers.Wallet.createRandom().address, title:'Analyst'
  })).response.status, 403);
  assert.equal((await request(nomineeAuth, `/api/org/${serial}/accounting/targets`, 'PUT', {
    period:'2030-01', target_income:'10', target_outflow:'5'
  })).response.status, 403);
  const executiveProject = await request(nomineeAuth, `/api/org/${serial}/projects`, 'POST', {
    name:'Executive-managed project', budget:'100', target_start:'2030-01-01', target_end:'2030-12-31'
  });
  assert.equal(executiveProject.response.status, 201);
  const executiveTeam = await request(nomineeAuth, `/api/org/${serial}/projects/${executiveProject.data.id}/teams`, 'POST', {
    name:'Engineering', members:[{ wallet:employee.address, role:'Lead' }]
  });
  assert.equal(executiveTeam.response.status, 201);
  const executiveTask = await request(nomineeAuth, `/api/org/${serial}/projects/${executiveProject.data.id}/tasks`, 'POST', {
    title:'Build integration', assigned_wallet:employee.address, team_id:executiveTeam.data.id
  });
  assert.equal(executiveTask.response.status, 201);
  assert.equal((await request(nomineeAuth, `/api/org/${serial}/projects`)).data[0].tasks[0].title, 'Build integration');
  assert.equal((await request(nomineeAuth, `/api/org/${serial}/projects/${executiveProject.data.id}/budget/confirm`, 'POST', {
    txHash:`0x${'1'.repeat(64)}`
  })).response.status, 403);
  const client = await request(nomineeAuth, `/api/org/${serial}/clients`, 'POST', {
    name:'Acme contact', company_name:'Acme', email:'contact@acme.example.test',
    estimated_value:'500', status:'LEAD', expected_close:'2030-06-30',
    next_action:'Schedule discovery'
  });
  assert.equal(client.response.status, 201);
  assert.equal(client.data.status, 'LEAD');
  assert.equal((await request(nomineeAuth, `/api/org/${serial}/clients`)).data.length, 1);
  const revoked = await request(ownerAuth, `/api/org/${serial}/executives/${nomination.data.id}/revoke`, 'POST', {});
  assert.equal(revoked.response.status, 200);
  assert.equal((await request(nomineeAuth, `/api/org/${serial}/projects`)).response.status, 403);
  const invalidTarget = await request(ownerAuth, `/api/org/${serial}/accounting/targets`, 'PUT', {
    period:'2030-13', target_income:'100', target_outflow:'50'
  });
  assert.equal(invalidTarget.response.status, 400);
  const target = await request(ownerAuth, `/api/org/${serial}/accounting/targets`, 'PUT', {
    period:'2030-01', target_income:'1000', target_outflow:'750'
  });
  assert.equal(target.response.status, 200);
  const accounting = await request(ownerAuth, `/api/org/${serial}/accounting`);
  assert.equal(accounting.response.status, 200);
  assert.equal(accounting.data.targets[0].period, '2030-01');
  assert.deepEqual(accounting.data.actuals, []);
  registerRpcTransferLog(
    `0x${'9'.repeat(64)}`, supplier.address, owner.address, ethers.parseUnits('12.5', 18)
  );
  const sync = await request(ownerAuth, `/api/org/${serial}/accounting/sync`, 'POST', {
    start_block:0, max_blocks:1
  });
  assert.equal(sync.response.status, 200);
  assert.equal(sync.data.indexed, 1);
  assert.equal(sync.data.fromBlock, 0);
  const indexedAccounting = await request(ownerAuth, `/api/org/${serial}/accounting`);
  assert.equal(indexedAccounting.data.transfers.length, 1);
  assert.equal(indexedAccounting.data.actuals[0].income_raw, ethers.parseUnits('12.5', 18).toString());
  const conflictingSync = await request(ownerAuth, `/api/org/${serial}/accounting/sync`, 'POST', {
    start_block:0, max_blocks:1
  });
  assert.equal(conflictingSync.response.status, 409);
  const enhancedReport = await request(ownerAuth, `/api/org/${serial}/report`);
  assert.equal(enhancedReport.response.status, 200);
  assert.equal(enhancedReport.data.companyProfile.legal_name, 'Integration Test Holdings Ltd');
  assert.equal(enhancedReport.data.projects[0].name, 'Executive-managed project');
  assert.equal(enhancedReport.data.clients[0].company_name, 'Acme');

  const companyInvoices = await request(ownerAuth, `/api/org/${serial}/invoices`);
  assert.equal(companyInvoices.response.status, 200);
  assert.equal(companyInvoices.data.length, 1);
  assert.equal(companyInvoices.data[0].supplier_wallet.toLowerCase(), supplier.address.toLowerCase());
  assert.equal((await request(supplierAuth, '/api/my/invoices')).data.length, 1);

  const tokenAddress = '0x7ec3659A8225ED474D7c662126616aE08545C29b';
  const escrowAddress = ethers.getAddress(`0x${'a'.repeat(40)}`);
  const escrowArtifact = contracts.CompanyEscrow;
  const escrowDeploymentData = `${escrowArtifact.bytecode}${ethers.AbiCoder.defaultAbiCoder()
    .encode(['address', 'address'], [owner.address, tokenAddress]).slice(2)}`;
  const escrowDeployHash = `0x${'e'.repeat(64)}`;
  registerTransaction(escrowDeployHash, owner.address, null, [], {
    data:escrowDeploymentData,
    contractAddress:escrowAddress
  });
  rpcCallResults.set(ethers.id('company()').slice(0, 10), ethers.AbiCoder.defaultAbiCoder().encode(['address'], [owner.address]));
  rpcCallResults.set(ethers.id('token()').slice(0, 10), ethers.AbiCoder.defaultAbiCoder().encode(['address'], [tokenAddress]));
  const escrowDeployment = await request(ownerAuth, `/api/org/${serial}/contracts/escrow`, 'POST', {
    txHash:escrowDeployHash
  });
  assert.equal(escrowDeployment.response.status, 200);
  assert.equal(escrowDeployment.data.address, escrowAddress);

  const escrowInterface = new ethers.Interface([
    'event EscrowCreated(uint256 indexed escrowId,bytes32 indexed invoiceId,address indexed supplier,address token,uint256 amount,uint64 refundAfter)',
    'event EscrowReleased(uint256 indexed escrowId,address indexed supplier,uint256 amount)',
    'event EscrowRefunded(uint256 indexed escrowId,address indexed company,uint256 amount)'
  ]);
  const tokenInterface = new ethers.Interface([
    'event Transfer(address indexed from,address indexed to,uint256 value)'
  ]);
  const amountRaw = ethers.parseUnits('10.50', 18);
  function registerEscrowReceipt(hash, eventName, escrowId, invoiceId, transferFrom, transferTo) {
    const events = [{
      address:escrowAddress,
      iface:escrowInterface,
      name:eventName,
      args:eventName === 'EscrowCreated'
        ? [escrowId, invoiceId, supplier.address, tokenAddress, amountRaw, 4_000_000_000n]
        : [escrowId, transferTo, amountRaw]
    }, {
      address:tokenAddress,
      iface:tokenInterface,
      name:'Transfer',
      args:[transferFrom, transferTo, amountRaw]
    }];
    registerTransaction(hash, owner.address, escrowAddress, events);
  }

  const firstInvoiceId = ethers.id(String(invoice.data.id));
  const firstFundingHash = `0x${'f'.repeat(64)}`;
  registerEscrowReceipt(firstFundingHash, 'EscrowCreated', 1n, firstInvoiceId, owner.address, escrowAddress);
  const firstFunding = await request(ownerAuth, `/api/org/${serial}/invoices/${invoice.data.id}/fund`, 'POST', {
    txHash:firstFundingHash
  });
  assert.equal(firstFunding.response.status, 200);
  assert.equal(firstFunding.data.escrow_id, '1');
  const releaseHash = `0x${'1'.repeat(64)}`;
  registerEscrowReceipt(releaseHash, 'EscrowReleased', 1n, firstInvoiceId, escrowAddress, supplier.address);
  const release = await request(ownerAuth, `/api/org/${serial}/invoices/${invoice.data.id}/release`, 'POST', {
    txHash:releaseHash
  });
  assert.equal(release.response.status, 200);
  assert.equal(release.data.status, 'PAID');
  assert.equal((await request(ownerAuth, `/api/org/${serial}/invoices`)).data[0].status, 'PAID');

  const applicant = ethers.Wallet.createRandom();
  const applicantAuth = await signIn(applicant);
  const join = await request(applicantAuth, '/api/join-requests', 'POST', {
    serial, role:'employee', name:'Joining Employee', title:'Analyst', salary:'50'
  });
  assert.equal(join.response.status, 201);
  const requests = await request(ownerAuth, `/api/org/${serial}/join-requests`);
  assert.equal(requests.data.length, 1);
  const approved = await request(ownerAuth, `/api/org/${serial}/join-requests/${join.data.requestId}/approve`, 'POST', {});
  assert.equal(approved.response.status, 200);
  const applicantSession = await request(applicantAuth, '/api/session');
  assert.equal(applicantSession.data.employeeRows[0].serial, serial);

  const missingReceipt = await request(ownerAuth, `/api/org/${serial}/payments/confirm`, 'POST', {
    txHash:`0x${'a'.repeat(64)}`, recipient:employee.address, amount:'1.25', memo:'Salary payment'
  });
  assert.equal(missingReceipt.response.status, 400);

  const paymentHash = `0x${'d'.repeat(64)}`;
  registerConfirmedTransfer(paymentHash, owner.address, employee.address, ethers.parseUnits('1.25', 18));
  const payment = await request(ownerAuth, `/api/org/${serial}/payments/confirm`, 'POST', {
    txHash:paymentHash, recipient:employee.address, amount:'1.25', memo:'Salary payment'
  });
  assert.equal(payment.response.status, 200);
  const secondInvoice = await request(supplierAuth, `/api/org/${serial}/invoices`, 'POST', {
    invoiceNumber:'INV-2', amount:'10.50', dueDate:'2030-01-02', description:'Refund integration test invoice'
  });
  assert.equal(secondInvoice.response.status, 201);
  const secondInvoiceId = ethers.id(String(secondInvoice.data.id));
  const secondFundingHash = `0x${'2'.repeat(64)}`;
  registerEscrowReceipt(secondFundingHash, 'EscrowCreated', 2n, secondInvoiceId, owner.address, escrowAddress);
  const secondFunding = await request(ownerAuth, `/api/org/${serial}/invoices/${secondInvoice.data.id}/fund`, 'POST', {
    txHash:secondFundingHash
  });
  assert.equal(secondFunding.response.status, 200);
  const refundHash = `0x${'3'.repeat(64)}`;
  registerEscrowReceipt(refundHash, 'EscrowRefunded', 2n, secondInvoiceId, escrowAddress, owner.address);
  const refund = await request(ownerAuth, `/api/org/${serial}/invoices/${secondInvoice.data.id}/refund`, 'POST', {
    txHash:refundHash
  });
  assert.equal(refund.response.status, 200);
  assert.equal(refund.data.status, 'REFUNDED');

  const daoAddress = ethers.getAddress(`0x${'b'.repeat(40)}`);
  const daoArtifact = contracts.CompanyDAO;
  const daoDeploymentData = `${daoArtifact.bytecode}${ethers.AbiCoder.defaultAbiCoder()
    .encode(['address'], [owner.address]).slice(2)}`;
  const daoDeployHash = `0x${'4'.repeat(64)}`;
  registerTransaction(daoDeployHash, owner.address, null, [], {
    data:daoDeploymentData,
    contractAddress:daoAddress
  });
  rpcCallResults.set(ethers.id('owner()').slice(0, 10), ethers.AbiCoder.defaultAbiCoder().encode(['address'], [owner.address]));
  rpcCallResults.set(ethers.id('quorumPercent()').slice(0, 10), ethers.AbiCoder.defaultAbiCoder().encode(['uint16'], [51]));
  rpcCallResults.set(ethers.id('timelockSeconds()').slice(0, 10), ethers.AbiCoder.defaultAbiCoder().encode(['uint64'], [86400]));
  rpcCallResults.set(ethers.id('proposalCount()').slice(0, 10), ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1]));
  rpcCallResults.set(ethers.id('proposals(uint256)').slice(0, 10), ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint256', 'uint64', 'uint256', 'uint256', 'bool'],
    [tokenAddress, employee.address, ethers.parseUnits('1.25', 18), 1000, 1, 0, true]
  ));
  const daoDeployment = await request(ownerAuth, `/api/org/${serial}/contracts/dao`, 'POST', {
    txHash:daoDeployHash
  });
  assert.equal(daoDeployment.response.status, 200);
  assert.equal(daoDeployment.data.address, daoAddress);
  const treasury = await request(ownerAuth, `/api/org/${serial}/treasury`);
  assert.equal(treasury.data.dao, daoAddress);
  assert.equal(treasury.data.quorum, 51);
  assert.equal(treasury.data.proposalCount, 1);
  const daoInterface = new ethers.Interface([
    'event ProposalExecuted(uint256 indexed proposalId)'
  ]);
  const daoPaymentHash = `0x${'5'.repeat(64)}`;
  registerTransaction(daoPaymentHash, owner.address, daoAddress, [{
    address:daoAddress,
    iface:daoInterface,
    name:'ProposalExecuted',
    args:[1n]
  }, {
    address:tokenAddress,
    iface:tokenInterface,
    name:'Transfer',
    args:[daoAddress, employee.address, ethers.parseUnits('1.25', 18)]
  }]);
  const daoPayment = await request(ownerAuth, `/api/org/${serial}/dao/1/confirm`, 'POST', {
    txHash:daoPaymentHash
  });
  assert.equal(daoPayment.response.status, 200);
  assert.equal(daoPayment.data.amount_raw, ethers.parseUnits('1.25', 18).toString());

  const report = await request(ownerAuth, `/api/org/${serial}/report`);
  assert.equal(report.response.status, 200);
  assert.equal(report.data.transactions.length, 8);
  assert.equal(report.data.employees.length, 3);
  assert.equal(report.data.suppliers.length, 2);
  assert.equal(report.data.invoices.length, 2);
  const employeeActivity = await request(employeeAuth, `/api/org/${serial}/activity`);
  assert.equal(employeeActivity.data.length, 2);
  assert.deepEqual(new Set(employeeActivity.data.map(item => item.tx_hash)), new Set([paymentHash, daoPaymentHash]));
  const supplierActivity = await request(supplierAuth, `/api/org/${serial}/activity`);
  assert.equal(supplierActivity.data.length, 3);
});

test('workspace and wallet sign-in remain available when the RPC is offline', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminull-offline-rpc-'));
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const process = spawn(global.process.execPath, ['server.js'], {
    cwd:root,
    env:{
      ...global.process.env,
      PORT:String(port),
      RPC_URL:'http://127.0.0.1:1',
      DATA_DIR:directory,
      SESSION_SECRET:'test-only-session-secret'
    },
    stdio:'ignore'
  });
  t.after(async () => {
    if (process.exitCode === null && process.signalCode === null) {
      process.kill('SIGTERM');
      await new Promise(resolve => process.once('exit', resolve));
    }
    fs.rmSync(directory, { recursive:true, force:true });
  });

  const base = `http://127.0.0.1:${port}`;
  let response;
  for (let attempt=0; attempt<100; attempt++) {
    try {
      response = await fetch(`${base}/app`);
      if (response.ok) break;
    } catch {}
    if (process.exitCode !== null) break;
    await wait(100);
  }
  assert.equal(response?.status, 200, 'workspace should load without a chain RPC');

  const signer = ethers.Wallet.createRandom();
  const challengeResponse = await fetch(`${base}/api/auth/challenge`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ wallet:signer.address })
  });
  assert.equal(challengeResponse.status, 200);
  const { message } = await challengeResponse.json();
  const verifyResponse = await fetch(`${base}/api/auth/verify`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ wallet:signer.address, signature:await signer.signMessage(message) })
  });
  assert.equal(verifyResponse.status, 200);
  const { token } = await verifyResponse.json();
  assert.ok(token);
  const registerResponse = await fetch(`${base}/api/org/register`, {
    method:'POST',
    headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ name:'Offline RPC Test Company' })
  });
  assert.equal(registerResponse.status, 201);

  const healthResponse = await fetch(`${base}/api/health`);
  assert.equal(healthResponse.status, 503);
});
