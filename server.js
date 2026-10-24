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
  'event ProposalExecuted(uint256 indexed proposalId)',
  'event ProjectBudgetSet(bytes32 indexed projectId, uint256 amount)',
  'event ProjectProposalCreated(uint256 indexed proposalId, bytes32 indexed projectId, address recipient, uint256 amount, uint256 voterCount)'
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

function requireNonnegativeTokenAmount(value, label = 'Amount') {
  if (value === undefined || value === null || value === '') return '0';
  if (typeof value !== 'string' && typeof value !== 'number') fail(400, `${label} must be a decimal amount.`);
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text)) fail(400, `${label} must be a non-negative amount with at most 18 decimals.`);
  try { return ethers.parseUnits(text, 18).toString(); } catch { fail(400, `${label} is invalid.`); }
}

function requireOrgSerial(value) {
  return requireText(value, 'Company serial', 80);
}

function requirePrivacyLevel(value, label) {
  const allowed = ['PUBLIC', 'SHIELDED', 'ZK_PRIVATE'];
  if (!allowed.includes(value)) fail(400, `${label} must be PUBLIC, SHIELDED, or ZK_PRIVATE.`);
  return value;
}

const COMPANY_SCOPES = ['profile', 'employees', 'suppliers', 'invoices', 'reports', 'settings', 'projects', 'clients', 'accounting'];
const ACCESS_LEVELS = { NONE:0, VIEW:1, MANAGE:2 };

function optionalText(value, label, max = 200) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > max) {
    fail(400, `${label} must be at most ${max} characters.`);
  }
  return value.trim();
}

function optionalEmail(value, label) {
  const email = optionalText(value, label, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, `${label} must be a valid email address.`);
  return email;
}

