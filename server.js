const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const solc = require('solc');
const { ethers } = require('ethers');

const app = express();
const PORT = Number(process.env.PORT || 4001);
const CHAIN_ID = 448000;
const RPC_URL = process.env.RPC_URL || 'https://rpc.lunul.org';
const USDT = ethers.getAddress(process.env.USDT_ADDRESS || '0x7ec3659A8225ED474D7c662126616aE08545C29b');
const ZK_POOL = ethers.getAddress(process.env.ZK_POOL_ADDRESS || '0xC82681a28Bf26f6beb6b48442Ba9887a2872743B');
const GROTH_VERIFIER = ethers.getAddress(process.env.GROTH_VERIFIER_ADDRESS || '0x39e1451944d2F71F586850f81c12E9A8DA5A73b0');
const TOKEN_INTERFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function decimals() view returns (uint8)'
]);
const ESCROW_INTERFACE = new ethers.Interface([
  'event EscrowCreated(uint256 indexed escrowId, bytes32 indexed invoiceId, address indexed supplier, address token, uint256 amount, uint64 refundAfter)',
  'event EscrowReleased(uint256 indexed escrowId, address indexed supplier, uint256 amount)',
  'event EscrowRefunded(uint256 indexed escrowId, address indexed company, uint256 amount)'
]);
const DAO_INTERFACE = new ethers.Interface([
  'event ProposalExecuted(uint256 indexed proposalId)'
]);

const dbPath = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'terminull.sqlite')
  : path.join(__dirname, 'terminull-data.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive:true });
const db = new sqlite3.Database(dbPath);
const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId:CHAIN_ID, name:'lunul-poa' });
const challenges = new Map();
const tokenSecret = process.env.SESSION_SECRET || crypto.randomBytes(32);

app.use(cors({ origin: process.env.APP_ORIGIN || false }));
app.use(express.json({ limit: '2mb' }));

const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) return reject(err);
    resolve({ lastID: this.lastID, changes: this.changes });
  });
});
const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

let transactionQueue = Promise.resolve();
async function withTransaction(work) {
  const prior = transactionQueue;
  let release;
  transactionQueue = new Promise(resolve => { release = resolve; });
  await prior;
  try {
    await run('BEGIN IMMEDIATE');
    const result = await work();
    await run('COMMIT');
    return result;
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  } finally {
    release();
  }
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function requireText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    fail(400, `${label} is required and must be at most ${max} characters.`);
  }
  return value.trim();
}

function requireWallet(value, label = 'Wallet address') {
  const address = requireText(value, label, 42);
  if (!ethers.isAddress(address)) fail(400, `${label} must be a valid EVM address.`);
  return ethers.getAddress(address);
}

function requireTokenAmount(value, label = 'Amount') {
  if (typeof value !== 'string' && typeof value !== 'number') fail(400, `${label} must be a decimal amount.`);
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text)) fail(400, `${label} must be a positive amount with at most 18 decimals.`);
  let amount;
  try {
    amount = ethers.parseUnits(text, 18);
  } catch {
    fail(400, `${label} is invalid.`);
  }
  if (amount === 0n) fail(400, `${label} must be greater than zero.`);
  return amount.toString();
}

function requireOrgSerial(value) {
  return requireText(value, 'Company serial', 80);
}

function requirePrivacyLevel(value, label) {
  const allowed = ['PUBLIC', 'SHIELDED', 'ZK_PRIVATE'];
  if (!allowed.includes(value)) fail(400, `${label} must be PUBLIC, SHIELDED, or ZK_PRIVATE.`);
  return value;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function tokenFor(wallet) {
  const payload = Buffer.from(JSON.stringify({
    wallet,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', tokenSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', tokenSecret).update(payload).digest();
  let received;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded.expiresAt > Date.now() ? decoded : null;
  } catch {
    return null;
  }
}

app.get('/', (_req, res) => res.sendFile('index.html', { root: __dirname }));
app.get(['/app', '/dashboard'], (_req, res) => res.sendFile('app.html', { root: __dirname }));
app.get('/public/ethers.umd.min.js', (_req, res) => res.sendFile('node_modules/ethers/dist/ethers.umd.min.js', { root: __dirname }));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/api/health', asyncRoute(async (_req, res) => {
  let network;
  let code;
  let poolCode;
  let verifierCode;
  let decimals;
  try {
    network = await provider.getNetwork();
    [code, poolCode, verifierCode] = await Promise.all([
      provider.getCode(USDT),
      provider.getCode(ZK_POOL),
      provider.getCode(GROTH_VERIFIER)
    ]);
    decimals = await new ethers.Contract(USDT, TOKEN_INTERFACE, provider).decimals();
  } catch (error) {
    console.error('RPC health check failed:', error.message);
    return res.status(503).json({ error:'Configured RPC is unavailable. Wallet sign-in and non-chain UI remain available.' });
  }
  if (Number(network.chainId) !== CHAIN_ID) fail(503, `RPC chain mismatch: expected ${CHAIN_ID}, received ${network.chainId}.`);
  if (code === '0x') fail(503, 'Configured USDT contract has no bytecode on the configured network.');
  if (poolCode === '0x' || verifierCode === '0x') fail(503, 'Configured pool or verifier has no bytecode on the configured network.');
  if (Number(decimals) !== 18) fail(503, 'Configured USDT contract does not report 18 decimals.');
  res.json({
    chainId: Number(network.chainId),
    rpcUrl: RPC_URL,
    usdt: USDT,
    decimals: Number(decimals),
    pool: ZK_POOL,
    verifier: GROTH_VERIFIER,
    poolShieldingAvailable: false,
    shieldDisabledReason: 'Pool commitment recovery and enforced proof verification are not configured.'
  });
}));

