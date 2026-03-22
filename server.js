/**
 * BauerSoft Billing
 * One app, two portals:
 *   - /admin/*  → Jack + Clea (JWT, env-var password)
 *   - /client/* → Clients (magic link email auth)
 *   - /api/*    → Public or auth-gated API endpoints
 *
 * Deploy: billing.bauersoft.io on Railway
 */

const express      = require('express')
const cors         = require('cors')
const helmet       = require('helmet')
const jwt          = require('jsonwebtoken')
const { Pool }     = require('pg')
const Stripe       = require('stripe')
const { v4: uuid } = require('uuid')
const nodemailer   = require('nodemailer')
const crypto       = require('crypto')
const rateLimit    = require('express-rate-limit')

// Wrap async route handlers so errors propagate to the global error handler
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

require('dotenv').config()

const app  = express()
const PORT = process.env.PORT || 3001

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
})

// ── Stripe ────────────────────────────────────────────────────────────────────
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null

// ── Email ─────────────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
})

async function sendEmail({ to, subject, html, text }) {
  if (!process.env.SMTP_USER) {
    console.log(`[Email STUB] To: ${to} | Subject: ${subject}`)
    return { stub: true }
  }
  return mailer.sendMail({
    from: `"BauerSoft Billing" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
    to, subject, html, text,
  })
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'"],   // inline scripts in HTML files
      styleSrc:       ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:        ["'self'", 'https://fonts.gstatic.com'],
      connectSrc:     ["'self'"],
      imgSrc:         ["'self'", 'data:'],
      frameSrc:       ["'none'"],
      objectSrc:      ["'none'"],
    },
  },
}))
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
}))
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }))
app.use(express.json())

// ── Rate limiters ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many login attempts — try again in 15 minutes' },
  standardHeaders: true, legacyHeaders: false,
})
const magicLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Too many magic link requests — try again in an hour' },
  standardHeaders: true, legacyHeaders: false,
})
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  message: { error: 'Too many submissions — try again later' },
  standardHeaders: true, legacyHeaders: false,
})

// ── Auth helpers ──────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production'

function signToken(payload, expiresIn = '7d') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn })
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET) } catch { return null }
}

// Admin auth — Jack or Clea
const requireAdmin = (req, res, next) => {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-api-key']
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  // Accept static API key (for Clea) or JWT (for Jack's browser session)
  if (token === process.env.ADMIN_API_KEY) return next()
  const payload = verifyToken(token)
  if (payload?.role === 'admin' && payload?.pwv === PW_VERSION) return next()
  return res.status(401).json({ error: 'Unauthorized' })
}

// Client auth — logged-in client session
const requireClient = (req, res, next) => {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  const payload = verifyToken(token)
  if (!payload?.clientId) return res.status(401).json({ error: 'Unauthorized' })
  req.clientId = payload.clientId
  req.clientEmail = payload.email
  next()
}

// ── DB Schema ─────────────────────────────────────────────────────────────────
async function initDb() {
  // ── accounts ─────────────────────────────────────────────────────────────
  // One row per business using this billing system.
  // 'bauersoft' = Jack's own account (default). House of Photos etc. get their own.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      email             TEXT,
      stripe_account_id TEXT,
      settings          JSONB DEFAULT '{}',
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    INSERT INTO accounts (id, name, email)
    VALUES ('bauersoft', 'BauerSoft', 'billing@bauersoft.io')
    ON CONFLICT (id) DO NOTHING
  `)

  // ── clients ───────────────────────────────────────────────────────────────
  // The people being billed, scoped to an account.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id                 TEXT PRIMARY KEY,
      account_id         TEXT NOT NULL DEFAULT 'bauersoft' REFERENCES accounts(id),
      name               TEXT NOT NULL,
      email              TEXT NOT NULL,
      company            TEXT,
      phone              TEXT,
      address            TEXT,
      notes              TEXT,
      stripe_customer_id TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (account_id, email)
    )
  `)
  // Safe migrations
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'bauersoft'`)
  await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`)

  // ── magic_links ───────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS magic_links (
      token      TEXT PRIMARY KEY,
      client_id  TEXT REFERENCES clients(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // ── projects ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL DEFAULT 'bauersoft' REFERENCES accounts(id),
      client_id   TEXT REFERENCES clients(id) ON DELETE SET NULL,
      name        TEXT NOT NULL,
      description TEXT,
      status      TEXT DEFAULT 'active',
      type        TEXT DEFAULT 'fixed',
      total_value NUMERIC(10,2),
      start_date  DATE,
      end_date    DATE,
      notes       TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'bauersoft'`)

  // ── invoices ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id                       TEXT PRIMARY KEY,
      account_id               TEXT NOT NULL DEFAULT 'bauersoft' REFERENCES accounts(id),
      invoice_number           TEXT NOT NULL,
      client_id                TEXT REFERENCES clients(id) ON DELETE SET NULL,
      project_id               TEXT REFERENCES projects(id) ON DELETE SET NULL,
      status                   TEXT DEFAULT 'draft',
      currency                 TEXT DEFAULT 'usd',
      subtotal                 NUMERIC(10,2) NOT NULL DEFAULT 0,
      tax_rate                 NUMERIC(5,4) DEFAULT 0,
      tax_amount               NUMERIC(10,2) DEFAULT 0,
      total                    NUMERIC(10,2) NOT NULL DEFAULT 0,
      due_date                 DATE,
      paid_at                  TIMESTAMPTZ,
      stripe_payment_link_url  TEXT,
      stripe_payment_intent_id TEXT,
      notes                    TEXT,
      created_at               TIMESTAMPTZ DEFAULT NOW(),
      updated_at               TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (account_id, invoice_number)
    )
  `)
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'bauersoft'`)

  // ── invoice_line_items ────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id          TEXT PRIMARY KEY,
      invoice_id  TEXT REFERENCES invoices(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity    NUMERIC(10,2) DEFAULT 1,
      unit_price  NUMERIC(10,2) NOT NULL,
      amount      NUMERIC(10,2) NOT NULL,
      sort_order  INT DEFAULT 0
    )
  `)

  // ── contacts ──────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id         TEXT PRIMARY KEY,
      account_id TEXT NOT NULL DEFAULT 'bauersoft' REFERENCES accounts(id),
      name       TEXT,
      email      TEXT,
      message    TEXT NOT NULL,
      source     TEXT DEFAULT 'website',
      status     TEXT DEFAULT 'new',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'bauersoft'`)

  // ── invoice_counters ──────────────────────────────────────────────────────
  // Atomic per-account invoice number counter. Safer than Postgres sequences
  // which reset to 1 on a fresh DB even when invoices already exist.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_counters (
      account_id TEXT PRIMARY KEY,
      last_num   INT NOT NULL DEFAULT 0
    )
  `)
  // Seed from existing invoices so a re-deploy never reuses a number
  await pool.query(`
    INSERT INTO invoice_counters (account_id, last_num)
    SELECT account_id,
      COALESCE(MAX(CASE WHEN invoice_number ~ '^INV-[0-9]+$'
        THEN CAST(REPLACE(invoice_number, 'INV-', '') AS INT)
        ELSE 0 END), 0)
    FROM invoices
    GROUP BY account_id
    ON CONFLICT (account_id) DO UPDATE
      SET last_num = GREATEST(invoice_counters.last_num, EXCLUDED.last_num)
  `)

  console.log('[DB] Schema ready')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Atomic invoice number — counter table, immune to fresh-DB sequence resets
async function nextInvoiceNumber(accountId = 'bauersoft') {
  const { rows } = await pool.query(`
    INSERT INTO invoice_counters (account_id, last_num) VALUES ($1, 1)
    ON CONFLICT (account_id) DO UPDATE SET last_num = invoice_counters.last_num + 1
    RETURNING last_num
  `, [accountId])
  return `INV-${String(rows[0].last_num).padStart(4, '0')}`
}

// Escape HTML to prevent XSS in email bodies
function escHtml(str) {
  if (!str) return ''
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// Current password version — bump JWT_SECRET to invalidate all sessions
const PW_VERSION = process.env.ADMIN_PASSWORD ? crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD).digest('hex').slice(0, 8) : 'default'

function calcTotals(lineItems, taxRate = 0) {
  const subtotal = lineItems.reduce((s, li) => s + parseFloat(li.amount || li.unit_price), 0)
  const taxAmount = subtotal * parseFloat(taxRate)
  return {
    subtotal:   +subtotal.toFixed(2),
    tax_amount: +taxAmount.toFixed(2),
    total:      +(subtotal + taxAmount).toFixed(2),
  }
}

function invoiceEmailHtml(invoice, lineItems, paymentUrl) {
  const lines = lineItems.map(li =>
    `<tr><td>${escHtml(li.description)}</td><td align="right">${li.quantity}</td><td align="right">$${parseFloat(li.unit_price).toFixed(2)}</td><td align="right">$${parseFloat(li.amount).toFixed(2)}</td></tr>`
  ).join('')

  return `
  <div style="font-family:sans-serif;max-width:600px;margin:auto;color:#111">
    <h2 style="color:#1a1a2e">Invoice ${escHtml(invoice.invoice_number)}</h2>
    <p>Hi ${escHtml(invoice.client_name) || 'there'},</p>
    <p>You have a new invoice from BauerSoft for <strong>$${parseFloat(invoice.total).toFixed(2)} USD</strong>.</p>
    ${invoice.due_date ? `<p><strong>Due:</strong> ${invoice.due_date}</p>` : ''}
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <thead><tr style="border-bottom:2px solid #eee">
        <th align="left">Description</th><th align="right">Qty</th><th align="right">Unit</th><th align="right">Total</th>
      </tr></thead>
      <tbody>${lines}</tbody>
      <tfoot>
        <tr><td colspan="3" align="right"><strong>Subtotal</strong></td><td align="right">$${parseFloat(invoice.subtotal).toFixed(2)}</td></tr>
        ${parseFloat(invoice.tax_rate) > 0 ? `<tr><td colspan="3" align="right">Tax (${(parseFloat(invoice.tax_rate)*100).toFixed(1)}%)</td><td align="right">$${parseFloat(invoice.tax_amount).toFixed(2)}</td></tr>` : ''}
        <tr style="font-size:1.1em"><td colspan="3" align="right"><strong>Total</strong></td><td align="right"><strong>$${parseFloat(invoice.total).toFixed(2)}</strong></td></tr>
      </tfoot>
    </table>
    ${paymentUrl ? `<p style="text-align:center;margin:24px 0"><a href="${paymentUrl}" style="background:#4f46e5;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">Pay Now</a></p>` : ''}
    <p style="color:#666;font-size:0.9em">BauerSoft · Custom Software for Small Businesses · billing@bauersoft.io</p>
  </div>`
}

// ── Static files ─────────────────────────────────────────────────────────────
const path = require('path')
app.use(express.static(path.join(__dirname, 'public')))

// SPA routes
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')))
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')))

// Magic link verify → redirect to portal with token param (for email clients that strip JS)
app.get('/auth/verify', async (req, res) => {
  const { token: magicToken } = req.query
  if (!magicToken) return res.redirect('/portal.html?error=missing_token')
  try {
    // Atomic verify — prevents race condition from duplicate requests
    const { rows: linkRows } = await pool.query(
      `UPDATE magic_links SET used=TRUE WHERE token=$1 AND used=FALSE AND expires_at > NOW() RETURNING client_id`,
      [magicToken]
    )
    if (!linkRows[0]) return res.redirect('/portal.html?error=expired')
    const { rows: clients } = await pool.query(`SELECT * FROM clients WHERE id=$1`, [linkRows[0].client_id])
    const client = clients[0]
    if (!client) return res.redirect('/portal.html?error=not_found')
    const sessionToken = signToken({ clientId: client.id, email: client.email, role: 'client' }, '7d')
    // Return JSON for JS-driven verification, or redirect with token for email clients
    const accept = req.headers.accept || ''
    if (accept.includes('application/json')) {
      return res.json({ token: sessionToken, client: { id: client.id, name: client.name, email: client.email } })
    }
    // Hash fragment — not sent to servers, not in access logs, not in Referer headers
    res.redirect(`/portal.html#session=${sessionToken}`)
  } catch(e) {
    console.error('verify error:', e)
    res.redirect('/portal.html?error=server')
  }
})

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, service: 'bauersoft-billing' }))

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — ACCOUNTS
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/accounts', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM accounts ORDER BY created_at ASC`)
  res.json(rows)
}))