function optionalWebsite(value, label) {
  const website = optionalText(value, label, 500);
  if (!website) return '';
  let parsed;
  try { parsed = new URL(website); } catch { fail(400, `${label} must be a valid http(s) URL.`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail(400, `${label} must be a valid http(s) URL.`);
  return parsed.toString();
}

function optionalDate(value, label) {
  const date = optionalText(value, label, 10);
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) {
    fail(400, `${label} must use YYYY-MM-DD.`);
  }
  return date;
}

function cleanCompanyProfile(body = {}) {
  return {
    legal_name: optionalText(body.legal_name, 'Legal company name'),
    trading_name: optionalText(body.trading_name, 'Trading name'),
    registration_number: optionalText(body.registration_number, 'Registration number', 100),
    registration_jurisdiction: optionalText(body.registration_jurisdiction, 'Registration jurisdiction', 120),
    tax_id: optionalText(body.tax_id, 'Tax ID', 120),
    vat_id: optionalText(body.vat_id, 'VAT ID', 120),
    employee_size: optionalText(body.employee_size, 'Employee size', 80),
    industry: optionalText(body.industry, 'Industry', 120),
    website: optionalWebsite(body.website, 'Website'),
    email: optionalEmail(body.email, 'Company email'),
    phone: optionalText(body.phone, 'Company phone', 80),
    registered_address: optionalText(body.registered_address, 'Registered address', 1000),
    mailing_address: optionalText(body.mailing_address, 'Mailing address', 1000)
  };
}

function cleanEmployee(row) {
  return {
    name: requireText(row.name, 'Employee name'),
    wallet: requireWallet(row.wallet),
    title: row.title ? requireText(row.title, 'Title', 100) : 'Employee',
    salaryRaw: row.salary === undefined || row.salary === '' ? '' : requireTokenAmount(String(row.salary), 'Salary'),
    department: optionalText(row.department, 'Department', 120),
    workEmail: optionalEmail(row.work_email, 'Employee email'),
    workPhone: optionalText(row.work_phone, 'Employee phone', 80),
    employmentType: optionalText(row.employment_type, 'Employment type', 80),
    startDate: optionalDate(row.start_date, 'Employment start date'),
    location: optionalText(row.location, 'Employee location', 200),
    reportsToWallet: row.reports_to_wallet ? requireWallet(row.reports_to_wallet, 'Reports-to wallet') : ''
  };
}

function cleanSupplier(row) {
  return {
    name: requireText(row.name, 'Supplier name'),
    wallet: requireWallet(row.wallet),
    email: optionalEmail(row.email, 'Supplier email'),
    legalName: optionalText(row.legal_name, 'Supplier legal name'),
    registrationNumber: optionalText(row.registration_number, 'Supplier registration number', 100),
    taxId: optionalText(row.tax_id, 'Supplier tax ID', 120),
    vatId: optionalText(row.vat_id, 'Supplier VAT ID', 120),
    website: optionalWebsite(row.website, 'Supplier website'),
    phone: optionalText(row.phone, 'Supplier phone', 80),
    billingAddress: optionalText(row.billing_address, 'Supplier billing address', 1000),
    paymentTerms: optionalText(row.payment_terms, 'Supplier payment terms', 200)
  };
}

function cleanPermissions(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Executive permissions must be an object.');
  const result = {};
  for (const scope of COMPANY_SCOPES) {
    const level = scope === 'invoices' || scope === 'reports'
      ? (value[scope] === 'VIEW' ? 'VIEW' : 'NONE')
      : (value[scope] || 'NONE');
    if (!Object.hasOwn(ACCESS_LEVELS, level)) fail(400, `Invalid ${scope} access level.`);
    result[scope] = level;
  }
  return result;
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
  const executive = await get(
    "SELECT id FROM executive_access WHERE org_serial = ? AND lower(wallet) = ? AND status = 'ACTIVE'",
    [serial, lower]
  );
  if (executive) roles.push('executive');
  return roles;
}

async function companyPermissions(wallet, serial) {
  const org = await get('SELECT owner_wallet FROM organizations WHERE serial = ?', [serial]);
  if (!org) return null;
  if (org.owner_wallet.toLowerCase() === wallet.toLowerCase()) {
    return Object.fromEntries(COMPANY_SCOPES.map(scope => [scope,
      scope === 'invoices' || scope === 'reports' ? 'VIEW' : 'MANAGE'
    ]));
  }
  const access = await get(
    "SELECT permissions_json FROM executive_access WHERE org_serial = ? AND lower(wallet) = ? AND status = 'ACTIVE'",
    [serial, wallet.toLowerCase()]
  );
  if (!access) return null;
  try { return cleanPermissions(JSON.parse(access.permissions_json)); } catch (error) {
    console.error('Invalid executive permissions stored:', error.message);
    return Object.fromEntries(COMPANY_SCOPES.map(scope => [scope, 'NONE']));
  }
}

async function requirePermission(wallet, serial, scope, level = 'VIEW') {
  if (!COMPANY_SCOPES.includes(scope) || !Object.hasOwn(ACCESS_LEVELS, level)) {
    throw new Error('Invalid internal permission check.');
  }
  const permissions = await companyPermissions(wallet, serial);
  if (!permissions || ACCESS_LEVELS[permissions[scope]] < ACCESS_LEVELS[level]) {
    fail(403, `Your connected wallet does not have ${level.toLowerCase()} access to ${scope}.`);
  }
  return permissions;
}

async function requireRole(wallet, serial, allowed) {
  const roles = await rolesFor(wallet, serial);
  if (!roles.some(role => allowed.includes(role))) fail(403, 'Your connected wallet does not have permission for this company action.');
  return roles;
}

async function validateReportsTo(serial, wallet, reportsToWallet, additionalWallets = []) {
  if (!reportsToWallet) return;
  const lower = reportsToWallet.toLowerCase();
  if (lower === wallet.toLowerCase()) fail(400, 'An employee cannot report to their own wallet.');
  const org = await get('SELECT owner_wallet FROM organizations WHERE serial = ?', [serial]);
  const executives = await all(
    "SELECT lower(wallet) AS wallet FROM executive_access WHERE org_serial = ? AND status = 'ACTIVE'",
    [serial]
  );
  const employees = await all(
    'SELECT lower(e.wallet) AS wallet, lower(COALESCE(p.reports_to_wallet, \'\')) AS reports_to_wallet FROM employees e LEFT JOIN employee_profiles p ON p.employee_id = e.id WHERE e.org_serial = ? AND e.status = \'ACTIVE\'',
    [serial]
  );
  const employeeWallets = new Set(employees.map(row => row.wallet));
  for (const additionalWallet of additionalWallets) employeeWallets.add(additionalWallet.toLowerCase());
  const allowed = lower === org.owner_wallet.toLowerCase()
    || executives.some(item => item.wallet === lower)
    || employeeWallets.has(lower);
  if (!allowed) fail(400, 'Reports-to wallet must belong to the company owner, an accepted executive, or an active employee.');

  const managers = new Map(employees.map(row => [row.wallet, row.reports_to_wallet]));
  const seen = new Set();
  let cursor = lower;
  while (cursor && employeeWallets.has(cursor)) {
    if (cursor === wallet.toLowerCase() || seen.has(cursor)) fail(400, 'Reporting lines cannot contain a cycle.');
    seen.add(cursor);
    cursor = managers.get(cursor) || '';
  }
}

async function saveEmployeeProfile(employeeId, employee) {
  await run(
    `INSERT INTO employee_profiles
     (employee_id, department, work_email, work_phone, employment_type, start_date, location, reports_to_wallet, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(employee_id) DO UPDATE SET department=excluded.department, work_email=excluded.work_email,
      work_phone=excluded.work_phone, employment_type=excluded.employment_type, start_date=excluded.start_date,
      location=excluded.location, reports_to_wallet=excluded.reports_to_wallet, updated_at=CURRENT_TIMESTAMP`,
    [employeeId, employee.department, employee.workEmail, employee.workPhone, employee.employmentType,
      employee.startDate, employee.location, employee.reportsToWallet]
  );
}

async function saveSupplierProfile(vendorId, supplier) {
  await run(
    `INSERT INTO supplier_profiles
     (vendor_id, legal_name, registration_number, tax_id, vat_id, website, phone, billing_address, payment_terms, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(vendor_id) DO UPDATE SET legal_name=excluded.legal_name,
      registration_number=excluded.registration_number, tax_id=excluded.tax_id, vat_id=excluded.vat_id,
      website=excluded.website, phone=excluded.phone, billing_address=excluded.billing_address,
      payment_terms=excluded.payment_terms, updated_at=CURRENT_TIMESTAMP`,
    [vendorId, supplier.legalName, supplier.registrationNumber, supplier.taxId, supplier.vatId,
      supplier.website, supplier.phone, supplier.billingAddress, supplier.paymentTerms]
  );
}

async function getSession(wallet) {
  const companies = await all(
    `SELECT serial, name, dao_address, escrow_address FROM organizations WHERE lower(owner_wallet) = ?
     UNION
     SELECT o.serial, o.name, o.dao_address, o.escrow_address
     FROM organizations o JOIN executive_access x ON x.org_serial = o.serial
     WHERE lower(x.wallet) = ? AND x.status = 'ACTIVE'
     ORDER BY name`,
    [wallet.toLowerCase(), wallet.toLowerCase()]
  );
  const executiveRows = await all(
    `SELECT x.org_serial AS serial, o.name AS company_name, x.office, x.permissions_json
     FROM executive_access x JOIN organizations o ON o.serial = x.org_serial
     WHERE lower(x.wallet) = ? AND x.status = 'ACTIVE' ORDER BY o.name`,
    [wallet.toLowerCase()]
  );
  const executiveInvitations = await all(
    `SELECT x.id, x.org_serial AS serial, o.name AS company_name, x.name, x.office, x.email
     FROM executive_access x JOIN organizations o ON o.serial = x.org_serial
     WHERE lower(x.wallet) = ? AND x.status = 'PENDING' ORDER BY x.created_at`,
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
  return { wallet, companies, executiveRows, executiveInvitations, employeeRows, supplierRows, invoiceRows };
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
  const employee = requestedRole === 'employee' ? cleanEmployee({ ...req.body, name, wallet:req.wallet }) : null;
  const supplier = requestedRole === 'supplier' ? cleanSupplier({ ...req.body, name, wallet:req.wallet }) : null;
  if (employee) await validateReportsTo(serial, employee.wallet, employee.reportsToWallet);
  const pending = await get(
    `SELECT id FROM join_requests WHERE org_serial = ? AND lower(wallet) = ? AND requested_role = ? AND status = 'PENDING'`,
    [serial, req.wallet.toLowerCase(), requestedRole]
  );
  if (pending) fail(409, 'A pending request for this company and role already exists.');
  const result = await run(
    `INSERT INTO join_requests (org_serial, wallet, requested_role, name, title, salary_raw, contact_email, profile_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [serial, req.wallet, requestedRole, name, employee?.title || '', employee?.salaryRaw || '',
      supplier?.email || '', JSON.stringify(employee || supplier)]
  );
  res.status(201).json({ success: true, requestId: result.lastID });
}));

app.get('/api/org/:serial/join-requests', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  const permissions = await companyPermissions(req.wallet, serial);
  if (!permissions || (permissions.employees !== 'MANAGE' && permissions.suppliers !== 'MANAGE')) {
    fail(403, 'Your connected wallet cannot manage company membership requests.');
  }
  const roles = permissions.employees === 'MANAGE' && permissions.suppliers === 'MANAGE'
    ? ''
    : permissions.employees === 'MANAGE' ? " AND requested_role = 'employee'" : " AND requested_role = 'supplier'";
  res.json(await all(
    `SELECT id, wallet, requested_role, name, title, salary_raw, contact_email, profile_json, status, created_at
     FROM join_requests WHERE org_serial = ? AND status = 'PENDING'${roles} ORDER BY created_at, id`,
    [serial]
  ));
}));

app.post('/api/org/:serial/join-requests/:id/approve', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await withTransaction(async () => {
    const request = await get(
      `SELECT * FROM join_requests WHERE id = ? AND org_serial = ? AND status = 'PENDING'`,
      [Number(req.params.id), serial]
    );
    if (!request) fail(404, 'Pending join request not found.');
    await requirePermission(req.wallet, serial, request.requested_role === 'employee' ? 'employees' : 'suppliers', 'MANAGE');
    const profile = JSON.parse(request.profile_json || '{}');
    if (request.requested_role === 'employee') {
      await run(
        'INSERT INTO employees (org_serial, name, wallet, title, salary_raw) VALUES (?, ?, ?, ?, ?)',
        [serial, request.name, request.wallet, request.title, request.salary_raw]
      );
      const employeeId = (await get('SELECT id FROM employees WHERE org_serial = ? AND lower(wallet) = ?', [serial, request.wallet.toLowerCase()])).id;
      await saveEmployeeProfile(employeeId, profile);
    } else {
      await run(
        'INSERT INTO vendors (org_serial, name, contact_email, wallet) VALUES (?, ?, ?, ?)',
        [serial, request.name, request.contact_email, request.wallet]
      );
      const vendorId = (await get('SELECT id FROM vendors WHERE org_serial = ? AND lower(wallet) = ?', [serial, request.wallet.toLowerCase()])).id;
      await saveSupplierProfile(vendorId, profile);
    }
    await run("UPDATE join_requests SET status = 'APPROVED' WHERE id = ?", [request.id]);
  });
  res.json({ success: true });
}));

app.post('/api/org/:serial/join-requests/:id/reject', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  const request = await get(
    "SELECT requested_role FROM join_requests WHERE id = ? AND org_serial = ? AND status = 'PENDING'",
    [Number(req.params.id), serial]
  );
  if (!request) fail(404, 'Pending join request not found.');
  await requirePermission(req.wallet, serial, request.requested_role === 'employee' ? 'employees' : 'suppliers', 'MANAGE');
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
  const profile = cleanCompanyProfile(req.body);
  await run(
    'INSERT INTO organizations (serial, name, owner_wallet) VALUES (?, ?, ?)',
    [serial, name, req.wallet]
  );
  await run(
    `INSERT INTO company_profiles
     (org_serial, legal_name, trading_name, registration_number, registration_jurisdiction,
      tax_id, vat_id, employee_size, industry, website, email, phone, registered_address, mailing_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [serial, profile.legal_name, profile.trading_name, profile.registration_number,
      profile.registration_jurisdiction, profile.tax_id, profile.vat_id, profile.employee_size,
      profile.industry, profile.website, profile.email, profile.phone, profile.registered_address, profile.mailing_address]
  );
  res.status(201).json({ success: true, company: { serial, name, owner_wallet: req.wallet, dao_address: null, escrow_address: null } });
}));

app.get('/api/org/:serial', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  const roles = await requireRole(req.wallet, serial, ['owner', 'employee', 'supplier', 'executive']);
  const org = await orgBySerial(serial);
  res.json({ ...org, roles, permissions:await companyPermissions(req.wallet, serial) });
}));

app.get('/api/org/:serial/profile', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'profile', 'VIEW');
  const profile = await get('SELECT * FROM company_profiles WHERE org_serial = ?', [serial]);
  const locations = await all('SELECT * FROM company_locations WHERE org_serial = ? ORDER BY id', [serial]);
  res.json({ profile:profile || cleanCompanyProfile(), locations });
}));