app.post('/api/auth/challenge', asyncRoute(async (req, res) => {
  const wallet = requireWallet(req.body.wallet);
  const nonce = crypto.randomBytes(24).toString('hex');
  const message = [
    'Sign in to Terminull',
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Origin: ${req.get('origin') || req.get('host') || 'local'}`
  ].join('\n');
  challenges.set(wallet.toLowerCase(), { nonce, message, expiresAt: Date.now() + 5 * 60 * 1000 });
  res.json({ message });
}));

app.post('/api/auth/verify', asyncRoute(async (req, res) => {
  const wallet = requireWallet(req.body.wallet);
  const challenge = challenges.get(wallet.toLowerCase());
  if (!challenge || challenge.expiresAt < Date.now() || typeof req.body.signature !== 'string') {
    fail(401, 'Sign-in challenge expired. Request a new one.');
  }
  challenges.delete(wallet.toLowerCase());
  let recovered;
  try {
    recovered = ethers.verifyMessage(challenge.message, req.body.signature);
  } catch {
    fail(401, 'Wallet signature is invalid.');
  }
  if (recovered.toLowerCase() !== wallet.toLowerCase()) fail(401, 'Wallet signature does not match the connected address.');
  res.json({ token: tokenFor(wallet), wallet, expiresIn: 12 * 60 * 60 });
}));

app.use('/api', (req, res, next) => {
  if (req.path === '/auth/challenge' || req.path === '/auth/verify' || req.path === '/health') return next();
  const auth = req.get('authorization') || '';
  const session = auth.startsWith('Bearer ') ? readToken(auth.slice(7)) : null;
  if (!session) return res.status(401).json({ error: 'Wallet sign-in is required.' });
  req.wallet = ethers.getAddress(session.wallet);
  next();
});

async function orgBySerial(serial) {
  const org = await get('SELECT serial, name, owner_wallet, dao_address, escrow_address, created_at FROM organizations WHERE serial = ?', [serial]);
  if (!org) fail(404, 'Company not found.');
  return org;
}

async function rolesFor(wallet, serial) {
  const lower = wallet.toLowerCase();
  const roles = [];
  const owner = await get('SELECT serial FROM organizations WHERE serial = ? AND lower(owner_wallet) = ?', [serial, lower]);
  if (owner) roles.push('owner');
  const employee = await get('SELECT id FROM employees WHERE org_serial = ? AND lower(wallet) = ? AND status = \'ACTIVE\'', [serial, lower]);
  if (employee) roles.push('employee');
  const supplier = await get(
    `SELECT id FROM vendors WHERE org_serial = ? AND lower(wallet) = ? AND status = 'ACTIVE'
     UNION ALL SELECT id FROM invoices WHERE org_serial = ? AND lower(supplier_wallet) = ? LIMIT 1`,
    [serial, lower, serial, lower]
  );
  if (supplier) roles.push('supplier');
  return roles;
}

async function requireRole(wallet, serial, allowed) {
  const roles = await rolesFor(wallet, serial);
  if (!roles.some(role => allowed.includes(role))) fail(403, 'Your connected wallet does not have permission for this company action.');
  return roles;
}

async function getSession(wallet) {
  const companies = await all(
    'SELECT serial, name, dao_address, escrow_address FROM organizations WHERE lower(owner_wallet) = ? ORDER BY created_at DESC',
    [wallet.toLowerCase()]
  );
  const employeeRows = await all(
    `SELECT e.org_serial AS serial, o.name AS company_name, e.id, e.name, e.title, e.salary_raw, e.status
     FROM employees e JOIN organizations o ON o.serial = e.org_serial
     WHERE lower(e.wallet) = ? AND e.status = 'ACTIVE' ORDER BY o.name`,
    [wallet.toLowerCase()]
  );
  const supplierRows = await all(
    `SELECT v.org_serial AS serial, o.name AS company_name, v.id, v.name, v.status
     FROM vendors v JOIN organizations o ON o.serial = v.org_serial
     WHERE lower(v.wallet) = ? AND v.status = 'ACTIVE' ORDER BY o.name`,
    [wallet.toLowerCase()]
  );
  const invoiceRows = await all(
    `SELECT DISTINCT i.org_serial AS serial, o.name AS company_name
     FROM invoices i JOIN organizations o ON o.serial = i.org_serial
     WHERE lower(i.supplier_wallet) = ? ORDER BY o.name`,
    [wallet.toLowerCase()]
  );
  return { wallet, companies, employeeRows, supplierRows, invoiceRows };
}

app.get('/api/session', asyncRoute(async (req, res) => {
  res.json(await getSession(req.wallet));
}));

app.post('/api/join-requests', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.body.serial);
  await orgBySerial(serial);
  const requestedRole = req.body.role;
  if (!['employee', 'supplier'].includes(requestedRole)) fail(400, 'Role must be employee or supplier.');
  if ((await rolesFor(req.wallet, serial)).length) fail(409, 'This wallet already has a company role.');
  const name = requireText(req.body.name, 'Name');
  const title = requestedRole === 'employee' ? requireText(req.body.title, 'Title', 100) : '';
  const salaryRaw = requestedRole === 'employee' ? requireTokenAmount(String(req.body.salary), 'Salary') : '';
  const email = requestedRole === 'supplier' && req.body.email ? requireText(req.body.email, 'Email', 200) : '';
  const pending = await get(
    `SELECT id FROM join_requests WHERE org_serial = ? AND lower(wallet) = ? AND requested_role = ? AND status = 'PENDING'`,
    [serial, req.wallet.toLowerCase(), requestedRole]
  );
  if (pending) fail(409, 'A pending request for this company and role already exists.');
  const result = await run(
    `INSERT INTO join_requests (org_serial, wallet, requested_role, name, title, salary_raw, contact_email)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [serial, req.wallet, requestedRole, name, title, salaryRaw, email]
  );
  res.status(201).json({ success: true, requestId: result.lastID });
}));