app.post('/api/accounts', requireAdmin, asyncHandler(async (req, res) => {
  const { id, name, email, settings } = req.body
  if (!id || !name) return res.status(400).json({ error: 'id and name required' })
  const { rows } = await pool.query(
    `INSERT INTO accounts (id, name, email, settings) VALUES ($1,$2,$3,$4) RETURNING *`,
    [id, name, email || null, JSON.stringify(settings || {})]
  )
  res.status(201).json(rows[0])
}))

app.patch('/api/accounts/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { name, email, stripe_account_id, settings } = req.body
  const updates = []
  const vals = [req.params.id]
  if (name)              { vals.push(name);              updates.push(`name=$${vals.length}`) }
  if (email)             { vals.push(email);             updates.push(`email=$${vals.length}`) }
  if (stripe_account_id) { vals.push(stripe_account_id); updates.push(`stripe_account_id=$${vals.length}`) }
  if (settings)          { vals.push(JSON.stringify(settings)); updates.push(`settings=$${vals.length}`) }
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' })
  const { rows } = await pool.query(
    `UPDATE accounts SET ${updates.join(',')}, updated_at=NOW() WHERE id=$1 RETURNING *`, vals
  )
  res.json(rows[0])
}))

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN AUTH
// ─────────────────────────────────────────────────────────────────────────────