app.put('/api/org/:serial/profile', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'profile', 'MANAGE');
  const profile = cleanCompanyProfile(req.body);
  let locations;
  if (req.body.locations !== undefined) {
    if (!Array.isArray(req.body.locations) || req.body.locations.length > 100) fail(400, 'Locations must be an array with no more than 100 entries.');
    locations = req.body.locations.map((location, index) => ({
      name:requireText(location.name, `Location ${index + 1} name`, 160),
      type:optionalText(location.location_type, 'Location type', 80) || 'OFFICE',
      address:optionalText(location.address, 'Location address', 500),
      city:optionalText(location.city, 'Location city', 120),
      region:optionalText(location.region, 'Location region', 120),
      country:optionalText(location.country, 'Location country', 120),
      postalCode:optionalText(location.postal_code, 'Location postal code', 40),
      phone:optionalText(location.phone, 'Location phone', 80),
      email:optionalEmail(location.email, 'Location email')
    }));
  }
  await withTransaction(async () => {
    await run(
      `INSERT INTO company_profiles
       (org_serial, legal_name, trading_name, registration_number, registration_jurisdiction,
        tax_id, vat_id, employee_size, industry, website, email, phone, registered_address, mailing_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_serial) DO UPDATE SET
        legal_name=excluded.legal_name, trading_name=excluded.trading_name,
        registration_number=excluded.registration_number, registration_jurisdiction=excluded.registration_jurisdiction,
        tax_id=excluded.tax_id, vat_id=excluded.vat_id, employee_size=excluded.employee_size,
        industry=excluded.industry, website=excluded.website, email=excluded.email,
        phone=excluded.phone, registered_address=excluded.registered_address,
        mailing_address=excluded.mailing_address, updated_at=CURRENT_TIMESTAMP`,
      [serial, profile.legal_name, profile.trading_name, profile.registration_number,
        profile.registration_jurisdiction, profile.tax_id, profile.vat_id, profile.employee_size,
        profile.industry, profile.website, profile.email, profile.phone, profile.registered_address, profile.mailing_address]
    );
    if (locations) {
      await run('DELETE FROM company_locations WHERE org_serial = ?', [serial]);
      for (const location of locations) {
        await run(
          `INSERT INTO company_locations
           (org_serial, name, location_type, address, city, region, country, postal_code, phone, email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [serial, location.name, location.type, location.address, location.city, location.region,
            location.country, location.postalCode, location.phone, location.email]
        );
      }
    }
  });
  res.json({ success:true });
}));

app.get('/api/org/:serial/executives', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const rows = await all(
    `SELECT id, wallet, name, office, email, permissions_json, status, created_at, accepted_at
     FROM executive_access WHERE org_serial = ? ORDER BY created_at, id`,
    [serial]
  );
  res.json(rows.map(row => ({ ...row, permissions:cleanPermissions(JSON.parse(row.permissions_json)) })));
}));

app.post('/api/org/:serial/executives', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const wallet = requireWallet(req.body.wallet);
  if (wallet.toLowerCase() === req.wallet.toLowerCase()) fail(400, 'The company owner already has full access.');
  const name = requireText(req.body.name, 'Executive name');
  const office = requireText(req.body.office, 'Executive office', 120);
  const email = optionalEmail(req.body.email, 'Executive email');
  const permissions = cleanPermissions(req.body.permissions);
  const result = await run(
    `INSERT INTO executive_access (org_serial, wallet, name, office, email, permissions_json, nominated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [serial, wallet, name, office, email, JSON.stringify(permissions), req.wallet]
  );
  res.status(201).json({ id:result.lastID, wallet, name, office, email, permissions, status:'PENDING' });
}));

app.put('/api/org/:serial/executives/:id/permissions', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const permissions = cleanPermissions(req.body.permissions);
  const result = await run(
    "UPDATE executive_access SET permissions_json = ? WHERE id = ? AND org_serial = ? AND status != 'REVOKED'",
    [JSON.stringify(permissions), Number(req.params.id), serial]
  );
  if (!result.changes) fail(404, 'Executive nomination not found.');
  res.json({ success:true, permissions });
}));

app.post('/api/org/:serial/executives/:id/accept', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  const result = await run(
    `UPDATE executive_access SET status = 'ACTIVE', accepted_at = CURRENT_TIMESTAMP
     WHERE id = ? AND org_serial = ? AND lower(wallet) = ? AND status = 'PENDING'`,
    [Number(req.params.id), serial, req.wallet.toLowerCase()]
  );
  if (!result.changes) fail(404, 'Pending executive invitation for this connected wallet was not found.');
  res.json({ success:true });
}));

app.post('/api/org/:serial/executives/:id/revoke', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const result = await run(
    "UPDATE executive_access SET status = 'REVOKED' WHERE id = ? AND org_serial = ? AND status != 'REVOKED'",
    [Number(req.params.id), serial]
  );
  if (!result.changes) fail(404, 'Executive access was not found or is already revoked.');
  res.json({ success:true });
}));

app.get('/api/org/:serial/settings', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'settings', 'VIEW');
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
  await requirePermission(req.wallet, serial, 'settings', 'MANAGE');
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
  const roles = await rolesFor(req.wallet, serial);
  const canViewRoster = roles.includes('owner') || roles.includes('executive');
  if (roles.includes('executive')) await requirePermission(req.wallet, serial, 'employees', 'VIEW');
  if (!canViewRoster && !roles.includes('employee')) fail(403, 'Your connected wallet does not have permission to view company employees.');
  const sql = `SELECT e.id, e.name, e.wallet, e.title, e.salary_raw, e.status, e.created_at,
      COALESCE(p.department, '') AS department, COALESCE(p.work_email, '') AS work_email,
      COALESCE(p.work_phone, '') AS work_phone, COALESCE(p.employment_type, '') AS employment_type,
      COALESCE(p.start_date, '') AS start_date, COALESCE(p.location, '') AS location,
      COALESCE(p.reports_to_wallet, '') AS reports_to_wallet
    FROM employees e LEFT JOIN employee_profiles p ON p.employee_id = e.id
    WHERE e.org_serial = ? ${canViewRoster ? '' : 'AND lower(e.wallet) = ?'} ORDER BY e.name`;
  res.json(await all(sql, canViewRoster ? [serial] : [serial, req.wallet.toLowerCase()]));
}));

app.post('/api/org/:serial/employees', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await orgBySerial(serial);
  await requirePermission(req.wallet, serial, 'employees', 'MANAGE');
  const employee = cleanEmployee(req.body);
  await validateReportsTo(serial, employee.wallet, employee.reportsToWallet);
  const result = await run(
    'INSERT INTO employees (org_serial, name, wallet, title, salary_raw) VALUES (?, ?, ?, ?, ?)',
    [serial, employee.name, employee.wallet, employee.title, employee.salaryRaw]
  );
  await saveEmployeeProfile(result.lastID, employee);
  res.status(201).json({ id: result.lastID, ...employee, salary_raw: employee.salaryRaw, status: 'ACTIVE' });
}));

app.post('/api/org/:serial/bulk/:kind', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await orgBySerial(serial);
  const rows = req.body.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000) fail(400, 'Upload must contain between 1 and 1000 rows.');
  if (!['employees', 'suppliers'].includes(req.params.kind)) fail(404, 'Unknown import type.');
  const scope = req.params.kind === 'employees' ? 'employees' : 'suppliers';
  await requirePermission(req.wallet, serial, scope, 'MANAGE');

  const prepared = rows.map((row, index) => {
    try {
      if (req.params.kind === 'employees') return { ...cleanEmployee(row), index: index + 1 };
      return { ...cleanSupplier(row), index:index + 1 };
    } catch (error) {
      error.message = `Row ${index + 2}: ${error.message}`;
      throw error;
    }
  });
  const addresses = prepared.map(item => item.wallet.toLowerCase());
  if (new Set(addresses).size !== addresses.length) fail(400, 'Upload contains duplicate wallet addresses.');
  if (req.params.kind === 'employees') {
    const [org, existingEmployees, executives] = await Promise.all([
      get('SELECT owner_wallet FROM organizations WHERE serial = ?', [serial]),
      all('SELECT lower(e.wallet) AS wallet, lower(COALESCE(p.reports_to_wallet, \'\')) AS reports_to_wallet FROM employees e LEFT JOIN employee_profiles p ON p.employee_id = e.id WHERE e.org_serial = ? AND e.status = \'ACTIVE\'', [serial]),
      all("SELECT lower(wallet) AS wallet FROM executive_access WHERE org_serial = ? AND status = 'ACTIVE'", [serial])
    ]);
    const employeeWallets = new Set([...existingEmployees.map(row => row.wallet), ...addresses]);
    const managerMap = new Map(existingEmployees.map(row => [row.wallet, row.reports_to_wallet]));
    for (const item of prepared) managerMap.set(item.wallet.toLowerCase(), item.reportsToWallet.toLowerCase());
    const allowedManagers = new Set([
      org.owner_wallet.toLowerCase(),
      ...executives.map(row => row.wallet),
      ...employeeWallets
    ]);
    for (const item of prepared) {
      let cursor = item.reportsToWallet.toLowerCase();
      if (!cursor) continue;
      if (!allowedManagers.has(cursor) || cursor === item.wallet.toLowerCase()) fail(400, `Row ${item.index + 1}: reports-to wallet must be an active company member and cannot be the employee's own wallet.`);
      const visited = new Set();
      while (cursor && employeeWallets.has(cursor)) {
        if (cursor === item.wallet.toLowerCase() || visited.has(cursor)) fail(400, `Row ${item.index + 1}: reporting lines cannot contain a cycle.`);
        visited.add(cursor);
        cursor = managerMap.get(cursor) || '';
      }
    }
  }

  await withTransaction(async () => {
    for (const item of prepared) {
      if (req.params.kind === 'employees') {
        const result = await run(
          'INSERT INTO employees (org_serial, name, wallet, title, salary_raw) VALUES (?, ?, ?, ?, ?)',
          [serial, item.name, item.wallet, item.title, item.salaryRaw]
        );
        await saveEmployeeProfile(result.lastID, item);
      } else {
        const result = await run(
          'INSERT INTO vendors (org_serial, name, contact_email, wallet) VALUES (?, ?, ?, ?)',
          [serial, item.name, item.email, item.wallet]
        );
        await saveSupplierProfile(result.lastID, item);
      }
    }
  });
  res.status(201).json({ success: true, imported: prepared.length });
}));