app.get('/api/org/:serial/join-requests', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  res.json(await all(
    `SELECT id, wallet, requested_role, name, title, salary_raw, contact_email, status, created_at
     FROM join_requests WHERE org_serial = ? AND status = 'PENDING' ORDER BY created_at, id`,
    [serial]
  ));
}));

app.post('/api/org/:serial/join-requests/:id/approve', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  await withTransaction(async () => {
    const request = await get(
      `SELECT * FROM join_requests WHERE id = ? AND org_serial = ? AND status = 'PENDING'`,
      [Number(req.params.id), serial]
    );
    if (!request) fail(404, 'Pending join request not found.');
    if (request.requested_role === 'employee') {
      await run(
        'INSERT INTO employees (org_serial, name, wallet, title, salary_raw) VALUES (?, ?, ?, ?, ?)',
        [serial, request.name, request.wallet, request.title, request.salary_raw]
      );
    } else {
      await run(
        'INSERT INTO vendors (org_serial, name, contact_email, wallet) VALUES (?, ?, ?, ?)',
        [serial, request.name, request.contact_email, request.wallet]
      );
    }
    await run("UPDATE join_requests SET status = 'APPROVED' WHERE id = ?", [request.id]);
  });
  res.json({ success: true });
}));

app.post('/api/org/:serial/join-requests/:id/reject', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const result = await run(
    "UPDATE join_requests SET status = 'REJECTED' WHERE id = ? AND org_serial = ? AND status = 'PENDING'",
    [Number(req.params.id), serial]
  );
  if (!result.changes) fail(404, 'Pending join request not found.');
  res.json({ success: true });
}));

