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
  const rpc = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const respond = item => {
        const result = {
          eth_chainId:'0x6d600',
          net_version:'448000',
          eth_blockNumber:'0x1',
          eth_getCode:'0x60006000',
          eth_call:`0x${'0'.repeat(62)}12`
        }[item.method] ?? null;
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

  const owner = ethers.Wallet.createRandom();
  const employee = ethers.Wallet.createRandom();
  const supplier = ethers.Wallet.createRandom();
  const ownerAuth = await signIn(owner);
  const registered = await request(ownerAuth, '/api/org/register', 'POST', { name:'Integration Test Org' });
  assert.equal(registered.response.status, 201);
  const serial = registered.data.company.serial;

  const added = await request(ownerAuth, `/api/org/${serial}/employees`, 'POST', {
    name:'Test Employee', wallet:employee.address, title:'Engineer', salary:'125.25'
  });
  assert.equal(added.response.status, 201);
  const invalidImport = await request(ownerAuth, `/api/org/${serial}/bulk/employees`, 'POST', {
    rows:[
      { name:'Would Roll Back', wallet:ethers.Wallet.createRandom().address, title:'Engineer', salary:'1' },
      { name:'Bad Wallet', wallet:'not-an-address', title:'Engineer', salary:'1' }
    ]
  });
  assert.equal(invalidImport.response.status, 400);
  assert.equal((await request(ownerAuth, `/api/org/${serial}/employees`)).data.length, 1);

  const employeeAuth = await signIn(employee);
  assert.equal((await request(employeeAuth, `/api/org/${serial}/employees`)).response.status, 200);
  assert.equal((await request(employeeAuth, `/api/org/${serial}/invoices`)).response.status, 403);
  assert.equal((await request(employeeAuth, `/api/org/${serial}/report`)).response.status, 403);

  const supplierAuth = await signIn(supplier);
  const invoice = await request(supplierAuth, `/api/org/${serial}/invoices`, 'POST', {
    invoiceNumber:'INV-1', amount:'10.50', dueDate:'2030-01-01', description:'Integration test invoice'
  });
  assert.equal(invoice.response.status, 201);
  assert.equal((await request(supplierAuth, `/api/org/${serial}/activity`)).response.status, 200);
  assert.equal((await request(supplierAuth, `/api/org/${serial}/employees`)).response.status, 403);
  const companyInvoices = await request(ownerAuth, `/api/org/${serial}/invoices`);
  assert.equal(companyInvoices.response.status, 200);
  assert.equal(companyInvoices.data.length, 1);
  assert.equal(companyInvoices.data[0].supplier_wallet.toLowerCase(), supplier.address.toLowerCase());

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