app.get('/api/org/:serial/suppliers', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  const roles = await rolesFor(req.wallet, serial);
  if (!roles.includes('owner') && !roles.includes('supplier') && !roles.includes('executive')) {
    fail(403, 'Your connected wallet does not have permission to view company suppliers.');
  }
  if (roles.includes('executive')) await requirePermission(req.wallet, serial, 'suppliers', 'VIEW');
  const permissions = await companyPermissions(req.wallet, serial);
  const canViewRoster = roles.includes('owner') || permissions?.suppliers === 'VIEW' || permissions?.suppliers === 'MANAGE';
  const sql = `SELECT v.id, v.name, v.contact_email, v.wallet, v.status, v.created_at,
      COALESCE(p.legal_name, '') AS legal_name, COALESCE(p.registration_number, '') AS registration_number,
      COALESCE(p.tax_id, '') AS tax_id, COALESCE(p.vat_id, '') AS vat_id,
      COALESCE(p.website, '') AS website, COALESCE(p.phone, '') AS phone,
      COALESCE(p.billing_address, '') AS billing_address, COALESCE(p.payment_terms, '') AS payment_terms
    FROM vendors v LEFT JOIN supplier_profiles p ON p.vendor_id = v.id
    WHERE v.org_serial = ? ${canViewRoster ? '' : 'AND lower(v.wallet) = ?'} ORDER BY v.name`;
  res.json(await all(sql, canViewRoster ? [serial] : [serial, req.wallet.toLowerCase()]));
}));

app.post('/api/org/:serial/suppliers', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await orgBySerial(serial);
  await requirePermission(req.wallet, serial, 'suppliers', 'MANAGE');
  const supplier = cleanSupplier(req.body);
  const result = await run(
    'INSERT INTO vendors (org_serial, name, contact_email, wallet) VALUES (?, ?, ?, ?)',
    [serial, supplier.name, supplier.email, supplier.wallet]
  );
  await saveSupplierProfile(result.lastID, supplier);
  res.status(201).json({ id:result.lastID, ...supplier, contact_email:supplier.email, status:'ACTIVE' });
}));

app.put('/api/org/:serial/employees/:id', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'employees', 'MANAGE');
  const current = await get(
    `SELECT e.*, p.department, p.work_email, p.work_phone, p.employment_type, p.start_date, p.location, p.reports_to_wallet
     FROM employees e LEFT JOIN employee_profiles p ON p.employee_id = e.id
     WHERE e.id = ? AND e.org_serial = ?`,
    [Number(req.params.id), serial]
  );
  if (!current) fail(404, 'Employee record not found.');
  const employee = cleanEmployee({
    ...current,
    ...req.body,
    name:req.body.name ?? current.name,
    wallet:current.wallet,
    salary:req.body.salary ?? (current.salary_raw ? ethers.formatUnits(BigInt(current.salary_raw), 18) : '')
  });
  await validateReportsTo(serial, employee.wallet, employee.reportsToWallet);
  await run(
    'UPDATE employees SET name = ?, title = ?, salary_raw = ? WHERE id = ? AND org_serial = ?',
    [employee.name, employee.title, employee.salaryRaw, current.id, serial]
  );
  await saveEmployeeProfile(current.id, employee);
  res.json({ success:true });
}));

app.put('/api/org/:serial/suppliers/:id', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'suppliers', 'MANAGE');
  const current = await get(
    `SELECT v.*, p.legal_name, p.registration_number, p.tax_id, p.vat_id, p.website, p.phone, p.billing_address, p.payment_terms
     FROM vendors v LEFT JOIN supplier_profiles p ON p.vendor_id = v.id
     WHERE v.id = ? AND v.org_serial = ?`,
    [Number(req.params.id), serial]
  );
  if (!current) fail(404, 'Supplier record not found.');
  const supplier = cleanSupplier({
    ...current,
    ...req.body,
    name:req.body.name ?? current.name,
    wallet:current.wallet,
    email:req.body.email ?? current.contact_email,
    legal_name:req.body.legal_name ?? current.legal_name,
    registration_number:req.body.registration_number ?? current.registration_number,
    tax_id:req.body.tax_id ?? current.tax_id,
    vat_id:req.body.vat_id ?? current.vat_id,
    website:req.body.website ?? current.website,
    phone:req.body.phone ?? current.phone,
    billing_address:req.body.billing_address ?? current.billing_address,
    payment_terms:req.body.payment_terms ?? current.payment_terms
  });
  await run(
    'UPDATE vendors SET name = ?, contact_email = ? WHERE id = ? AND org_serial = ?',
    [supplier.name, supplier.email, current.id, serial]
  );
  await saveSupplierProfile(current.id, supplier);
  res.json({ success:true });
}));

app.get('/api/org/:serial/organogram', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'employees', 'VIEW');
  const [org, executives, employees] = await Promise.all([
    get('SELECT owner_wallet FROM organizations WHERE serial = ?', [serial]),
    all("SELECT wallet, name, office AS title, email, 'executive' AS type FROM executive_access WHERE org_serial = ? AND status = 'ACTIVE' ORDER BY name", [serial]),
    all(
      `SELECT e.wallet, e.name, e.title, p.department, p.work_email AS email,
              p.reports_to_wallet, p.location, p.employment_type, p.start_date, 'employee' AS type
       FROM employees e LEFT JOIN employee_profiles p ON p.employee_id = e.id
       WHERE e.org_serial = ? AND e.status = 'ACTIVE' ORDER BY e.name`,
      [serial]
    )
  ]);
  res.json({
    ownerWallet:org.owner_wallet,
    executives,
    employees:employees.map(employee => ({ ...employee, reports_to_wallet:employee.reports_to_wallet || org.owner_wallet }))
  });
}));

async function projectForOrg(serial, projectId) {
  const project = await get('SELECT * FROM projects WHERE id = ? AND org_serial = ?', [Number(projectId), serial]);
  if (!project) fail(404, 'Project not found.');
  return project;
}

async function companyMemberWallets(serial) {
  const [org, employees, executives] = await Promise.all([
    get('SELECT owner_wallet FROM organizations WHERE serial = ?', [serial]),
    all("SELECT wallet FROM employees WHERE org_serial = ? AND status = 'ACTIVE'", [serial]),
    all("SELECT wallet FROM executive_access WHERE org_serial = ? AND status = 'ACTIVE'", [serial])
  ]);
  return new Set([org.owner_wallet.toLowerCase(), ...employees.map(row => row.wallet.toLowerCase()), ...executives.map(row => row.wallet.toLowerCase())]);
}

app.get('/api/org/:serial/projects', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'projects', 'VIEW');
  const projects = await all('SELECT * FROM projects WHERE org_serial = ? ORDER BY created_at DESC, id DESC', [serial]);
  const rows = await Promise.all(projects.map(async project => {
    const teams = await all('SELECT * FROM project_teams WHERE project_id = ? ORDER BY id', [project.id]);
    for (const team of teams) {
      team.members = await all('SELECT wallet, role FROM project_team_members WHERE team_id = ? ORDER BY wallet', [team.id]);
    }
    const tasks = await all('SELECT * FROM project_tasks WHERE project_id = ? ORDER BY due_date, id', [project.id]);
    const releases = await all('SELECT * FROM project_releases WHERE project_id = ? ORDER BY created_at DESC, id DESC', [project.id]);
    return { ...project, teams, tasks, releases };
  }));
  res.json(rows);
}));