app.post('/api/org/register', asyncRoute(async (req, res) => {
  const name = requireText(req.body.name, 'Company name');
  const existing = await get('SELECT serial, name FROM organizations WHERE lower(owner_wallet) = ?', [req.wallet.toLowerCase()]);
  if (existing) return res.json({ success: true, company: existing });
  const serial = `TERM-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  await run(
    'INSERT INTO organizations (serial, name, owner_wallet) VALUES (?, ?, ?)',
    [serial, name, req.wallet]
  );
  res.status(201).json({ success: true, company: { serial, name, owner_wallet: req.wallet, dao_address: null, escrow_address: null } });
}));

app.get('/api/org/:serial', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  const roles = await requireRole(req.wallet, serial, ['owner', 'employee', 'supplier']);
  const org = await orgBySerial(serial);
  res.json({ ...org, roles });
}));

app.get('/api/org/:serial/settings', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const settings = await get(
    `SELECT employee_payment_privacy_level, supplier_payment_privacy_level,
            dao_transaction_privacy_level, updated_at
     FROM company_settings WHERE org_serial = ?`,
    [serial]
  );
  res.json({ settings: settings || {
    employee_payment_privacy_level:'PUBLIC',
    supplier_payment_privacy_level:'PUBLIC',
    dao_transaction_privacy_level:'PUBLIC',
    updated_at:null
  } });
}));

app.put('/api/org/:serial/settings', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const employeeLevel = requirePrivacyLevel(req.body.employee_payment_privacy_level, 'Employee payment privacy level');
  const supplierLevel = requirePrivacyLevel(req.body.supplier_payment_privacy_level, 'Supplier payment privacy level');
  const daoLevel = requirePrivacyLevel(req.body.dao_transaction_privacy_level, 'DAO transaction privacy level');
  await run(
    `INSERT INTO company_settings
      (org_serial, employee_payment_privacy_level, supplier_payment_privacy_level, dao_transaction_privacy_level, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(org_serial) DO UPDATE SET
      employee_payment_privacy_level = excluded.employee_payment_privacy_level,
      supplier_payment_privacy_level = excluded.supplier_payment_privacy_level,
      dao_transaction_privacy_level = excluded.dao_transaction_privacy_level,
      updated_at = CURRENT_TIMESTAMP`,
    [serial, employeeLevel, supplierLevel, daoLevel]
  );
  const settings = await get(
    `SELECT employee_payment_privacy_level, supplier_payment_privacy_level,
            dao_transaction_privacy_level, updated_at
     FROM company_settings WHERE org_serial = ?`,
    [serial]
  );
  res.json({ settings });
}));

app.get('/api/org/:serial/employees', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  const roles = await requireRole(req.wallet, serial, ['owner', 'employee']);
  if (roles.includes('owner')) {
    return res.json(await all('SELECT id, name, wallet, title, salary_raw, status, created_at FROM employees WHERE org_serial = ? ORDER BY name', [serial]));
  }
  res.json(await all(
    'SELECT id, name, wallet, title, salary_raw, status, created_at FROM employees WHERE org_serial = ? AND lower(wallet) = ?',
    [serial, req.wallet.toLowerCase()]
  ));
}));

function cleanEmployee(row) {
  return {
    name: requireText(row.name, 'Employee name'),
    wallet: requireWallet(row.wallet),
    title: row.title ? requireText(row.title, 'Title', 100) : 'Employee',
    salaryRaw: requireTokenAmount(String(row.salary), 'Salary')
  };
}

app.post('/api/org/:serial/employees', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await orgBySerial(serial);
  await requireRole(req.wallet, serial, ['owner']);
  const employee = cleanEmployee(req.body);
  const result = await run(
    'INSERT INTO employees (org_serial, name, wallet, title, salary_raw) VALUES (?, ?, ?, ?, ?)',
    [serial, employee.name, employee.wallet, employee.title, employee.salaryRaw]
  );
  res.status(201).json({ id: result.lastID, ...employee, salary_raw: employee.salaryRaw, status: 'ACTIVE' });
}));

app.post('/api/org/:serial/bulk/:kind', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await orgBySerial(serial);
  await requireRole(req.wallet, serial, ['owner']);
  const rows = req.body.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000) fail(400, 'Upload must contain between 1 and 1000 rows.');
  if (!['employees', 'suppliers'].includes(req.params.kind)) fail(404, 'Unknown import type.');

  const prepared = rows.map((row, index) => {
    try {
      if (req.params.kind === 'employees') return { ...cleanEmployee(row), index: index + 1 };
      return {
        name: requireText(row.name, 'Supplier name'),
        wallet: requireWallet(row.wallet),
        email: row.email ? requireText(row.email, 'Supplier email', 200) : '',
        index: index + 1
      };
    } catch (error) {
      error.message = `Row ${index + 2}: ${error.message}`;
      throw error;
    }
  });
  const addresses = prepared.map(item => item.wallet.toLowerCase());
  if (new Set(addresses).size !== addresses.length) fail(400, 'Upload contains duplicate wallet addresses.');

  await withTransaction(async () => {
    for (const item of prepared) {
      if (req.params.kind === 'employees') {
        await run(
          'INSERT INTO employees (org_serial, name, wallet, title, salary_raw) VALUES (?, ?, ?, ?, ?)',
          [serial, item.name, item.wallet, item.title, item.salaryRaw]
        );
      } else {
        await run(
          'INSERT INTO vendors (org_serial, name, contact_email, wallet) VALUES (?, ?, ?, ?)',
          [serial, item.name, item.email, item.wallet]
        );
      }
    }
  });
  res.status(201).json({ success: true, imported: prepared.length });
}));

app.get('/api/org/:serial/suppliers', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  const roles = await requireRole(req.wallet, serial, ['owner', 'supplier']);
  if (roles.includes('owner')) {
    return res.json(await all(
      'SELECT id, name, contact_email, wallet, status, created_at FROM vendors WHERE org_serial = ? ORDER BY name',
      [serial]
    ));
  }
  res.json(await all(
    'SELECT id, name, contact_email, wallet, status, created_at FROM vendors WHERE org_serial = ? AND lower(wallet) = ?',
    [serial, req.wallet.toLowerCase()]
  ));
}));

app.post('/api/org/:serial/suppliers', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await orgBySerial(serial);
  await requireRole(req.wallet, serial, ['owner']);
  const name = requireText(req.body.name, 'Supplier name');
  const wallet = requireWallet(req.body.wallet);
  const email = req.body.email ? requireText(req.body.email, 'Supplier email', 200) : '';
  const result = await run(
    'INSERT INTO vendors (org_serial, name, contact_email, wallet) VALUES (?, ?, ?, ?)',
    [serial, name, email, wallet]
  );
  res.status(201).json({ id: result.lastID, name, contact_email: email, wallet, status: 'ACTIVE' });
}));

app.post('/api/org/:serial/invoices', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  const org = await orgBySerial(serial);
  const invoiceNumber = requireText(req.body.invoiceNumber, 'Invoice number', 100);
  const description = requireText(req.body.description, 'Description', 1000);
  const amountRaw = requireTokenAmount(String(req.body.amount), 'Invoice amount');
  const dueDate = requireText(req.body.dueDate, 'Due date', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`))) fail(400, 'Due date must use YYYY-MM-DD.');
  const result = await run(
    `INSERT INTO invoices (org_serial, supplier_wallet, invoice_number, amount_raw, due_date, description)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [serial, req.wallet, invoiceNumber, amountRaw, dueDate, description]
  );
  res.status(201).json({
    id: result.lastID,
    org_serial: org.serial,
    company_name: org.name,
    supplier_wallet: req.wallet,
    invoice_number: invoiceNumber,
    amount_raw: amountRaw,
    due_date: dueDate,
    description,
    status: 'OPEN'
  });
}));

app.get('/api/org/:serial/invoices', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  res.json(await all(
    `SELECT id, org_serial, supplier_wallet, invoice_number, amount_raw, due_date, description, status,
            escrow_id, tx_hash, created_at
     FROM invoices WHERE org_serial = ? ORDER BY created_at DESC, id DESC`,
    [serial]
  ));
}));

app.get('/api/my/invoices', asyncRoute(async (req, res) => {
  res.json(await all(
    `SELECT i.id, i.org_serial, o.name AS company_name, i.supplier_wallet, i.invoice_number, i.amount_raw,
            i.due_date, i.description, i.status, i.escrow_id, i.tx_hash, i.created_at
     FROM invoices i JOIN organizations o ON o.serial = i.org_serial
     WHERE lower(i.supplier_wallet) = ? ORDER BY i.created_at DESC, i.id DESC`,
    [req.wallet.toLowerCase()]
  ));
}));

app.get('/api/org/:serial/activity', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  const roles = await requireRole(req.wallet, serial, ['owner', 'employee', 'supplier']);
  const sql = `SELECT tx_hash, wallet_from, wallet_to, kind, asset, amount_raw, status, block_number, timestamp, memo
    FROM transactions WHERE org_serial = ? ${roles.includes('owner') ? '' : 'AND (lower(wallet_from) = ? OR lower(wallet_to) = ?)'}
    ORDER BY block_number DESC, id DESC LIMIT 1000`;
  const params = roles.includes('owner') ? [serial] : [serial, req.wallet.toLowerCase(), req.wallet.toLowerCase()];
  res.json(await all(sql, params));
}));

app.get('/api/org/:serial/report', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const [transactions, invoices, employees, suppliers] = await Promise.all([
    all('SELECT tx_hash, wallet_from, wallet_to, kind, asset, amount_raw, status, block_number, timestamp, memo FROM transactions WHERE org_serial = ? ORDER BY id DESC', [serial]),
    all('SELECT id, supplier_wallet, invoice_number, amount_raw, due_date, description, status, tx_hash FROM invoices WHERE org_serial = ? ORDER BY id DESC', [serial]),
    all('SELECT name, wallet, title, salary_raw, status FROM employees WHERE org_serial = ? ORDER BY name', [serial]),
    all('SELECT name, contact_email, wallet, status FROM vendors WHERE org_serial = ? ORDER BY name', [serial])
  ]);
  res.json({ transactions, invoices, employees, suppliers });
}));

async function inspectTransfer(txHash, wallet, recipient, amountRaw) {
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch {
    fail(400, 'Unable to read the transaction receipt from the configured network.');
  }
  if (!receipt || receipt.status !== 1) fail(400, 'Transaction is not confirmed successfully on the configured network.');
  const tx = await provider.getTransaction(txHash);
  if (!tx || tx.from.toLowerCase() !== wallet.toLowerCase()) fail(403, 'Confirmed transaction sender does not match the signed-in wallet.');
  if (!tx.to || tx.to.toLowerCase() !== USDT.toLowerCase()) fail(400, 'Transaction did not call the configured USDT contract.');
  const target = recipient.toLowerCase();
  const expected = BigInt(amountRaw);
  const matching = receipt.logs
    .filter(log => log.address.toLowerCase() === USDT.toLowerCase())
    .map(log => {
      try { return TOKEN_INTERFACE.parseLog(log); } catch { return null; }
    })
    .filter(event => event && event.name === 'Transfer')
    .find(event => event.args.from.toLowerCase() === wallet.toLowerCase()
      && event.args.to.toLowerCase() === target
      && event.args.value === expected);
  if (!matching) fail(400, 'Confirmed transaction does not contain the expected USDT transfer.');
  return { receipt, tx };
}

app.post('/api/org/:serial/payments/confirm', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const recipient = requireWallet(req.body.recipient, 'Recipient wallet');
  const amountRaw = requireTokenAmount(String(req.body.amount), 'Payment amount');
  const memo = requireText(req.body.memo || 'USDT payment', 'Payment memo', 200);
  const { receipt } = await inspectTransfer(req.body.txHash, req.wallet, recipient, amountRaw);
  await run(
    `INSERT OR IGNORE INTO transactions
      (org_serial, tx_hash, wallet_from, wallet_to, kind, asset, amount_raw, status, block_number, timestamp, memo)
     VALUES (?, ?, ?, ?, 'USDT Payment', 'USDT', ?, 'CONFIRMED', ?, ?, ?)`,
    [serial, receipt.hash, req.wallet, recipient, amountRaw, receipt.blockNumber, new Date((await provider.getBlock(receipt.blockNumber)).timestamp * 1000).toISOString(), memo]
  );
  res.json({ success: true, tx_hash: receipt.hash, block_number: receipt.blockNumber });
}));

async function validateContractDeployment(txHash, wallet, kind) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1 || !receipt.contractAddress) fail(400, 'Contract deployment is not confirmed.');
  const tx = await provider.getTransaction(txHash);
  if (tx.from.toLowerCase() !== wallet.toLowerCase()) fail(403, 'Deployment wallet does not match the signed-in wallet.');
  if (await provider.getCode(receipt.contractAddress) === '0x') fail(400, 'Deployed contract has no code on the configured network.');
  const artifact = compileContracts()[kind === 'dao' ? 'CompanyDAO' : 'CompanyEscrow'];
  const constructorArgs = kind === 'dao'
    ? ethers.AbiCoder.defaultAbiCoder().encode(['address'], [wallet])
    : ethers.AbiCoder.defaultAbiCoder().encode(['address','address'], [wallet, USDT]);
  const expectedData = `${artifact.bytecode}${constructorArgs.slice(2)}`;
  if (tx.data.toLowerCase() !== expectedData.toLowerCase()) {
    fail(400, 'Deployed contract does not match the configured company template and constructor values.');
  }
  const contract = new ethers.Contract(receipt.contractAddress, artifact.abi, provider);
  const [deployedOwner, deployedToken] = kind === 'dao'
    ? [await contract.owner(), null]
    : [await contract.company(), await contract.token()];
  if (deployedOwner.toLowerCase() !== wallet.toLowerCase()) fail(400, 'Contract owner does not match the connected company wallet.');
  if (deployedToken && deployedToken.toLowerCase() !== USDT.toLowerCase()) fail(400, 'Escrow contract token does not match configured USDT.');
  return ethers.getAddress(receipt.contractAddress);
}

app.post('/api/org/:serial/contracts/:kind', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  if (!['dao', 'escrow'].includes(req.params.kind)) fail(404, 'Unknown company contract type.');
  const address = await validateContractDeployment(req.body.txHash, req.wallet, req.params.kind);
  const column = req.params.kind === 'dao' ? 'dao_address' : 'escrow_address';
  await run(`UPDATE organizations SET ${column} = ? WHERE serial = ?`, [address, serial]);
  const receipt = await provider.getTransactionReceipt(req.body.txHash);
  const block = await provider.getBlock(receipt.blockNumber);
  await run(
    `INSERT OR IGNORE INTO transactions
     (org_serial, tx_hash, wallet_from, wallet_to, kind, asset, amount_raw, status, block_number, timestamp, memo)
     VALUES (?, ?, ?, ?, ?, 'CONTRACT', '0', 'CONFIRMED', ?, ?, ?)`,
    [serial, receipt.hash, req.wallet, address,
      req.params.kind === 'dao' ? 'DAO Contract Deployed' : 'Escrow Contract Deployed',
      receipt.blockNumber, new Date(block.timestamp * 1000).toISOString(), 'Company contract deployment']
  );
  res.json({ success: true, address });
}));

app.post('/api/org/:serial/invoices/:id/fund', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  const org = await orgBySerial(serial);
  await requireRole(req.wallet, serial, ['owner']);
  if (!org.escrow_address) fail(400, 'Deploy the company escrow contract before funding an invoice.');
  const invoice = await get('SELECT * FROM invoices WHERE id = ? AND org_serial = ?', [Number(req.params.id), serial]);
  if (!invoice || invoice.status !== 'OPEN') fail(404, 'Open invoice not found.');
  const txHash = requireText(req.body.txHash, 'Funding transaction hash', 66);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) fail(400, 'Escrow funding transaction is not confirmed.');
  const tx = await provider.getTransaction(txHash);
  if (tx.from.toLowerCase() !== req.wallet.toLowerCase() || tx.to?.toLowerCase() !== org.escrow_address.toLowerCase()) {
    fail(403, 'Escrow funding transaction does not match the company wallet and escrow contract.');
  }
  const expectedInvoice = ethers.id(String(invoice.id));
  const event = receipt.logs
    .filter(log => log.address.toLowerCase() === org.escrow_address.toLowerCase())
    .map(log => { try { return ESCROW_INTERFACE.parseLog(log); } catch { return null; } })
    .find(parsed => parsed?.name === 'EscrowCreated'
      && parsed.args.invoiceId === expectedInvoice
      && parsed.args.supplier.toLowerCase() === invoice.supplier_wallet.toLowerCase()
      && parsed.args.amount === BigInt(invoice.amount_raw)
      && parsed.args.token.toLowerCase() === USDT.toLowerCase());
  if (!event) fail(400, 'Escrow transaction does not match this invoice.');
  const transfer = receipt.logs
    .filter(log => log.address.toLowerCase() === USDT.toLowerCase())
    .map(log => { try { return TOKEN_INTERFACE.parseLog(log); } catch { return null; } })
    .find(parsed => parsed?.name === 'Transfer'
      && parsed.args.from.toLowerCase() === req.wallet.toLowerCase()
      && parsed.args.to.toLowerCase() === org.escrow_address.toLowerCase()
      && parsed.args.value === BigInt(invoice.amount_raw));
  if (!transfer) fail(400, 'Escrow funding receipt does not contain the matching USDT transfer.');
  await withTransaction(async () => {
    await run(
      "UPDATE invoices SET status = 'ESCROWED', escrow_id = ?, tx_hash = ? WHERE id = ? AND status = 'OPEN'",
      [event.args.escrowId.toString(), receipt.hash, invoice.id]
    );
    await run(
      `INSERT OR IGNORE INTO transactions
       (org_serial, tx_hash, wallet_from, wallet_to, kind, asset, amount_raw, status, block_number, timestamp, memo)
       VALUES (?, ?, ?, ?, 'Escrow Funded', 'USDT', ?, 'CONFIRMED', ?, ?, ?)`,
      [serial, receipt.hash, req.wallet, invoice.supplier_wallet, invoice.amount_raw, receipt.blockNumber,
        new Date((await provider.getBlock(receipt.blockNumber)).timestamp * 1000).toISOString(), `Invoice ${invoice.invoice_number}`]
    );
  });
  res.json({ success: true, escrow_id: event.args.escrowId.toString(), tx_hash: receipt.hash });
}));

async function updateInvoiceEscrow(req, res, eventName, nextStatus) {
  const serial = requireOrgSerial(req.params.serial);
  const org = await orgBySerial(serial);
  await requireRole(req.wallet, serial, ['owner']);
  if (!org.escrow_address) fail(400, 'Company escrow contract is not configured.');
  const invoice = await get('SELECT * FROM invoices WHERE id = ? AND org_serial = ?', [Number(req.params.id), serial]);
  if (!invoice || invoice.status !== 'ESCROWED') fail(404, 'Funded invoice not found.');
  const receipt = await provider.getTransactionReceipt(requireText(req.body.txHash, 'Transaction hash', 66));
  if (!receipt || receipt.status !== 1) fail(400, 'Escrow action is not confirmed.');
  const tx = await provider.getTransaction(receipt.hash);
  if (tx.from.toLowerCase() !== req.wallet.toLowerCase() || tx.to?.toLowerCase() !== org.escrow_address.toLowerCase()) {
    fail(403, 'Escrow action does not match the company wallet and contract.');
  }
  const event = receipt.logs
    .filter(log => log.address.toLowerCase() === org.escrow_address.toLowerCase())
    .map(log => { try { return ESCROW_INTERFACE.parseLog(log); } catch { return null; } })
    .find(parsed => parsed?.name === eventName
      && parsed.args.escrowId.toString() === invoice.escrow_id
      && parsed.args.amount === BigInt(invoice.amount_raw));
  if (!event) fail(400, `Confirmed transaction does not contain ${eventName}.`);
  const recipient = nextStatus === 'PAID' ? invoice.supplier_wallet : req.wallet;
  const transfer = receipt.logs
    .filter(log => log.address.toLowerCase() === USDT.toLowerCase())
    .map(log => { try { return TOKEN_INTERFACE.parseLog(log); } catch { return null; } })
    .find(parsed => parsed?.name === 'Transfer'
      && parsed.args.from.toLowerCase() === org.escrow_address.toLowerCase()
      && parsed.args.to.toLowerCase() === recipient.toLowerCase()
      && parsed.args.value === BigInt(invoice.amount_raw));
  if (!transfer) fail(400, 'Escrow receipt does not contain the matching USDT transfer.');
  await withTransaction(async () => {
    await run('UPDATE invoices SET status = ?, tx_hash = ? WHERE id = ?', [nextStatus, receipt.hash, invoice.id]);
    await run(
      `INSERT OR IGNORE INTO transactions
       (org_serial, tx_hash, wallet_from, wallet_to, kind, asset, amount_raw, status, block_number, timestamp, memo)
       VALUES (?, ?, ?, ?, ?, 'USDT', ?, 'CONFIRMED', ?, ?, ?)`,
      [serial, receipt.hash, req.wallet,
        recipient,
        nextStatus === 'PAID' ? 'Escrow Released' : 'Escrow Refunded',
        invoice.amount_raw, receipt.blockNumber,
        new Date((await provider.getBlock(receipt.blockNumber)).timestamp * 1000).toISOString(),
        `Invoice ${invoice.invoice_number}`]
    );
  });
  res.json({ success: true, status: nextStatus, tx_hash: receipt.hash });
}

app.post('/api/org/:serial/invoices/:id/release', asyncRoute((req, res) => updateInvoiceEscrow(req, res, 'EscrowReleased', 'PAID')));
app.post('/api/org/:serial/invoices/:id/refund', asyncRoute((req, res) => updateInvoiceEscrow(req, res, 'EscrowRefunded', 'REFUNDED')));

app.post('/api/org/:serial/dao/:id/confirm', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  const org = await orgBySerial(serial);
  await requireRole(req.wallet, serial, ['owner']);
  if (!org.dao_address) fail(400, 'Company DAO is not configured.');
  let proposalId;
  try { proposalId = BigInt(req.params.id); } catch { fail(400, 'Proposal ID must be an integer.'); }
  if (proposalId <= 0n) fail(400, 'Proposal ID must be positive.');
  const receipt = await provider.getTransactionReceipt(requireText(req.body.txHash, 'Transaction hash', 66));
  if (!receipt || receipt.status !== 1) fail(400, 'DAO execution is not confirmed.');
  const tx = await provider.getTransaction(receipt.hash);
  if (tx.from.toLowerCase() !== req.wallet.toLowerCase() || tx.to?.toLowerCase() !== org.dao_address.toLowerCase()) {
    fail(403, 'DAO execution does not match the connected wallet and company DAO.');
  }
  const event = receipt.logs
    .filter(log => log.address.toLowerCase() === org.dao_address.toLowerCase())
    .map(log => { try { return DAO_INTERFACE.parseLog(log); } catch { return null; } })
    .find(parsed => parsed?.name === 'ProposalExecuted' && parsed.args.proposalId === proposalId);
  if (!event) fail(400, 'DAO receipt does not contain the expected proposal execution event.');
  const proposal = await new ethers.Contract(org.dao_address, compileContracts().CompanyDAO.abi, provider).proposals(proposalId);
  if (!proposal.executed || proposal.token.toLowerCase() !== USDT.toLowerCase()) fail(400, 'Executed proposal is not a configured USDT treasury payment.');
  const transfer = receipt.logs
    .filter(log => log.address.toLowerCase() === USDT.toLowerCase())
    .map(log => { try { return TOKEN_INTERFACE.parseLog(log); } catch { return null; } })
    .find(parsed => parsed?.name === 'Transfer'
      && parsed.args.from.toLowerCase() === org.dao_address.toLowerCase()
      && parsed.args.to.toLowerCase() === proposal.recipient.toLowerCase()
      && parsed.args.value === proposal.amount);
  if (!transfer) fail(400, 'DAO receipt does not contain the matching USDT transfer.');
  const block = await provider.getBlock(receipt.blockNumber);
  await run(
    `INSERT OR IGNORE INTO transactions
     (org_serial, tx_hash, wallet_from, wallet_to, kind, asset, amount_raw, status, block_number, timestamp, memo)
     VALUES (?, ?, ?, ?, 'DAO Treasury Disbursement', 'USDT', ?, 'CONFIRMED', ?, ?, ?)`,
    [serial, receipt.hash, org.dao_address, proposal.recipient, proposal.amount.toString(),
      receipt.blockNumber, new Date(block.timestamp * 1000).toISOString(), `DAO proposal ${proposalId.toString()}`]
  );
  res.json({ success: true, tx_hash: receipt.hash, amount_raw: proposal.amount.toString() });
}));

let contractArtifacts;
function compileContracts() {
  if (contractArtifacts) return contractArtifacts;
  const sources = {};
  for (const filename of ['CompanyDAO.sol', 'CompanyEscrow.sol']) {
    sources[filename] = { content: fs.readFileSync(path.join(__dirname, 'contracts', filename), 'utf8') };
  }
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      evmVersion: 'paris',
      optimizer: { enabled: true, runs: 300 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(error => error.severity === 'error');
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  contractArtifacts = {};
  for (const [file, contracts] of Object.entries(output.contracts || {})) {
    for (const [name, contract] of Object.entries(contracts)) {
      if (['CompanyDAO', 'CompanyEscrow'].includes(name)) {
        contractArtifacts[name] = { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
      }
    }
  }
  return contractArtifacts;
}

app.get('/api/contracts', asyncRoute(async (_req, res) => {
  res.json(compileContracts());
}));

app.get('/api/org/:serial/treasury', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const dao = await get('SELECT dao_address FROM organizations WHERE serial = ?', [serial]);
  if (!dao?.dao_address) return res.json({ dao: null });
  const artifact = compileContracts().CompanyDAO;
  const contract = new ethers.Contract(dao.dao_address, artifact.abi, provider);
  const [quorum, delay, count] = await Promise.all([contract.quorumPercent(), contract.timelockSeconds(), contract.proposalCount()]);
  res.json({ dao: dao.dao_address, quorum: Number(quorum), timelockSeconds: Number(delay), proposalCount: Number(count) });
}));

app.get('/api/org/:serial/escrow', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const org = await get('SELECT escrow_address FROM organizations WHERE serial = ?', [serial]);
  res.json({ escrow: org?.escrow_address || null });
}));

async function initializeDatabase() {
  await run('PRAGMA foreign_keys = ON');
  const statements = [
    `CREATE TABLE IF NOT EXISTS organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serial TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      owner_wallet TEXT NOT NULL,
      dao_address TEXT,
      escrow_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_wallet)
    )`,
    `CREATE TABLE IF NOT EXISTS company_settings (
      org_serial TEXT PRIMARY KEY REFERENCES organizations(serial) ON DELETE CASCADE,
      employee_payment_privacy_level TEXT NOT NULL DEFAULT 'PUBLIC'
        CHECK (employee_payment_privacy_level IN ('PUBLIC','SHIELDED','ZK_PRIVATE')),
      supplier_payment_privacy_level TEXT NOT NULL DEFAULT 'PUBLIC'
        CHECK (supplier_payment_privacy_level IN ('PUBLIC','SHIELDED','ZK_PRIVATE')),
      dao_transaction_privacy_level TEXT NOT NULL DEFAULT 'PUBLIC'
        CHECK (dao_transaction_privacy_level IN ('PUBLIC','SHIELDED','ZK_PRIVATE')),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_serial TEXT NOT NULL REFERENCES organizations(serial) ON DELETE CASCADE,
      name TEXT NOT NULL,
      wallet TEXT NOT NULL,
      title TEXT NOT NULL,
      salary_raw TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_serial, wallet)
    )`,
    `CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_serial TEXT NOT NULL REFERENCES organizations(serial) ON DELETE CASCADE,
      name TEXT NOT NULL,
      contact_email TEXT NOT NULL DEFAULT '',
      wallet TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_serial, wallet)
    )`,
    `CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_serial TEXT NOT NULL REFERENCES organizations(serial) ON DELETE CASCADE,
      supplier_wallet TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      amount_raw TEXT NOT NULL,
      due_date TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      escrow_id TEXT,
      tx_hash TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_serial, invoice_number)
    )`,
    `CREATE TABLE IF NOT EXISTS join_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_serial TEXT NOT NULL REFERENCES organizations(serial) ON DELETE CASCADE,
      wallet TEXT NOT NULL,
      requested_role TEXT NOT NULL CHECK (requested_role IN ('employee','supplier')),
      name TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      salary_raw TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_serial TEXT NOT NULL REFERENCES organizations(serial) ON DELETE CASCADE,
      tx_hash TEXT NOT NULL UNIQUE,
      wallet_from TEXT NOT NULL,
      wallet_to TEXT NOT NULL,
      kind TEXT NOT NULL,
      asset TEXT NOT NULL DEFAULT 'USDT',
      amount_raw TEXT NOT NULL,
      status TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      memo TEXT NOT NULL DEFAULT ''
    )`,
    'CREATE INDEX IF NOT EXISTS idx_employees_wallet ON employees(wallet)',
    'CREATE INDEX IF NOT EXISTS idx_vendors_wallet ON vendors(wallet)',
    'CREATE INDEX IF NOT EXISTS idx_invoices_supplier ON invoices(supplier_wallet)',
    'CREATE INDEX IF NOT EXISTS idx_join_requests_org_status ON join_requests(org_serial, status)',
    'CREATE INDEX IF NOT EXISTS idx_transactions_wallets ON transactions(wallet_from, wallet_to)'
  ];
  for (const statement of statements) await run(statement);
}

app.use((error, _req, res, _next) => {
  console.error('API request failed:', error.message);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Internal server error.' });
});

initializeDatabase().then(() => {
  compileContracts();
  app.listen(PORT, () => console.log(`Terminull server ready on ${PORT}; chain ${CHAIN_ID}.`));
}).catch(error => {
  console.error('Failed to initialize Terminull:', error);
  process.exitCode = 1;
});