// Jack's browser login (returns JWT for admin dashboard)
app.post('/auth/admin/login', loginLimiter, (req, res) => {
  const { password } = req.body
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' })
  }
  // Embed password version so changing ADMIN_PASSWORD invalidates all existing tokens
  const token = signToken({ role: 'admin', pwv: PW_VERSION }, '30d')
  res.json({ token })
})

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT AUTH (magic link)
// ─────────────────────────────────────────────────────────────────────────────

// Client requests login link — sends email
app.post('/auth/client/request', magicLinkLimiter, asyncHandler(async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'email required' })

  const { rows } = await pool.query(`SELECT * FROM clients WHERE email=LOWER($1)`, [email])
  // Always return success (don't reveal whether email exists)
  if (!rows[0]) return res.json({ ok: true })

  const client = rows[0]
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h

  await pool.query(
    `INSERT INTO magic_links (token, client_id, expires_at) VALUES ($1, $2, $3)`,
    [token, client.id, expiresAt]
  )

  const loginUrl = `${process.env.APP_URL || 'https://billing.bauersoft.io'}/auth/verify?token=${token}`

  await sendEmail({
    to: client.email,
    subject: 'Your BauerSoft login link',
    text: `Click here to log in: ${loginUrl}\n\nThis link expires in 24 hours.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2>Log in to BauerSoft Billing</h2>
        <p>Hi ${escHtml(client.name) || 'there'}, click below to access your invoices:</p>
        <p style="text-align:center;margin:24px 0">
          <a href="${loginUrl}" style="background:#4f46e5;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">Log In</a>
        </p>
        <p style="color:#666;font-size:0.85em">This link expires in 24 hours. If you didn't request this, ignore this email.</p>
      </div>`,
  })

  res.json({ ok: true })
}))  // end magicLinkLimiter + asyncHandler