app.post('/api/org/:serial/projects', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'projects', 'MANAGE');
  const name = requireText(req.body.name, 'Project name', 200);
  const description = optionalText(req.body.description, 'Project description', 2000);
  const budgetRaw = requireNonnegativeTokenAmount(req.body.budget, 'Project budget');
  const targetStart = optionalDate(req.body.target_start, 'Project start date');
  const targetEnd = optionalDate(req.body.target_end, 'Project target end date');
  if (targetStart && targetEnd && targetEnd < targetStart) fail(400, 'Project target end date cannot be before its start date.');
  const result = await run(
    `INSERT INTO projects (org_serial, name, description, budget_raw, target_start, target_end, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [serial, name, description, budgetRaw, targetStart, targetEnd, req.wallet]
  );
  res.status(201).json({ id:result.lastID, name, description, budget_raw:budgetRaw, dao_budget_synced:0 });
}));

app.put('/api/org/:serial/projects/:id', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'projects', 'MANAGE');
  const project = await projectForOrg(serial, req.params.id);
  const name = requireText(req.body.name ?? project.name, 'Project name', 200);
  const description = optionalText(req.body.description ?? project.description, 'Project description', 2000);
  const status = req.body.status ?? project.status;
  if (!['PLANNED','ACTIVE','ON_HOLD','COMPLETED','CANCELLED'].includes(status)) fail(400, 'Invalid project status.');
  const budgetRaw = req.body.budget === undefined ? project.budget_raw : requireNonnegativeTokenAmount(req.body.budget, 'Project budget');
  const targetStart = req.body.target_start === undefined ? project.target_start : optionalDate(req.body.target_start, 'Project start date');
  const targetEnd = req.body.target_end === undefined ? project.target_end : optionalDate(req.body.target_end, 'Project target end date');
  if (targetStart && targetEnd && targetEnd < targetStart) fail(400, 'Project target end date cannot be before its start date.');
  await run(
    `UPDATE projects SET name = ?, description = ?, status = ?, budget_raw = ?, target_start = ?, target_end = ?,
     dao_budget_synced = CASE WHEN budget_raw != ? THEN 0 ELSE dao_budget_synced END, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND org_serial = ?`,
    [name, description, status, budgetRaw, targetStart, targetEnd, budgetRaw, project.id, serial]
  );
  res.json({ success:true, budget_raw:budgetRaw, budgetSynced:budgetRaw === project.budget_raw ? Boolean(project.dao_budget_synced) : false });
}));

app.post('/api/org/:serial/projects/:id/budget/confirm', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const project = await projectForOrg(serial, req.params.id);
  const org = await orgBySerial(serial);
  if (!org.dao_address) fail(400, 'Deploy the company DAO before syncing a project budget.');
  const receipt = await provider.getTransactionReceipt(requireText(req.body.txHash, 'Budget transaction hash', 66));
  const tx = await provider.getTransaction(receipt?.hash || '');
  if (!receipt || receipt.status !== 1 || !tx || tx.from.toLowerCase() !== req.wallet.toLowerCase() || tx.to?.toLowerCase() !== org.dao_address.toLowerCase()) {
    fail(400, 'Budget transaction is not a confirmed transaction from the company owner to the DAO.');
  }
  const dao = new ethers.Contract(org.dao_address, compileContracts().CompanyDAO.abi, provider);
  const projectId = ethers.id(String(project.id));
  if ((await dao.projectBudgets(projectId)).toString() !== project.budget_raw) fail(400, 'On-chain DAO project budget does not match the project record.');
  const budgetEvent = receipt.logs
    .filter(log => log.address.toLowerCase() === org.dao_address.toLowerCase())
    .map(log => { try { return DAO_INTERFACE.parseLog(log); } catch { return null; } })
    .find(parsed => parsed?.name === 'ProjectBudgetSet'
      && parsed.args.projectId === projectId
      && parsed.args.amount.toString() === project.budget_raw);
  if (!budgetEvent) fail(400, 'Budget transaction is missing the matching DAO budget event.');
  await run('UPDATE projects SET dao_budget_synced = 1 WHERE id = ? AND org_serial = ?', [project.id, serial]);
  res.json({ success:true, dao_budget_synced:true });
}));

app.post('/api/org/:serial/projects/:id/teams', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'projects', 'MANAGE');
  const project = await projectForOrg(serial, req.params.id);
  const name = requireText(req.body.name, 'Team name', 160);
  const description = optionalText(req.body.description, 'Team description', 1000);
  const members = req.body.members === undefined ? [] : req.body.members;
  if (!Array.isArray(members) || members.length > 100) fail(400, 'Team members must be an array with no more than 100 entries.');
  const wallets = members.map((member, index) => ({
    wallet:requireWallet(member.wallet, `Team member ${index + 1} wallet`),
    role:optionalText(member.role, 'Team role', 120)
  }));
  const unique = new Set(wallets.map(member => member.wallet.toLowerCase()));
  if (unique.size !== wallets.length) fail(400, 'Team contains duplicate wallet addresses.');
  const companyWallets = await companyMemberWallets(serial);
  if (wallets.some(member => !companyWallets.has(member.wallet.toLowerCase()))) fail(400, 'Every project team member must be an active company owner, employee, or accepted executive.');
  const result = await run('INSERT INTO project_teams (project_id, name, description) VALUES (?, ?, ?)', [project.id, name, description]);
  await withTransaction(async () => {
    for (const member of wallets) {
      await run('INSERT INTO project_team_members (team_id, wallet, role) VALUES (?, ?, ?)', [result.lastID, member.wallet, member.role]);
    }
  });
  res.status(201).json({ id:result.lastID, project_id:project.id, name, description, members:wallets });
}));

app.put('/api/org/:serial/projects/:id/teams/:teamId', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'projects', 'MANAGE');
  const project = await projectForOrg(serial, req.params.id);
  const team = await get('SELECT * FROM project_teams WHERE id = ? AND project_id = ?', [Number(req.params.teamId), project.id]);
  if (!team) fail(404, 'Project team not found.');
  const name = requireText(req.body.name ?? team.name, 'Team name', 160);
  const description = optionalText(req.body.description ?? team.description, 'Team description', 1000);
  const members = req.body.members === undefined ? await all('SELECT wallet, role FROM project_team_members WHERE team_id = ?', [team.id]) : req.body.members;
  if (!Array.isArray(members) || members.length > 100) fail(400, 'Team members must be an array with no more than 100 entries.');
  const wallets = members.map((member, index) => ({
    wallet:requireWallet(member.wallet, `Team member ${index + 1} wallet`),
    role:optionalText(member.role, 'Team role', 120)
  }));
  if (new Set(wallets.map(member => member.wallet.toLowerCase())).size !== wallets.length) fail(400, 'Team contains duplicate wallet addresses.');
  const companyWallets = await companyMemberWallets(serial);
  if (wallets.some(member => !companyWallets.has(member.wallet.toLowerCase()))) fail(400, 'Every project team member must be an active company owner, employee, or accepted executive.');
  await withTransaction(async () => {
    await run('UPDATE project_teams SET name = ?, description = ? WHERE id = ?', [name, description, team.id]);
    await run('DELETE FROM project_team_members WHERE team_id = ?', [team.id]);
    for (const member of wallets) await run('INSERT INTO project_team_members (team_id, wallet, role) VALUES (?, ?, ?)', [team.id, member.wallet, member.role]);
  });
  res.json({ success:true });
}));

app.post('/api/org/:serial/projects/:id/tasks', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'projects', 'MANAGE');
  const project = await projectForOrg(serial, req.params.id);
  const title = requireText(req.body.title, 'Task title', 200);
  const description = optionalText(req.body.description, 'Task description', 2000);
  const dueDate = optionalDate(req.body.due_date, 'Task due date');
  const assignee = req.body.assigned_wallet ? requireWallet(req.body.assigned_wallet, 'Assignee wallet') : '';
  const teamId = req.body.team_id ? Number(req.body.team_id) : null;
  if (teamId && !await get('SELECT id FROM project_teams WHERE id = ? AND project_id = ?', [teamId, project.id])) fail(400, 'Task team does not belong to this project.');
  if (assignee && !(await companyMemberWallets(serial)).has(assignee.toLowerCase())) fail(400, 'Assignee must be an active company owner, employee, or accepted executive.');
  if (teamId && assignee && !await get('SELECT wallet FROM project_team_members WHERE team_id = ? AND lower(wallet) = ?', [teamId, assignee.toLowerCase()])) {
    fail(400, 'Task assignee must be a member of the selected team.');
  }
  const result = await run(
    `INSERT INTO project_tasks (project_id, team_id, title, description, due_date, assigned_wallet, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [project.id, teamId, title, description, dueDate, assignee, req.wallet]
  );
  res.status(201).json({ id:result.lastID, project_id:project.id, title, status:'TODO', assigned_wallet:assignee });
}));

