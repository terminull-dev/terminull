const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4001;
const db = new sqlite3.Database(path.join(__dirname, 'terminull.db'));

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/public', express.static(path.join(__dirname, 'public')));

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
  const previous = transactionQueue;
  let release;
  transactionQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    await run('BEGIN IMMEDIATE');
    const result = await work();
    await run('COMMIT');
    return result;
  } catch (err) {
    await run('ROLLBACK');
    throw err;
  } finally {
    release();
  }
}

function requireText(value, label, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    const err = new Error(`${label} is required and must be at most ${maxLength} characters.`);
    err.status = 400;
    throw err;
  }
  return value.trim();
}

function requireAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('Amount must be a positive number.');
    err.status = 400;
    throw err;
  }
  return amount;
}

function requireEvmAddress(value, label) {
  const address = requireText(value, label, 42);
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    const err = new Error(`${label} must be a 42-character EVM address.`);
    err.status = 400;
    throw err;
  }
  return address;
}

const ASSETS = {
  USDC: { account: 'USDC Escrow Vault', initialBalance: 35000 },
  USDT: { account: 'USDT Treasury Vault', initialBalance: 20000 },
  LUN: { account: 'LUN Gas Reserve', initialBalance: 1250 },
  USD: { account: 'Fiat Gateway Clearing', initialBalance: 0 }
};

async function ensureOrganization(serial) {
  const org = await get('SELECT * FROM organizations WHERE serial = ?', [serial]);
  if (!org) {
    const err = new Error('Organization not found.');
    err.status = 404;
    throw err;
  }
  for (const [asset, details] of Object.entries(ASSETS)) {
    const initialBalance = asset === 'USDC' ? org.balance_usdc : asset === 'USDT' ? org.balance_usdt : details.initialBalance;
    await run(
      `INSERT OR IGNORE INTO accounts (org_serial, asset, account_name, balance)
       VALUES (?, ?, ?, ?)`,
      [serial, asset, details.account, initialBalance]
    );
  }
  await run(`INSERT OR IGNORE INTO boltons (org_serial, module_key, module_name, is_active)
    VALUES (?, 'multisig', 'Multi-Sig Quorum', 1)`, [serial]);
  await run(`INSERT OR IGNORE INTO boltons (org_serial, module_key, module_name, is_active)
    VALUES (?, 'tax', 'Statutory Tax Autocalc', 1)`, [serial]);
  await run(`INSERT OR IGNORE INTO boltons (org_serial, module_key, module_name, is_active)
    VALUES (?, 'geth', 'Geth RPC Validator Hook', 1)`, [serial]);
  return org;
}