// Client verifies magic link token — returns JWT
app.post('/auth/client/verify', asyncHandler(async (req, res) => {
  const { token } = req.body
  if (!token) return res.status(400).json({ error: 'token required' })

  // Atomic: only marks used if it wasn't already — prevents race condition
  const { rows } = await pool.query(
    `UPDATE magic_links SET used=TRUE
     WHERE token=$1 AND used=FALSE AND expires_at > NOW()
     RETURNING client_id`,
    [token]
  )
  if (!rows[0]) return res.status(401).json({ error: 'Invalid or expired link' })

  // Get client details for the token
  const { rows: clients } = await pool.query(`SELECT id, email FROM clients WHERE id=$1`, [rows[0].client_id])
  const client = clients[0]
  const sessionToken = signToken({ clientId: client.id, email: client.email, role: 'client' }, '7d')
  res.json({ token: sessionToken, clientId: client.id })
}))

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT PORTAL (legacy routes — kept for backwards compat, consolidate below)
// ─────────────────────────────────────────────────────────────────────────────

// REMOVED: /client/invoices and /client/invoices/:id were duplicates of /api/portal/*.
// All client invoice access goes through /api/portal/* endpoints.

// /client/* routes removed — all client access goes through /api/portal/*

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — CLIENTS
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/clients', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, account_id, name, email, company, phone, address, created_at, updated_at FROM clients ORDER BY name`
  )
  res.json(rows)
}))