app.put('/api/org/:serial/projects/:id/tasks/:taskId', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'projects', 'MANAGE');
  const project = await projectForOrg(serial, req.params.id);
  const task = await get('SELECT * FROM project_tasks WHERE id = ? AND project_id = ?', [Number(req.params.taskId), project.id]);
  if (!task) fail(404, 'Project task not found.');
  const title = requireText(req.body.title ?? task.title, 'Task title', 200);
  const description = optionalText(req.body.description ?? task.description, 'Task description', 2000);
  const status = req.body.status ?? task.status;
  const priority = req.body.priority ?? task.priority;
  if (!['TODO','IN_PROGRESS','BLOCKED','DONE'].includes(status)) fail(400, 'Invalid task status.');
  if (!['LOW','NORMAL','HIGH','URGENT'].includes(priority)) fail(400, 'Invalid task priority.');
  const dueDate = req.body.due_date === undefined ? task.due_date : optionalDate(req.body.due_date, 'Task due date');
  const assignee = req.body.assigned_wallet === undefined ? task.assigned_wallet : (req.body.assigned_wallet ? requireWallet(req.body.assigned_wallet, 'Assignee wallet') : '');
  const teamId = req.body.team_id === undefined ? task.team_id : (req.body.team_id ? Number(req.body.team_id) : null);
  if (teamId && !await get('SELECT id FROM project_teams WHERE id = ? AND project_id = ?', [teamId, project.id])) fail(400, 'Task team does not belong to this project.');
  if (assignee && !(await companyMemberWallets(serial)).has(assignee.toLowerCase())) fail(400, 'Assignee must be an active company owner, employee, or accepted executive.');
  if (teamId && assignee && !await get('SELECT wallet FROM project_team_members WHERE team_id = ? AND lower(wallet) = ?', [teamId, assignee.toLowerCase()])) {
    fail(400, 'Task assignee must be a member of the selected team.');
  }
  await run(
    `UPDATE project_tasks SET title = ?, description = ?, status = ?, priority = ?, due_date = ?,
     assigned_wallet = ?, team_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [title, description, status, priority, dueDate, assignee, teamId, task.id]
  );
  res.json({ success:true });
}));

app.post('/api/org/:serial/projects/:id/releases', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const project = await projectForOrg(serial, req.params.id);
  if (!project.dao_budget_synced) fail(400, 'Sync this project budget to the DAO before proposing a payout.');
  const org = await orgBySerial(serial);
  if (!org.dao_address) fail(400, 'Company DAO is not deployed.');
  const teamId = Number(req.body.team_id);
  const team = await get('SELECT id FROM project_teams WHERE id = ? AND project_id = ?', [teamId, project.id]);
  if (!team) fail(400, 'Select a team assigned to this project.');
  const teamMembers = await all('SELECT lower(wallet) AS wallet FROM project_team_members WHERE team_id = ? ORDER BY lower(wallet)', [teamId]);
  if (!teamMembers.length) fail(400, 'Project release voting requires at least one team member.');
  const proposalId = String(req.body.proposal_id || '');
  if (!/^[1-9]\d{0,77}$/.test(proposalId)) fail(400, 'Invalid DAO proposal ID.');
  const receipt = await provider.getTransactionReceipt(requireText(req.body.txHash, 'Proposal transaction hash', 66));
  const tx = await provider.getTransaction(receipt?.hash || '');
  if (!receipt || receipt.status !== 1 || !tx || tx.from.toLowerCase() !== req.wallet.toLowerCase() || tx.to?.toLowerCase() !== org.dao_address.toLowerCase()) {
    fail(400, 'Project proposal is not a confirmed DAO transaction from the company owner.');
  }
  const dao = new ethers.Contract(org.dao_address, compileContracts().CompanyDAO.abi, provider);
  const [projectId, isProjectProposal, proposal, voterCount] = await Promise.all([
    dao.proposalProjectIds(proposalId),
    dao.isProjectProposal(proposalId),
    dao.proposals(proposalId),
    dao.proposalVoterCount(proposalId)
  ]);
  if (!isProjectProposal || projectId !== ethers.id(String(project.id))) fail(400, 'DAO proposal is not linked to this project.');
  if (proposal.token.toLowerCase() !== USDT.toLowerCase()) fail(400, 'Project payouts must use configured USDT.');
  if (voterCount !== BigInt(teamMembers.length)) fail(400, 'On-chain voting electorate does not match the selected project team.');
  for (const member of teamMembers) {
    if (!await dao.proposalVoters(proposalId, member.wallet)) fail(400, 'On-chain voting electorate does not match the selected project team.');
  }
  const event = receipt.logs
    .filter(log => log.address.toLowerCase() === org.dao_address.toLowerCase())
    .map(log => { try { return DAO_INTERFACE.parseLog(log); } catch { return null; } })
    .find(parsed => parsed?.name === 'ProjectProposalCreated' && parsed.args.proposalId.toString() === proposalId);
  if (!event || event.args.projectId !== projectId) fail(400, 'DAO receipt is missing the matching project proposal event.');
  const result = await run(
    `INSERT INTO project_releases (project_id, team_id, proposal_id, recipient_wallet, amount_raw, voters_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [project.id, teamId, proposalId, proposal.recipient, proposal.amount.toString(),
      JSON.stringify(teamMembers.map(member => member.wallet)), req.wallet]
  );
  res.status(201).json({ id:result.lastID, proposal_id:proposalId, amount_raw:proposal.amount.toString(), recipient_wallet:proposal.recipient });
}));

app.post('/api/org/:serial/projects/:id/releases/:proposalId/confirm', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner', 'employee', 'executive']);
  const project = await projectForOrg(serial, req.params.id);
  const release = await get('SELECT * FROM project_releases WHERE project_id = ? AND proposal_id = ?', [project.id, String(req.params.proposalId)]);
  if (!release) fail(404, 'Project release proposal not found.');
  const org = await orgBySerial(serial);
  const receipt = await provider.getTransactionReceipt(requireText(req.body.txHash, 'Execution transaction hash', 66));
  const tx = await provider.getTransaction(receipt?.hash || '');
  if (!receipt || receipt.status !== 1 || !tx || tx.from.toLowerCase() !== req.wallet.toLowerCase() || tx.to?.toLowerCase() !== org.dao_address.toLowerCase()) {
    fail(400, 'Project payout is not a confirmed execution transaction from the connected wallet.');
  }
  const dao = new ethers.Contract(org.dao_address, compileContracts().CompanyDAO.abi, provider);
  const [proposal, projectId, cancelled] = await Promise.all([
    dao.proposals(req.params.proposalId),
    dao.proposalProjectIds(req.params.proposalId),
    dao.proposalCancelled(req.params.proposalId)
  ]);
  if (cancelled || !proposal.executed || projectId !== ethers.id(String(project.id))
      || proposal.token.toLowerCase() !== USDT.toLowerCase()
      || proposal.recipient.toLowerCase() !== release.recipient_wallet.toLowerCase()
      || proposal.amount.toString() !== release.amount_raw) {
    fail(400, 'DAO execution does not match the recorded project release.');
  }
  const transfer = receipt.logs
    .filter(log => log.address.toLowerCase() === USDT.toLowerCase())
    .map(log => { try { return TOKEN_INTERFACE.parseLog(log); } catch { return null; } })
    .find(parsed => parsed?.name === 'Transfer'
      && parsed.args.from.toLowerCase() === org.dao_address.toLowerCase()
      && parsed.args.to.toLowerCase() === release.recipient_wallet.toLowerCase()
      && parsed.args.value === BigInt(release.amount_raw));
  if (!transfer) fail(400, 'DAO execution does not contain the matching project USDT transfer.');
  const block = await provider.getBlock(receipt.blockNumber);
  await withTransaction(async () => {
    await run("UPDATE project_releases SET status = 'EXECUTED', tx_hash = ?, executed_at = CURRENT_TIMESTAMP WHERE id = ?", [receipt.hash, release.id]);
    await run(
      `INSERT OR IGNORE INTO transactions
       (org_serial, tx_hash, wallet_from, wallet_to, kind, asset, amount_raw, status, block_number, timestamp, memo)
       VALUES (?, ?, ?, ?, 'Project budget release', 'USDT', ?, 'CONFIRMED', ?, ?, ?)`,
      [serial, receipt.hash, org.dao_address, release.recipient_wallet, release.amount_raw,
        receipt.blockNumber, new Date(Number(block.timestamp) * 1000).toISOString(), `Project ${project.name}; proposal ${release.proposal_id}`]
    );
  });
  res.json({ success:true, tx_hash:receipt.hash, status:'EXECUTED' });
}));

app.get('/api/my/projects', asyncRoute(async (req, res) => {
  const projects = await all(
    `SELECT DISTINCT p.*, o.name AS company_name
     FROM projects p JOIN organizations o ON o.serial = p.org_serial
     LEFT JOIN project_tasks t ON t.project_id = p.id
     LEFT JOIN project_teams pt ON pt.project_id = p.id
     LEFT JOIN project_team_members tm ON tm.team_id = pt.id
     WHERE lower(t.assigned_wallet) = ? OR lower(tm.wallet) = ?
     ORDER BY p.updated_at DESC, p.id DESC`,
    [req.wallet.toLowerCase(), req.wallet.toLowerCase()]
  );
  const result = await Promise.all(projects.map(async project => ({
    ...project,
    tasks:await all(
      `SELECT t.* FROM project_tasks t
       LEFT JOIN project_team_members tm ON tm.team_id = t.team_id
       WHERE t.project_id = ? AND (lower(t.assigned_wallet) = ? OR lower(tm.wallet) = ?)
       ORDER BY t.due_date, t.id`,
      [project.id, req.wallet.toLowerCase(), req.wallet.toLowerCase()]
    ),
    releases:await all('SELECT * FROM project_releases WHERE project_id = ? ORDER BY created_at DESC, id DESC', [project.id])
  })));
  res.json(result);
}));

app.put('/api/my/projects/:id/tasks/:taskId', asyncRoute(async (req, res) => {
  const task = await get(
    `SELECT t.*, p.org_serial FROM project_tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.id = ? AND p.id = ?`,
    [Number(req.params.taskId), Number(req.params.id)]
  );
  if (!task) fail(404, 'Project task not found.');
  const roles = await rolesFor(req.wallet, task.org_serial);
  const mayManage = roles.includes('owner')
    || (await companyPermissions(req.wallet, task.org_serial))?.projects === 'MANAGE';
  const assigned = task.assigned_wallet.toLowerCase() === req.wallet.toLowerCase()
    || Boolean(await get('SELECT wallet FROM project_team_members WHERE team_id = ? AND lower(wallet) = ?', [task.team_id, req.wallet.toLowerCase()]));
  if (!mayManage && !assigned) fail(403, 'Only the assigned team or project managers can update this task.');
  const status = req.body.status ?? task.status;
  if (!['TODO','IN_PROGRESS','BLOCKED','DONE'].includes(status)) fail(400, 'Invalid task status.');
  await run('UPDATE project_tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, task.id]);
  res.json({ success:true, status });
}));

app.get('/api/org/:serial/clients', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'clients', 'VIEW');
  res.json(await all('SELECT * FROM clients WHERE org_serial = ? ORDER BY updated_at DESC, id DESC', [serial]));
}));