async function recordTransaction({ orgSerial, txType, amount, asset, status = 'COMPLETED', source = null, destination = null, memo = null }) {
  const txHash = `0x${crypto.randomBytes(32).toString('hex')}`;
  const result = await run(
    `INSERT INTO transactions
      (org_serial, tx_hash, account_name, tx_type, amount, asset, status, source_account, destination_account, memo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orgSerial, txHash, destination || source || `${asset} Account`, txType, amount, asset, status, source, destination, memo]
  );
  return { id: result.lastID, tx_hash: txHash };
}

async function initializeDatabase() {
  await run(`CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial TEXT UNIQUE,
    name TEXT,
    owner_wallet TEXT UNIQUE,
    balance_usdc REAL DEFAULT 35000.0,
    balance_usdt REAL DEFAULT 20000.0,
    deposit_wallet_usdc TEXT,
    deposit_wallet_usdt TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_serial TEXT,
    name TEXT,
    wallet TEXT,
    rank_title TEXT,
    salary REAL,
    status TEXT DEFAULT 'ACTIVE',
    asset TEXT DEFAULT 'USDC',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_serial TEXT,
    company_name TEXT,
    contact_email TEXT,
    wallet TEXT,
    sector TEXT,
    department TEXT,
    payment_terms TEXT,
    multisig_rule TEXT,
    status TEXT DEFAULT 'PENDING',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS boltons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_serial TEXT,
    module_key TEXT,
    module_name TEXT,
    is_active INTEGER DEFAULT 1,
    config_json TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(org_serial, module_key)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_serial TEXT NOT NULL,
    asset TEXT NOT NULL,
    account_name TEXT NOT NULL,
    balance REAL NOT NULL DEFAULT 0,
    UNIQUE(org_serial, asset)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_serial TEXT,
    tx_hash TEXT,
    account_name TEXT,
    tx_type TEXT,
    amount REAL,
    asset TEXT,
    status TEXT,
    source_account TEXT,
    destination_account TEXT,
    memo TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS organization_profiles (
    org_serial TEXT PRIMARY KEY,
    country TEXT NOT NULL DEFAULT 'CHE',
    registration_id TEXT NOT NULL DEFAULT 'CHE-482.910.339',
    ubo_name TEXT NOT NULL DEFAULT 'Alexander von Lunul',
    ubo_role TEXT NOT NULL DEFAULT 'Master Admin',
    tax_id TEXT NOT NULL DEFAULT 'CH482910339',
    withholding_rate REAL NOT NULL DEFAULT 18.5,
    auditor TEXT NOT NULL DEFAULT 'KPMG Zug',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS dao_containers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_serial TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    quorum REAL NOT NULL,
    timelock_hours INTEGER NOT NULL,
    token_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await run(`CREATE TABLE IF NOT EXISTS dao_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_serial TEXT NOT NULL,
    proposal_key TEXT NOT NULL,
    title TEXT NOT NULL,
    asset TEXT NOT NULL,
    amount REAL NOT NULL,
    recipient TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    votes_for REAL NOT NULL DEFAULT 0,
    votes_against REAL NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    executed_at DATETIME,
    UNIQUE(org_serial, proposal_key)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS dao_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    voter_wallet TEXT NOT NULL,
    vote TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(proposal_id, voter_wallet)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS escrow_vaults (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_serial TEXT NOT NULL,
    name TEXT NOT NULL,
    asset TEXT NOT NULL,
    amount REAL NOT NULL,
    deposit_address TEXT NOT NULL,
    cliff_days INTEGER NOT NULL,
    unlock_at DATETIME NOT NULL,
    status TEXT NOT NULL DEFAULT 'LOCKED',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await ensureColumn('employees', 'asset', "TEXT DEFAULT 'USDC'");
  await ensureColumn('transactions', 'source_account', 'TEXT');
  await ensureColumn('transactions', 'destination_account', 'TEXT');
  await ensureColumn('transactions', 'memo', 'TEXT');
  await run(`DELETE FROM boltons WHERE id NOT IN (
    SELECT MIN(id) FROM boltons GROUP BY org_serial, module_key
  )`);
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_boltons_org_module ON boltons(org_serial, module_key)');

  const organizations = await all('SELECT serial FROM organizations');
  for (const org of organizations) {
    await ensureOrganization(org.serial);
    await run('INSERT OR IGNORE INTO organization_profiles (org_serial) VALUES (?)', [org.serial]);
  }
}

async function ensureColumn(table, column, definition) {
  const columns = await all(`PRAGMA table_info(${table})`);
  if (!columns.some(item => item.name === column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

app.post('/api/auth', async (req, res) => {
  const wallet = requireEvmAddress(req.body.wallet, 'Wallet address');
  const org = await get('SELECT serial, name FROM organizations WHERE lower(owner_wallet) = lower(?)', [wallet]);
  res.json(org
    ? { wallet, org_serial: org.serial, org_name: org.name }
    : { wallet, nickname: req.body.nickname || null, org_serial: null });
});

app.post('/api/org/register', async (req, res) => {
  const wallet = requireEvmAddress(req.body.wallet, 'Wallet address');
  const orgName = requireText(req.body.orgName, 'Organization name');
  let org = await get('SELECT serial, deposit_wallet_usdc, deposit_wallet_usdt FROM organizations WHERE lower(owner_wallet) = lower(?)', [wallet]);
  if (!org) {
    const serial = `TERM-ORG-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${Date.now().toString().slice(-4)}`;
    const depositUsdc = `0x${crypto.randomBytes(20).toString('hex')}`;
    const depositUsdt = `0x${crypto.randomBytes(20).toString('hex')}`;
    await withTransaction(async () => {
      await run(
        `INSERT INTO organizations (serial, name, owner_wallet, balance_usdc, balance_usdt, deposit_wallet_usdc, deposit_wallet_usdt)
         VALUES (?, ?, ?, 35000, 20000, ?, ?)`,
        [serial, orgName, wallet, depositUsdc, depositUsdt]
      );
      await ensureOrganization(serial);
      await run('INSERT INTO organization_profiles (org_serial) VALUES (?)', [serial]);
    });
    org = { serial, deposit_wallet_usdc: depositUsdc, deposit_wallet_usdt: depositUsdt };
  } else {
    await ensureOrganization(org.serial);
  }
  res.json({ success: true, ...org });
});

app.get('/api/org/:serial', async (req, res) => {
  const org = await ensureOrganization(req.params.serial);
  const accounts = await all('SELECT asset, balance FROM accounts WHERE org_serial = ?', [org.serial]);
  const balances = Object.fromEntries(accounts.map(account => [account.asset, account.balance]));
  res.json({ ...org, balance_usdc: balances.USDC, balance_usdt: balances.USDT, balances });
});

app.get('/api/org/:serial/profile', async (req, res) => {
  await ensureOrganization(req.params.serial);
  await run('INSERT OR IGNORE INTO organization_profiles (org_serial) VALUES (?)', [req.params.serial]);
  res.json(await get('SELECT * FROM organization_profiles WHERE org_serial = ?', [req.params.serial]));
});

app.put('/api/org/:serial/profile', async (req, res) => {
  await ensureOrganization(req.params.serial);
  const { country, registrationId, uboName, uboRole, taxId, withholdingRate, auditor } = req.body;
  const rate = Number(withholdingRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    return res.status(400).json({ error: 'Withholding rate must be between 0 and 100.' });
  }
  const orgName = requireText(req.body.orgName, 'Organization name');
  await run(
    `INSERT INTO organization_profiles
      (org_serial, country, registration_id, ubo_name, ubo_role, tax_id, withholding_rate, auditor, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(org_serial) DO UPDATE SET country=excluded.country, registration_id=excluded.registration_id,
       ubo_name=excluded.ubo_name, ubo_role=excluded.ubo_role, tax_id=excluded.tax_id,
       withholding_rate=excluded.withholding_rate, auditor=excluded.auditor, updated_at=CURRENT_TIMESTAMP`,
    [
      req.params.serial,
      requireText(country, 'Country', 3),
      requireText(registrationId, 'Registration ID', 100),
      requireText(uboName, 'UBO name'),
      requireText(uboRole, 'UBO role'),
      requireText(taxId, 'Tax ID', 100),
      rate,
      requireText(auditor, 'Auditor')
    ]
  );
  await run('UPDATE organizations SET name = ? WHERE serial = ?', [orgName, req.params.serial]);
  res.json(await get('SELECT * FROM organization_profiles WHERE org_serial = ?', [req.params.serial]));
});

app.get('/api/accounts/:serial', async (req, res) => {
  await ensureOrganization(req.params.serial);
  res.json(await all('SELECT asset, account_name, balance FROM accounts WHERE org_serial = ? ORDER BY id', [req.params.serial]));
});

app.post('/api/accounts/transfer', async (req, res) => {
  const { orgSerial, sourceAsset, destinationAsset, memo } = req.body;
  const amount = requireAmount(req.body.amount);
  if (!ASSETS[sourceAsset] || !ASSETS[destinationAsset]) return res.status(400).json({ error: 'Unsupported account asset.' });
  if (sourceAsset !== destinationAsset) return res.status(400).json({ error: 'Cross-asset transfers require an exchange rate and are not supported.' });
  if (req.body.sourceAccount === req.body.destinationAccount) return res.status(400).json({ error: 'Choose different source and destination accounts.' });
  const org = await ensureOrganization(orgSerial);
  const source = requireText(req.body.sourceAccount, 'Source account');
  const destination = requireText(req.body.destinationAccount, 'Destination account');
  if (ASSETS[sourceAsset].account !== source || ASSETS[destinationAsset].account !== destination) {
    return res.status(400).json({ error: 'Account-to-account transfers are not configured for these ledger accounts.' });
  }
  await withTransaction(async () => {
    const account = await get('SELECT balance FROM accounts WHERE org_serial = ? AND asset = ?', [org.serial, sourceAsset]);
    if (!account || account.balance < amount) {
      const err = new Error('Insufficient account balance.');
      err.status = 400;
      throw err;
    }
    await run('UPDATE accounts SET balance = balance - ? WHERE org_serial = ? AND asset = ?', [amount, org.serial, sourceAsset]);
    await run('UPDATE accounts SET balance = balance + ? WHERE org_serial = ? AND asset = ?', [amount, org.serial, destinationAsset]);
    await syncLegacyBalances(org.serial);
    await recordTransaction({ orgSerial: org.serial, txType: 'Internal Transfer', amount, asset: sourceAsset, source, destination, memo: memo || null });
  });
  res.json({ success: true, accounts: await all('SELECT asset, account_name, balance FROM accounts WHERE org_serial = ?', [org.serial]) });
});

app.post('/api/accounts/deposit', async (req, res) => {
  const { orgSerial, asset } = req.body;
  const amount = requireAmount(req.body.amount);
  if (!['USDC', 'USDT'].includes(asset)) return res.status(400).json({ error: 'Deposits are only supported for USDC and USDT.' });
  const org = await ensureOrganization(orgSerial);
  await withTransaction(async () => {
    await run('UPDATE accounts SET balance = balance + ? WHERE org_serial = ? AND asset = ?', [amount, org.serial, asset]);
    await syncLegacyBalances(org.serial);
    await recordTransaction({ orgSerial: org.serial, txType: 'External Deposit', amount, asset, source: 'External Deposit', destination: ASSETS[asset].account });
  });
  res.json({ success: true, accounts: await all('SELECT asset, account_name, balance FROM accounts WHERE org_serial = ?', [org.serial]) });
});

app.post('/api/accounts/withdraw', async (req, res) => {
  const { orgSerial, asset } = req.body;
  const amount = requireAmount(req.body.amount);
  if (!['USDC', 'USDT'].includes(asset)) return res.status(400).json({ error: 'Withdrawals are only supported for USDC and USDT.' });
  const org = await ensureOrganization(orgSerial);
  await withTransaction(async () => {
    const account = await get('SELECT balance FROM accounts WHERE org_serial = ? AND asset = ?', [org.serial, asset]);
    if (!account || account.balance < amount) {
      const err = new Error('Insufficient account balance.');
      err.status = 400;
      throw err;
    }
    await run('UPDATE accounts SET balance = balance - ? WHERE org_serial = ? AND asset = ?', [amount, org.serial, asset]);
    await syncLegacyBalances(org.serial);
    await recordTransaction({ orgSerial: org.serial, txType: 'Withdrawal', amount, asset, source: ASSETS[asset].account, destination: 'External Wallet' });
  });
  res.json({ success: true, accounts: await all('SELECT asset, account_name, balance FROM accounts WHERE org_serial = ?', [org.serial]) });
});

async function syncLegacyBalances(serial) {
  await run(
    `UPDATE organizations SET
      balance_usdc = (SELECT balance FROM accounts WHERE org_serial = ? AND asset = 'USDC'),
      balance_usdt = (SELECT balance FROM accounts WHERE org_serial = ? AND asset = 'USDT')
     WHERE serial = ?`,
    [serial, serial, serial]
  );
}

app.get('/api/employees/:serial', async (req, res) => {
  await ensureOrganization(req.params.serial);
  res.json(await all('SELECT * FROM employees WHERE org_serial = ? ORDER BY id DESC', [req.params.serial]));
});

app.post('/api/employees/add', async (req, res) => {
  const { orgSerial, wallet, rankTitle, salary, asset } = req.body;
  const org = await ensureOrganization(orgSerial);
  const name = requireText(req.body.name, 'Employee name');
  const amount = requireAmount(salary);
  const currency = asset || 'USDC';
  if (!['USDC', 'USDT'].includes(currency)) return res.status(400).json({ error: 'Employee asset must be USDC or USDT.' });
  const targetWallet = wallet ? requireText(wallet, 'Wallet address', 100) : `0x${crypto.randomBytes(20).toString('hex')}`;
  const result = await run(
    `INSERT INTO employees (org_serial, name, wallet, rank_title, salary, asset) VALUES (?, ?, ?, ?, ?, ?)`,
    [org.serial, name, targetWallet, (rankTitle || 'Team Member').trim(), amount, currency]
  );
  res.json({ success: true, id: result.lastID, generated_wallet: targetWallet });
});

app.get('/api/vendors/:serial', async (req, res) => {
  await ensureOrganization(req.params.serial);
  res.json(await all('SELECT * FROM vendors WHERE org_serial = ? ORDER BY id DESC', [req.params.serial]));
});

app.post('/api/vendors/add', async (req, res) => {
  const { orgSerial, companyName, contactEmail, wallet, sector, department, paymentTerms, multisigRule } = req.body;
  const org = await ensureOrganization(orgSerial);
  const name = requireText(companyName, 'Company name');
  const targetWallet = wallet ? requireText(wallet, 'Wallet address', 100) : `0x${crypto.randomBytes(20).toString('hex')}`;
  const result = await run(
    `INSERT INTO vendors (org_serial, company_name, contact_email, wallet, sector, department, payment_terms, multisig_rule, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    [org.serial, name, contactEmail || '', targetWallet, sector || '', department || '', paymentTerms || '', multisigRule || '']
  );
  res.json({ success: true, id: result.lastID, generated_wallet: targetWallet });
});

app.get('/api/boltons/:serial', async (req, res) => {
  await ensureOrganization(req.params.serial);
  res.json(await all('SELECT * FROM boltons WHERE org_serial = ? ORDER BY module_key', [req.params.serial]));
});

app.post('/api/boltons/toggle', async (req, res) => {
  const { orgSerial, moduleKey, moduleName, config } = req.body;
  const org = await ensureOrganization(orgSerial);
  const key = requireText(moduleKey, 'Module key', 80);
  const row = await get('SELECT * FROM boltons WHERE org_serial = ? AND module_key = ?', [org.serial, key]);
  const isActive = typeof req.body.isActive === 'boolean'
    ? Number(req.body.isActive)
    : row ? (row.is_active ? 0 : 1) : 1;
  if (row) {
    await run(
      `UPDATE boltons SET module_name = ?, is_active = ?, config_json = COALESCE(?, config_json),
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [moduleName || row.module_name || key, isActive, config ? JSON.stringify(config) : null, row.id]
    );
  } else {
    await run(
      `INSERT INTO boltons (org_serial, module_key, module_name, is_active, config_json)
       VALUES (?, ?, ?, ?, ?)`,
      [org.serial, key, moduleName || key, isActive, config ? JSON.stringify(config) : null]
    );
  }
  res.json({ success: true, is_active: isActive });
});

app.post('/api/payroll/execute', async (req, res) => {
  const { orgSerial, asset = 'USDC' } = req.body;
  if (!['USDC', 'USDT'].includes(asset)) return res.status(400).json({ error: 'Payroll asset must be USDC or USDT.' });
  const org = await ensureOrganization(orgSerial);
  let result;
  await withTransaction(async () => {
    const employees = await all(
      `SELECT id, wallet, salary FROM employees
       WHERE org_serial = ? AND status = 'ACTIVE' AND asset = ?`,
      [org.serial, asset]
    );
    let total = 0;
    if (Array.isArray(req.body.allocations)) {
      if (req.body.allocations.length !== employees.length || employees.length === 0) {
        const err = new Error('Payroll manifest must include every active recipient for the selected asset.');
        err.status = 400;
        throw err;
      }
      const employeeByWallet = new Map(employees.map(employee => [employee.wallet.toLowerCase(), employee]));
      const seenWallets = new Set();
      for (const allocation of req.body.allocations) {
        const wallet = typeof allocation.wallet === 'string' ? allocation.wallet.toLowerCase() : '';
        const employee = employeeByWallet.get(wallet);
        const amount = Number(allocation.amount);
        if (!employee || seenWallets.has(wallet) || !Number.isFinite(amount) || amount <= 0) {
          const err = new Error('Payroll manifest has an unknown recipient or invalid amount.');
          err.status = 400;
          throw err;
        }
        seenWallets.add(wallet);
        total += amount;
      }
    } else {
      total = employees.reduce((sum, employee) => sum + Number(employee.salary || 0), 0);
    }
    if (!employees.length || total <= 0) {
      const err = new Error(`No active ${asset} payroll recipients are available.`);
      err.status = 400;
      throw err;
    }
    const account = await get('SELECT balance FROM accounts WHERE org_serial = ? AND asset = ?', [org.serial, asset]);
    if (!account || account.balance < total) {
      const err = new Error('Insufficient escrow vault balance for batch disbursement.');
      err.status = 400;
      throw err;
    }
    await run('UPDATE accounts SET balance = balance - ? WHERE org_serial = ? AND asset = ?', [total, org.serial, asset]);
    await syncLegacyBalances(org.serial);
    const tx = await recordTransaction({
      orgSerial: org.serial, txType: 'Batch Payroll Disbursement', amount: total,
      asset, source: ASSETS[asset].account, destination: 'Active Employee Roster',
      memo: `${employees.length} employee payroll payments`
    });
    result = { ...tx, total_amount: total, recipients: employees.length, remaining_balance: account.balance - total };
  });
  res.json({ success: true, ...result });
});

app.get('/api/transactions/:serial', async (req, res) => {
  await ensureOrganization(req.params.serial);
  res.json(await all('SELECT * FROM transactions WHERE org_serial = ? ORDER BY timestamp DESC, id DESC', [req.params.serial]));
});

app.get('/api/vaults/:serial', async (req, res) => {
  const org = await ensureOrganization(req.params.serial);
  const accounts = await all(
    `SELECT a.asset, a.account_name, a.balance,
      CASE a.asset WHEN 'USDC' THEN o.deposit_wallet_usdc WHEN 'USDT' THEN o.deposit_wallet_usdt ELSE NULL END AS deposit_address
     FROM accounts a JOIN organizations o ON o.serial = a.org_serial
     WHERE a.org_serial = ? AND a.asset IN ('USDC', 'USDT', 'LUN') ORDER BY a.id`,
    [org.serial]
  );
  const customVaults = await all('SELECT * FROM escrow_vaults WHERE org_serial = ? ORDER BY id DESC', [org.serial]);
  res.json({ accounts, vaults: customVaults });
});

app.post('/api/vaults', async (req, res) => {
  const org = await ensureOrganization(req.body.orgSerial);
  const name = requireText(req.body.name, 'Vault name');
  const asset = req.body.asset;
  const amount = requireAmount(req.body.amount);
  const cliffDays = Number(req.body.cliffDays);
  if (!['USDC', 'USDT', 'LUN'].includes(asset)) return res.status(400).json({ error: 'Unsupported vault asset.' });
  if (!Number.isInteger(cliffDays) || cliffDays < 1 || cliffDays > 3650) {
    return res.status(400).json({ error: 'Vault lockup must be between 1 and 3650 days.' });
  }
  if (!ASSETS[asset]) return res.status(400).json({ error: 'Unsupported account asset.' });
  const depositAddress = `0x${crypto.randomBytes(20).toString('hex')}`;
  let id;
  await withTransaction(async () => {
    const account = await get('SELECT balance FROM accounts WHERE org_serial = ? AND asset = ?', [org.serial, asset]);
    if (!account || account.balance < amount) {
      const err = new Error('Insufficient available account balance to fund this vault.');
      err.status = 400;
      throw err;
    }
    await run('UPDATE accounts SET balance = balance - ? WHERE org_serial = ? AND asset = ?', [amount, org.serial, asset]);
    await syncLegacyBalances(org.serial);
    const created = await run(
      `INSERT INTO escrow_vaults (org_serial, name, asset, amount, deposit_address, cliff_days, unlock_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`,
      [org.serial, name, asset, amount, depositAddress, cliffDays, `+${cliffDays} days`]
    );
    id = created.lastID;
    await recordTransaction({
      orgSerial: org.serial, txType: 'Time-Locked Vault Funding', amount, asset,
      source: ASSETS[asset].account, destination: name, memo: `${cliffDays}-day lockup`
    });
  });
  res.json({ success: true, vault: await get('SELECT * FROM escrow_vaults WHERE id = ?', [id]) });
});

app.get('/api/dao/:serial', async (req, res) => {
  await ensureOrganization(req.params.serial);
  res.json({
    container: await get('SELECT * FROM dao_containers WHERE org_serial = ?', [req.params.serial]) || null,
    proposals: await all('SELECT * FROM dao_proposals WHERE org_serial = ? ORDER BY id DESC', [req.params.serial])
  });
});

app.post('/api/dao/container', async (req, res) => {
  const org = await ensureOrganization(req.body.orgSerial);
  const name = requireText(req.body.name, 'DAO name');
  const quorum = Number(req.body.quorum);
  const timelockHours = Number(req.body.timelockHours);
  if (!Number.isFinite(quorum) || quorum <= 0 || quorum > 100 || !Number.isInteger(timelockHours) || timelockHours < 0) {
    return res.status(400).json({ error: 'Quorum must be between 0 and 100 and timelock must be a non-negative whole number.' });
  }
  const tokenAddress = req.body.tokenAddress ? requireEvmAddress(req.body.tokenAddress, 'Governance token address') : null;
  await run(
    `INSERT INTO dao_containers (org_serial, name, quorum, timelock_hours, token_address)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(org_serial) DO UPDATE SET name=excluded.name, quorum=excluded.quorum,
       timelock_hours=excluded.timelock_hours, token_address=excluded.token_address`,
    [org.serial, name, quorum, timelockHours, tokenAddress]
  );
  res.json({ success: true, container: await get('SELECT * FROM dao_containers WHERE org_serial = ?', [org.serial]) });
});

app.post('/api/dao/proposals', async (req, res) => {
  const org = await ensureOrganization(req.body.orgSerial);
  const container = await get('SELECT id FROM dao_containers WHERE org_serial = ?', [org.serial]);
  if (!container) return res.status(400).json({ error: 'Initialize the DAO container before creating proposals.' });
  const title = requireText(req.body.title, 'Proposal title');
  const asset = req.body.asset;
  const amount = requireAmount(req.body.amount);
  if (!['USDC', 'USDT'].includes(asset)) return res.status(400).json({ error: 'Proposal asset must be USDC or USDT.' });
  const recipient = requireEvmAddress(req.body.recipient, 'Recipient wallet');
  const last = await get('SELECT proposal_key FROM dao_proposals WHERE org_serial = ? ORDER BY id DESC LIMIT 1', [org.serial]);
  const nextNumber = last ? Number((last.proposal_key.match(/\d+$/) || [0])[0]) + 1 : 1;
  const proposalKey = `TIP-${String(nextNumber).padStart(2, '0')}`;
  const result = await run(
    `INSERT INTO dao_proposals (org_serial, proposal_key, title, asset, amount, recipient, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [org.serial, proposalKey, title, asset, amount, recipient, req.body.description || '']
  );
  res.json({ success: true, id: result.lastID, proposal_key: proposalKey });
});

app.post('/api/dao/proposals/:proposalKey/vote', async (req, res) => {
  const org = await ensureOrganization(req.body.orgSerial);
  const voter = requireText(req.body.wallet, 'Voter wallet', 100);
  const vote = req.body.vote;
  if (!['FOR', 'AGAINST'].includes(vote)) return res.status(400).json({ error: 'Vote must be FOR or AGAINST.' });
  const proposal = await get('SELECT * FROM dao_proposals WHERE org_serial = ? AND proposal_key = ?', [org.serial, req.params.proposalKey]);
  if (!proposal || proposal.status !== 'ACTIVE') return res.status(404).json({ error: 'Active proposal not found.' });
  await withTransaction(async () => {
    const existingVote = await get('SELECT id FROM dao_votes WHERE proposal_id = ? AND voter_wallet = ?', [proposal.id, voter.toLowerCase()]);
    if (existingVote) {
      const err = new Error('This wallet has already voted on the proposal.');
      err.status = 409;
      throw err;
    }
    await run('INSERT INTO dao_votes (proposal_id, voter_wallet, vote) VALUES (?, ?, ?)', [proposal.id, voter.toLowerCase(), vote]);
    await run(
      `UPDATE dao_proposals SET votes_for = votes_for + ?, votes_against = votes_against + ? WHERE id = ?`,
      [vote === 'FOR' ? 1 : 0, vote === 'AGAINST' ? 1 : 0, proposal.id]
    );
  });
  res.json({ success: true });
});

app.post('/api/dao/proposals/:proposalKey/execute', async (req, res) => {
  const org = await ensureOrganization(req.body.orgSerial);
  let tx;
  await withTransaction(async () => {
    const proposal = await get('SELECT * FROM dao_proposals WHERE org_serial = ? AND proposal_key = ?', [org.serial, req.params.proposalKey]);
    if (!proposal || proposal.status !== 'ACTIVE') {
      const err = new Error('Active proposal not found.');
      err.status = 404;
      throw err;
    }
    const dao = await get('SELECT quorum, timelock_hours FROM dao_containers WHERE org_serial = ?', [org.serial]);
    if (!dao) {
      const err = new Error('Initialize the DAO container before executing proposals.');
      err.status = 400;
      throw err;
    }
    const voteCount = Number(proposal.votes_for || 0) + Number(proposal.votes_against || 0);
    if (!voteCount || Number(proposal.votes_for || 0) / voteCount * 100 < Number(dao.quorum)) {
      const err = new Error(`Proposal has not reached its ${dao.quorum}% affirmative vote threshold.`);
      err.status = 400;
      throw err;
    }
    const mature = await get(
      `SELECT datetime('now') >= datetime(?, '+' || ? || ' hours') AS ready`,
      [proposal.created_at, dao.timelock_hours]
    );
    if (!mature?.ready) {
      const err = new Error(`Proposal timelock of ${dao.timelock_hours} hours has not elapsed.`);
      err.status = 400;
      throw err;
    }
    const account = await get('SELECT balance FROM accounts WHERE org_serial = ? AND asset = ?', [org.serial, proposal.asset]);
    if (!account || account.balance < proposal.amount) {
      const err = new Error('Insufficient escrow vault balance.');
      err.status = 400;
      throw err;
    }
    await run('UPDATE accounts SET balance = balance - ? WHERE org_serial = ? AND asset = ?', [proposal.amount, org.serial, proposal.asset]);
    await syncLegacyBalances(org.serial);
    await run(`UPDATE dao_proposals SET status = 'EXECUTED', executed_at = CURRENT_TIMESTAMP WHERE id = ?`, [proposal.id]);
    tx = await recordTransaction({
      orgSerial: org.serial, txType: 'DAO Treasury Disbursement', amount: proposal.amount,
      asset: proposal.asset, source: ASSETS[proposal.asset].account,
      destination: proposal.recipient, memo: proposal.proposal_key
    });
  });
  res.json({ success: true, ...tx });
});

app.use((err, _req, res, _next) => {
  console.error('API request failed:', err.message);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error.' });
});

initializeDatabase().then(() => {
  const port = Number(PORT);
  app.listen(port, () => console.log(`Terminull Enterprise Server running on port ${port}`));
}).catch(err => {
  console.error('Failed to initialize SQLite database:', err);
  process.exitCode = 1;
});