app.get('/api/clients/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM clients WHERE id=$1`, [req.params.id])
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
}))

app.post('/api/clients', requireAdmin, asyncHandler(async (req, res) => {
  const { name, email, company, phone, address, notes } = req.body
  if (!name || !email) return res.status(400).json({ error: 'name and email required' })
  const id = uuid()
  try {
    const { rows } = await pool.query(
      `INSERT INTO clients (id,name,email,company,phone,address,notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, name, email.toLowerCase(), company||null, phone||null, address||null, notes||null]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' })
    throw err
  }
}))

app.patch('/api/clients/:id', requireAdmin, asyncHandler(async (req, res) => {
  const allowed = ['name','email','company','phone','address','notes']
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k))
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' })
  const fields = updates.map(([k], i) => `${k}=$${i+2}`).join(',')
  try {
    const { rows } = await pool.query(
      `UPDATE clients SET ${fields}, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, ...updates.map(([,v]) => v)]
    )
    if (!rows[0]) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' })
    throw err
  }
}))

app.delete('/api/clients/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT COUNT(*) as n FROM invoices WHERE client_id=$1 AND status NOT IN ('paid','void')`,
    [req.params.id]
  )
  if (+rows[0].n > 0) {
    return res.status(409).json({ error: `Cannot delete client — ${rows[0].n} open invoice(s) exist. Resolve them first.` })
  }
  await pool.query(`DELETE FROM clients WHERE id=$1`, [req.params.id])
  res.json({ ok: true })
}))

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — PROJECTS
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/projects', requireAdmin, asyncHandler(async (req, res) => {
  const { client_id, status } = req.query
  let q = `SELECT p.*, c.name as client_name FROM projects p LEFT JOIN clients c ON p.client_id=c.id WHERE 1=1`
  const vals = []
  if (client_id) { vals.push(client_id); q += ` AND p.client_id=$${vals.length}` }
  if (status)    { vals.push(status);    q += ` AND p.status=$${vals.length}` }
  const { rows } = await pool.query(q + ` ORDER BY p.created_at DESC`, vals)
  res.json(rows)
}))

app.get('/api/projects/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, c.name as client_name FROM projects p LEFT JOIN clients c ON p.client_id=c.id WHERE p.id=$1`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
}))

app.post('/api/projects', requireAdmin, asyncHandler(async (req, res) => {
  const { client_id, name, description, status, type, total_value, start_date, end_date, notes } = req.body
  if (!name) return res.status(400).json({ error: 'name required' })
  const id = uuid()
  const { rows } = await pool.query(
    `INSERT INTO projects (id,client_id,name,description,status,type,total_value,start_date,end_date,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [id, client_id||null, name, description||null, status||'active', type||'fixed',
     total_value||null, start_date||null, end_date||null, notes||null]
  )
  res.status(201).json(rows[0])
}))

app.patch('/api/projects/:id', requireAdmin, asyncHandler(async (req, res) => {
  const allowed = ['client_id','name','description','status','type','total_value','start_date','end_date','notes']
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k))
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' })
  const fields = updates.map(([k], i) => `${k}=$${i+2}`).join(',')
  const { rows } = await pool.query(
    `UPDATE projects SET ${fields}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...updates.map(([,v]) => v)]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
}))

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — INVOICES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/invoices', requireAdmin, asyncHandler(async (req, res) => {
  const { client_id, status } = req.query
  let q = `SELECT i.*, c.name as client_name, c.email as client_email
           FROM invoices i LEFT JOIN clients c ON i.client_id=c.id WHERE 1=1`
  const vals = []
  if (client_id) { vals.push(client_id); q += ` AND i.client_id=$${vals.length}` }
  if (status)    { vals.push(status);    q += ` AND i.status=$${vals.length}` }
  const { rows } = await pool.query(q + ` ORDER BY i.created_at DESC`, vals)
  res.json(rows)
}))