app.post('/api/org/:serial/clients', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'clients', 'MANAGE');
  const name = requireText(req.body.name, 'Client contact name', 200);
  const company = optionalText(req.body.company_name, 'Client company', 200);
  const email = optionalEmail(req.body.email, 'Client email');
  const phone = optionalText(req.body.phone, 'Client phone', 80);
  const website = optionalWebsite(req.body.website, 'Client website');
  const industry = optionalText(req.body.industry, 'Client industry', 120);
  const status = req.body.status || 'LEAD';
  if (!['LEAD','QUALIFIED','PROPOSAL','NEGOTIATION','WON','LOST'].includes(status)) fail(400, 'Invalid client pipeline status.');
  const estimatedValue = requireNonnegativeTokenAmount(req.body.estimated_value, 'Estimated opportunity value');
  const expectedClose = optionalDate(req.body.expected_close, 'Expected close date');
  const nextAction = optionalText(req.body.next_action, 'Next action', 500);
  const notes = optionalText(req.body.notes, 'Client notes', 2000);
  const result = await run(
    `INSERT INTO clients (org_serial, name, company_name, email, phone, website, industry, status,
     estimated_value_raw, expected_close, next_action, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [serial, name, company, email, phone, website, industry, status, estimatedValue, expectedClose, nextAction, notes, req.wallet]
  );
  res.status(201).json({ id:result.lastID, name, company_name:company, status, estimated_value_raw:estimatedValue });
}));

app.put('/api/org/:serial/clients/:id', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'clients', 'MANAGE');
  const client = await get('SELECT * FROM clients WHERE id = ? AND org_serial = ?', [Number(req.params.id), serial]);
  if (!client) fail(404, 'Client opportunity not found.');
  const input = {
    ...client,
    ...req.body,
    name:req.body.name ?? client.name,
    company_name:req.body.company_name ?? client.company_name,
    estimated_value:req.body.estimated_value ?? ethers.formatUnits(BigInt(client.estimated_value_raw), 18),
    expected_close:req.body.expected_close ?? client.expected_close
  };
  const status = input.status;
  if (!['LEAD','QUALIFIED','PROPOSAL','NEGOTIATION','WON','LOST'].includes(status)) fail(400, 'Invalid client pipeline status.');
  const values = [
    requireText(input.name, 'Client contact name', 200),
    optionalText(input.company_name, 'Client company', 200),
    optionalEmail(input.email, 'Client email'),
    optionalText(input.phone, 'Client phone', 80),
    optionalWebsite(input.website, 'Client website'),
    optionalText(input.industry, 'Client industry', 120),
    status,
    requireNonnegativeTokenAmount(input.estimated_value, 'Estimated opportunity value'),
    optionalDate(input.expected_close, 'Expected close date'),
    optionalText(input.next_action, 'Next action', 500),
    optionalText(input.notes, 'Client notes', 2000)
  ];
  await run(
    `UPDATE clients SET name=?, company_name=?, email=?, phone=?, website=?, industry=?, status=?,
     estimated_value_raw=?, expected_close=?, next_action=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [...values, client.id]
  );
  res.json({ success:true });
}));

app.get('/api/org/:serial/accounting', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'accounting', 'VIEW');
  const [org, targets, scan, logged] = await Promise.all([
    get('SELECT owner_wallet, dao_address, escrow_address FROM organizations WHERE serial = ?', [serial]),
    all('SELECT period, target_income_raw, target_outflow_raw, updated_at FROM financial_targets WHERE org_serial = ? ORDER BY period DESC', [serial]),
    get('SELECT start_block, last_scanned_block, updated_at FROM org_chain_scans WHERE org_serial = ?', [serial]),
    all('SELECT tx_hash, wallet_from, wallet_to, amount_raw, block_number, timestamp, kind AS source FROM transactions WHERE org_serial = ? AND status = \'CONFIRMED\' ORDER BY block_number DESC, id DESC LIMIT 5000', [serial])
  ]);
  const scanned = await all('SELECT tx_hash, log_index, wallet_from, wallet_to, amount_raw, block_number, timestamp, source FROM accounting_chain_transfers WHERE org_serial = ? ORDER BY block_number DESC, log_index DESC LIMIT 10000', [serial]);
  const indexedHashes = new Set(scanned.map(item => item.tx_hash.toLowerCase()));
  const transfers = [
    ...scanned,
    ...logged.filter(item => !indexedHashes.has(item.tx_hash.toLowerCase())).map(item => ({ ...item, log_index:null, source:'APP_CONFIRMED' }))
  ].sort((a, b) => Number(b.block_number) - Number(a.block_number));
  const treasuryWallets = new Set([org.owner_wallet, org.dao_address, org.escrow_address].filter(Boolean).map(address => address.toLowerCase()));
  const actuals = new Map();
  for (const transfer of transfers) {
    const from = transfer.wallet_from.toLowerCase();
    const to = transfer.wallet_to.toLowerCase();
    if (treasuryWallets.has(from) && treasuryWallets.has(to)) continue;
    const direction = treasuryWallets.has(to) ? 'income' : treasuryWallets.has(from) ? 'outflow' : '';
    if (!direction) continue;
    const date = new Date(transfer.timestamp).toISOString().slice(0, 7);
    const period = actuals.get(date) || { income_raw:'0', outflow_raw:'0' };
    period[`${direction}_raw`] = (BigInt(period[`${direction}_raw`]) + BigInt(transfer.amount_raw)).toString();
    actuals.set(date, period);
  }
  res.json({
    scan:scan || { start_block:null, last_scanned_block:null, updated_at:null },
    targets,
    actuals:[...actuals.entries()].map(([period, values]) => ({ period, ...values })).sort((a,b) => b.period.localeCompare(a.period)),
    transfers:transfers.slice(0, 1000)
  });
}));

app.put('/api/org/:serial/accounting/targets', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'accounting', 'MANAGE');
  const period = requireText(req.body.period, 'Accounting period', 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail(400, 'Accounting period must use YYYY-MM.');
  const income = requireNonnegativeTokenAmount(req.body.target_income, 'Target income');
  const outflow = requireNonnegativeTokenAmount(req.body.target_outflow, 'Target outflow');
  await run(
    `INSERT INTO financial_targets (org_serial, period, target_income_raw, target_outflow_raw, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(org_serial, period) DO UPDATE SET target_income_raw=excluded.target_income_raw,
       target_outflow_raw=excluded.target_outflow_raw, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`,
    [serial, period, income, outflow, req.wallet]
  );
  res.json({ success:true });
}));

app.post('/api/org/:serial/accounting/sync', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requireRole(req.wallet, serial, ['owner']);
  const org = await get('SELECT owner_wallet, dao_address, escrow_address FROM organizations WHERE serial = ?', [serial]);
  const state = await get('SELECT start_block, last_scanned_block FROM org_chain_scans WHERE org_serial = ?', [serial]);
  const latest = await provider.getBlockNumber();
  let startBlock = state?.last_scanned_block === null || state?.last_scanned_block === undefined
    ? Number(req.body.start_block)
    : Number(state.last_scanned_block) + 1;
  if (!Number.isSafeInteger(startBlock) || startBlock < 0 || startBlock > latest) fail(400, 'Choose a valid RPC history start block not above the current chain head.');
  if (state?.start_block !== null && state?.start_block !== undefined && req.body.start_block !== undefined) {
    fail(409, 'The history start block is already configured; sync resumes from the saved cursor.');
  }
  const maxBlocks = req.body.max_blocks === undefined ? 2000 : Number(req.body.max_blocks);
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > 5000) fail(400, 'Each accounting sync is limited to 1–5000 blocks.');
  const endBlock = Math.min(latest, startBlock + maxBlocks - 1);
  const addresses = [org.owner_wallet, org.dao_address, org.escrow_address].filter(Boolean).map(address => ethers.zeroPadValue(address, 32));
  const topic = TOKEN_INTERFACE.getEvent('Transfer').topicHash;
  const [outgoing, incoming] = await Promise.all([
    provider.getLogs({ address:USDT, fromBlock:startBlock, toBlock:endBlock, topics:[topic, addresses] }),
    provider.getLogs({ address:USDT, fromBlock:startBlock, toBlock:endBlock, topics:[topic, null, addresses] })
  ]);
  const logs = [...new Map([...outgoing, ...incoming].map(log => [`${log.transactionHash.toLowerCase()}:${log.index}`, log])).values()];
  for (const log of logs) {
    const parsed = TOKEN_INTERFACE.parseLog(log);
    const block = await provider.getBlock(log.blockNumber);
    await run(
      `INSERT OR IGNORE INTO accounting_chain_transfers
       (org_serial, tx_hash, log_index, wallet_from, wallet_to, amount_raw, block_number, timestamp, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RPC_INDEX')`,
      [serial, log.transactionHash, log.index, parsed.args.from, parsed.args.to, parsed.args.value.toString(),
        log.blockNumber, new Date(Number(block.timestamp) * 1000).toISOString()]
    );
  }
  await run(
    `INSERT INTO org_chain_scans (org_serial, start_block, last_scanned_block, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(org_serial) DO UPDATE SET
       start_block=COALESCE(org_chain_scans.start_block, excluded.start_block),
       last_scanned_block=excluded.last_scanned_block, updated_at=CURRENT_TIMESTAMP`,
    [serial, state?.start_block ?? startBlock, endBlock]
  );
  res.json({ success:true, fromBlock:startBlock, toBlock:endBlock, latestBlock:latest, indexed:logs.length, hasMore:endBlock < latest });
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
  await requirePermission(req.wallet, serial, 'invoices', 'VIEW');
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
  const roles = await rolesFor(req.wallet, serial);
  if (roles.includes('executive')) await requirePermission(req.wallet, serial, 'reports', 'VIEW');
  else if (!roles.some(role => ['owner', 'employee', 'supplier'].includes(role))) {
    fail(403, 'Your connected wallet does not have permission to view company activity.');
  }
  const fullAccess = roles.includes('owner') || roles.includes('executive');
  const sql = `SELECT tx_hash, wallet_from, wallet_to, kind, asset, amount_raw, status, block_number, timestamp, memo
    FROM transactions WHERE org_serial = ? ${fullAccess ? '' : 'AND (lower(wallet_from) = ? OR lower(wallet_to) = ?)'}
    ORDER BY block_number DESC, id DESC LIMIT 1000`;
  const params = fullAccess ? [serial] : [serial, req.wallet.toLowerCase(), req.wallet.toLowerCase()];
  res.json(await all(sql, params));
}));