app.get('/api/invoices/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.*, c.name as client_name, c.email as client_email
     FROM invoices i LEFT JOIN clients c ON i.client_id=c.id WHERE i.id=$1`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  const { rows: lineItems } = await pool.query(
    `SELECT * FROM invoice_line_items WHERE invoice_id=$1 ORDER BY sort_order`, [req.params.id]
  )
  res.json({ ...rows[0], line_items: lineItems })
}))

app.post('/api/invoices', requireAdmin, asyncHandler(async (req, res) => {
  const { client_id, project_id, line_items = [], due_date, notes, tax_rate = 0, currency = 'usd', account_id = 'bauersoft' } = req.body
  if (!client_id) return res.status(400).json({ error: 'client_id required' })
  if (!line_items.length) return res.status(400).json({ error: 'At least one line item required' })

  // Validate + compute line items
  for (const li of line_items) {
    const qty   = parseFloat(li.quantity || 1)
    const price = parseFloat(li.unit_price)
    if (!li.description?.trim()) return res.status(400).json({ error: 'Each line item needs a description' })
    if (isNaN(price) || price < 0) return res.status(400).json({ error: 'unit_price must be a non-negative number' })
    if (isNaN(qty)   || qty  <= 0) return res.status(400).json({ error: 'quantity must be greater than zero' })
  }
  const enrichedItems = line_items.map(li => ({
    ...li,
    amount: +(parseFloat(li.quantity || 1) * parseFloat(li.unit_price)).toFixed(2)
  }))
  const totals = calcTotals(enrichedItems, tax_rate)
  const invoiceNumber = await nextInvoiceNumber(account_id)

  const id = uuid()
  const client = await pool.connect()
  let invoice
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `INSERT INTO invoices (id,account_id,invoice_number,client_id,project_id,currency,subtotal,tax_rate,tax_amount,total,due_date,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, account_id, invoiceNumber, client_id, project_id||null, currency,
       totals.subtotal, tax_rate, totals.tax_amount, totals.total, due_date||null, notes||null]
    )
    invoice = rows[0]
    for (let i = 0; i < enrichedItems.length; i++) {
      const li = enrichedItems[i]
      await client.query(
        `INSERT INTO invoice_line_items (id,invoice_id,description,quantity,unit_price,amount,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuid(), id, li.description, li.quantity||1, li.unit_price, li.amount, i]
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  res.status(201).json({ ...invoice, line_items: enrichedItems })
}))

app.patch('/api/invoices/:id', requireAdmin, asyncHandler(async (req, res) => {
  // 'status' intentionally excluded — use /mark-paid or /send to transition status
  const allowed = ['due_date','notes','currency']
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k))
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' })
  const fields = updates.map(([k], i) => `${k}=$${i+2}`).join(',')
  const { rows } = await pool.query(
    `UPDATE invoices SET ${fields}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...updates.map(([,v]) => v)]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
}))

// Send invoice — creates Stripe payment link + emails client
app.post('/api/invoices/:id/send', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.*, c.name as client_name, c.email as client_email
     FROM invoices i LEFT JOIN clients c ON i.client_id=c.id WHERE i.id=$1`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  const invoice = rows[0]

  if (['paid', 'void'].includes(invoice.status)) {
    return res.status(409).json({ error: `Cannot send invoice with status '${invoice.status}'` })
  }

  const { rows: lineItems } = await pool.query(
    `SELECT * FROM invoice_line_items WHERE invoice_id=$1 ORDER BY sort_order`, [req.params.id]
  )

  // Create Stripe Checkout Session — supports both ACH (0.8% capped $5) and card
  // New session per send so the link is always fresh
  let paymentUrl = null
  if (stripe) {
    // Ensure client exists in Stripe (for ACH, Stripe needs a Customer object)
    let stripeCustomerId = invoice.stripe_customer_id
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        name: invoice.client_name,
        email: invoice.client_email,
        metadata: { client_id: invoice.client_id },
      })
      stripeCustomerId = customer.id
      await pool.query(`UPDATE clients SET stripe_customer_id=$1 WHERE id=$2`, [stripeCustomerId, invoice.client_id])
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      payment_method_types: ['us_bank_account', 'card'], // ACH first — cheaper, then card fallback
      line_items: [{
        price_data: {
          currency: invoice.currency || 'usd',
          product_data: { name: `Invoice ${invoice.invoice_number} — BauerSoft` },
          unit_amount: Math.round(parseFloat(invoice.total) * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: { invoice_id: invoice.id, invoice_number: invoice.invoice_number },
      success_url: `${process.env.APP_URL || 'https://billing.bauersoft.io'}/paid?inv=${invoice.invoice_number}`,
      cancel_url: `${process.env.APP_URL || 'https://billing.bauersoft.io'}/invoices`,
      payment_intent_data: {
        metadata: { invoice_id: invoice.id, invoice_number: invoice.invoice_number },
      },
    })
    paymentUrl = session.url
    await pool.query(
      `UPDATE invoices SET stripe_payment_link_url=$1, status='sent', updated_at=NOW() WHERE id=$2`,
      [session.url, invoice.id]
    )
  }

  // Email the client
  await sendEmail({
    to: invoice.client_email,
    subject: `Invoice ${invoice.invoice_number} from BauerSoft — $${parseFloat(invoice.total).toFixed(2)} due`,
    html: invoiceEmailHtml(invoice, lineItems, paymentUrl),
    text: `Invoice ${invoice.invoice_number}: $${invoice.total} due. Pay here: ${paymentUrl}`,
  })

  res.json({ ok: true, payment_link: paymentUrl, invoice_number: invoice.invoice_number, emailed_to: invoice.client_email })
}))

// Manual mark-paid (cash / bank transfer)
app.post('/api/invoices/:id/mark-paid', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE invoices SET status='paid', paid_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
}))

// Void — cancels a sent invoice that won't be paid
app.post('/api/invoices/:id/void', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE invoices SET status='void', updated_at=NOW() WHERE id=$1 AND status NOT IN ('paid','void') RETURNING *`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(409).json({ error: 'Invoice not found, already paid, or already voided' })
  res.json(rows[0])
}))

app.delete('/api/invoices/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT status FROM invoices WHERE id=$1`, [req.params.id])
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  if (['paid', 'void'].includes(rows[0].status)) {
    return res.status(409).json({ error: `Cannot delete a ${rows[0].status} invoice` })
  }
  await pool.query(`DELETE FROM invoices WHERE id=$1`, [req.params.id])
  res.json({ ok: true })
}))

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event
  try {
    event = stripe?.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  try {
    if (['checkout.session.completed', 'payment_intent.succeeded', 'payment_link.completed'].includes(event.type)) {
      const obj = event.data.object
      const invoiceId = obj.metadata?.invoice_id
      if (invoiceId) {
        await pool.query(
          `UPDATE invoices SET status='paid', paid_at=NOW(), stripe_payment_intent_id=$1, updated_at=NOW() WHERE id=$2`,
          [obj.id, invoiceId]
        )

        // Get invoice + client details to send confirmation
        const { rows } = await pool.query(
          `SELECT i.invoice_number, c.name, c.email FROM invoices i LEFT JOIN clients c ON i.client_id=c.id WHERE i.id=$1`,
          [invoiceId]
        )
        if (rows[0]) {
          await sendEmail({
            to: rows[0].email,
            subject: `Payment received — Invoice ${rows[0].invoice_number}`,
            html: `<p>Hi ${escHtml(rows[0].name) || 'there'}, your payment for Invoice ${escHtml(rows[0].invoice_number)} has been received. Thank you.</p><p style="color:#666;font-size:0.85em">BauerSoft</p>`,
            text: `Payment received for Invoice ${rows[0].invoice_number}. Thank you.`,
          })
        }
      }
    }
  } catch (err) {
    console.error('[Stripe webhook] handler error:', err.message || err)
    // Still return 200 — we received the event, internal error is our problem not Stripe's
  }

  res.json({ received: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT FORM (public)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/contact', contactLimiter, asyncHandler(async (req, res) => {
  const { name, email, message, source } = req.body
  if (!message) return res.status(400).json({ error: 'message required' })

  const id = uuid()
  await pool.query(
    `INSERT INTO contacts (id,name,email,message,source) VALUES ($1,$2,$3,$4,$5)`,
    [id, name||null, email||null, message, source||'website']
  )

  // Notify Jack
  await sendEmail({
    to: process.env.ADMIN_EMAIL || 'jackcbauerle@gmail.com',
    subject: `New contact from bauersoft.io${name ? ` — ${name}` : ''}`,
    html: `<p><strong>Name:</strong> ${escHtml(name) || 'Unknown'}<br><strong>Email:</strong> ${escHtml(email) || 'Not provided'}</p><p>${escHtml(message)}</p>`,
    text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
  })

  res.json({ ok: true })
}))