app.get('/api/org/:serial/report', asyncRoute(async (req, res) => {
  const serial = requireOrgSerial(req.params.serial);
  await requirePermission(req.wallet, serial, 'reports', 'VIEW');
  const [transactions, invoices, employees, suppliers, companyProfile, locations, projects, clients] = await Promise.all([
    all('SELECT tx_hash, wallet_from, wallet_to, kind, asset, amount_raw, status, block_number, timestamp, memo FROM transactions WHERE org_serial = ? ORDER BY id DESC', [serial]),
    all('SELECT id, supplier_wallet, invoice_number, amount_raw, due_date, description, status, tx_hash FROM invoices WHERE org_serial = ? ORDER BY id DESC', [serial]),
    all(`SELECT e.name, e.wallet, e.title, e.salary_raw, e.status, p.department, p.work_email, p.work_phone,
                p.employment_type, p.start_date, p.location, p.reports_to_wallet
         FROM employees e LEFT JOIN employee_profiles p ON p.employee_id = e.id WHERE e.org_serial = ? ORDER BY e.name`, [serial]),
    all(`SELECT v.name, v.contact_email, v.wallet, v.status, p.legal_name, p.registration_number, p.tax_id, p.vat_id,
                p.website, p.phone, p.billing_address, p.payment_terms
         FROM vendors v LEFT JOIN supplier_profiles p ON p.vendor_id = v.id WHERE v.org_serial = ? ORDER BY v.name`, [serial]),
    get('SELECT * FROM company_profiles WHERE org_serial = ?', [serial]),
    all('SELECT name, location_type, address, city, region, country, postal_code, phone, email FROM company_locations WHERE org_serial = ? ORDER BY id', [serial]),
    all('SELECT id, name, description, status, budget_raw, target_start, target_end FROM projects WHERE org_serial = ? ORDER BY id', [serial]),
    all('SELECT name, company_name, email, phone, status, estimated_value_raw, expected_close, next_action FROM clients WHERE org_serial = ? ORDER BY id', [serial])
  ]);
  res.json({ transactions, invoices, employees, suppliers, companyProfile:companyProfile || cleanCompanyProfile(), locations, projects, clients });
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
    `CREATE TABLE IF NOT EXISTS company_profiles (
      org_serial TEXT PRIMARY KEY REFERENCES organizations(serial) ON DELETE CASCADE,
      legal_name TEXT NOT NULL DEFAULT '',
      trading_name TEXT NOT NULL DEFAULT '',
      registration_number TEXT NOT NULL DEFAULT '',
      registration_jurisdiction TEXT NOT NULL DEFAULT '',
      tax_id TEXT NOT NULL DEFAULT '',
      vat_id TEXT NOT NULL DEFAULT '',
      employee_size TEXT NOT NULL DEFAULT '',
      industry TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      registered_address TEXT NOT NULL DEFAULT '',
      mailing_address TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS company_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_serial TEXT NOT NULL REFERENCES organizations(serial) ON DELETE CASCADE,
      name TEXT NOT NULL,
      location_type TEXT NOT NULL DEFAULT 'OFFICE',
      address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      region TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT ''
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
    `CREATE TABLE IF NOT EXISTS employee_profiles (
      employee_id INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
      department TEXT NOT NULL DEFAULT '',
      work_email TEXT NOT NULL DEFAULT '',
      work_phone TEXT NOT NULL DEFAULT '',
      employment_type TEXT NOT NULL DEFAULT '',
      start_date TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      reports_to_wallet TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    `CREATE TABLE IF NOT EXISTS supplier_profiles (
      vendor_id INTEGER PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
      legal_name TEXT NOT NULL DEFAULT '',
      registration_number TEXT NOT NULL DEFAULT '',
      tax_id TEXT NOT NULL DEFAULT '',
      vat_id TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      billing_address TEXT NOT NULL DEFAULT '',
      payment_terms TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      profile_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS executive_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_serial TEXT NOT NULL REFERENCES organizations(serial) ON DELETE CASCADE,
      wallet TEXT NOT NULL,
      name TEXT NOT NULL,
      office TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      permissions_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','REVOKED')),
      nominated_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      accepted_at TEXT,
      UNIQUE(org_serial, wallet)
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_serial TEXT NOT NULL REFERENCES organizations(serial) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
      budget_raw TEXT NOT NULL DEFAULT '0',
      dao_budget_synced INTEGER NOT NULL DEFAULT 0,
      target_start TEXT NOT NULL DEFAULT '',
      target_end TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS project_teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS project_team_members (
      team_id INTEGER NOT NULL REFERENCES project_teams(id) ON DELETE CASCADE,
      wallet TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(team_id, wallet)
    )`,
    `CREATE TABLE IF NOT EXISTS project_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      team_id INTEGER REFERENCES project_teams(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO','IN_PROGRESS','BLOCKED','DONE')),
      priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
      due_date TEXT NOT NULL DEFAULT '',
      assigned_wallet TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS project_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES project_teams(id) ON DELETE RESTRICT,
      proposal_id TEXT NOT NULL,
      recipient_wallet TEXT NOT NULL,
      amount_raw TEXT NOT NULL,
      voters_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','EXECUTED','CANCELLED')),
      tx_hash TEXT UNIQUE,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      executed_at TEXT,
      UNIQUE(project_id, proposal_id)
    )`,
    `CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_serial TEXT NOT NULL REFERENCES organizations(serial) ON DELETE CASCADE,
      name TEXT NOT NULL,
      company_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '',
      industry TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'LEAD' CHECK (status IN ('LEAD','QUALIFIED','PROPOSAL','NEGOTIATION','WON','LOST')),
      estimated_value_raw TEXT NOT NULL DEFAULT '0',
      expected_close TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS financial_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      org_serial TEXT NOT NULL REFERENCES organizations(serial) ON DELETE CASCADE,
      period TEXT NOT NULL,
      target_income_raw TEXT NOT NULL DEFAULT '0',
      target_outflow_raw TEXT NOT NULL DEFAULT '0',
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_serial, period)
    )`,
    `CREATE TABLE IF NOT EXISTS org_chain_scans (
      org_serial TEXT PRIMARY KEY REFERENCES organizations(serial) ON DELETE CASCADE,
      start_block INTEGER,
      last_scanned_block INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS accounting_chain_transfers (
      org_serial TEXT NOT NULL REFERENCES organizations(serial) ON DELETE CASCADE,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      wallet_from TEXT NOT NULL,
      wallet_to TEXT NOT NULL,
      amount_raw TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'RPC_INDEX',
      PRIMARY KEY(org_serial, tx_hash, log_index)
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
    'CREATE INDEX IF NOT EXISTS idx_transactions_wallets ON transactions(wallet_from, wallet_to)',
    'CREATE INDEX IF NOT EXISTS idx_executive_wallet ON executive_access(wallet)',
    'CREATE INDEX IF NOT EXISTS idx_project_tasks_assignee ON project_tasks(assigned_wallet)'
  ];
  for (const statement of statements) await run(statement);
  const joinRequestColumns = await all('PRAGMA table_info(join_requests)');
  if (!joinRequestColumns.some(column => column.name === 'profile_json')) {
    await run("ALTER TABLE join_requests ADD COLUMN profile_json TEXT NOT NULL DEFAULT '{}'");
  }
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