app.get('/api/contacts', requireAdmin, asyncHandler(async (req, res) => {
  const { status } = req.query
  const vals = []
  let q = `SELECT * FROM contacts WHERE 1=1`
  if (status) { vals.push(status); q += ` AND status=$1` }
  const { rows } = await pool.query(q + ` ORDER BY created_at DESC`, vals)
  res.json(rows)
}))

app.patch('/api/contacts/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { status } = req.body
  const valid = ['new', 'read', 'resolved']
  if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` })
  const { rows } = await pool.query(
    `UPDATE contacts SET status=$1 WHERE id=$2 RETURNING *`, [status, req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
}))

// ─────────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAdmin, asyncHandler(async (req, res) => {
  const accountId = req.query.account_id || 'bauersoft'
  const [clients, invoices, contacts] = await Promise.all([
    pool.query(`SELECT COUNT(*) as total FROM clients WHERE account_id=$1`, [accountId]),
    pool.query(`SELECT status, COUNT(*) as count, COALESCE(SUM(total),0) as amount FROM invoices WHERE account_id=$1 GROUP BY status`, [accountId]),
    pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='new') as unread FROM contacts WHERE account_id=$1`, [accountId]),
  ])
  const inv = {}
  invoices.rows.forEach(r => { inv[r.status] = { count: +r.count, amount: +r.amount } })
  res.json({
    clients:     +clients.rows[0].total,
    invoices:    inv,
    contacts:    { total: +contacts.rows[0].total, unread: +contacts.rows[0].unread },
    revenue:     { paid: inv.paid?.amount || 0, outstanding: (inv.sent?.amount || 0) + (inv.overdue?.amount || 0) },
  })
}))

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT PORTAL API
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/portal/invoices — client's own invoices (single query, no double round-trip)
app.get('/api/portal/invoices', requireClient, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      c.id as client_id, c.name as client_name, c.email as client_email,
      c.company as client_company,
      i.id, i.invoice_number, i.status, i.total, i.currency, i.due_date,
      i.paid_at, i.stripe_payment_link_url, i.created_at, i.notes,
      json_agg(li.* ORDER BY li.sort_order) FILTER (WHERE li.id IS NOT NULL) AS line_items
    FROM clients c
    LEFT JOIN invoices i ON i.client_id = c.id AND i.status NOT IN ('draft', 'void')
    LEFT JOIN invoice_line_items li ON li.invoice_id = i.id
    WHERE c.id = $1
    GROUP BY c.id, i.id
    ORDER BY i.created_at DESC NULLS LAST
  `, [req.clientId])

  // First row always has client info, even if no invoices
  const client = rows[0]
    ? { id: rows[0].client_id, name: rows[0].client_name, email: rows[0].client_email, company: rows[0].client_company }
    : null
  const invoices = rows.filter(r => r.id).map(r => {
    const { client_id, client_name, client_email, client_company, ...inv } = r
    return inv
  })

  res.json({ client, invoices })
}))

// GET /api/portal/invoices/:id — single invoice with line items
app.get('/api/portal/invoices/:id', requireClient, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT i.*,
           json_agg(li.* ORDER BY li.sort_order) FILTER (WHERE li.id IS NOT NULL) AS line_items
    FROM invoices i
    LEFT JOIN invoice_line_items li ON li.invoice_id = i.id
    WHERE i.id = $1 AND i.client_id = $2 AND i.status NOT IN ('draft', 'void')
    GROUP BY i.id
  `, [req.params.id, req.clientId])
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
}))

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL ERROR HANDLER
// ─────────────────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Error]', req.method, req.path, err.message || err)
  if (res.headersSent) return next(err)
  const status = err.status || err.statusCode || 500
  res.status(status).json({ error: err.message || 'Internal server error' })
})

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────
initDb()
  .then(() => app.listen(PORT, () => console.log(`BauerSoft Billing running on :${PORT}`)))
  .catch(err => { console.error('Init failed:', err); process.exit(1) })
