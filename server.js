/**
 * BauerSoft Billing
 * One app, two portals:
 *   - /admin/*  → Jack + Clea (JWT, env-var password)
 *   - /client/* → Clients (magic link email auth)
 *   - /api/*    → Public or auth-gated API endpoints
 *
 * Deploy: billing.bauersoft.io on Railway
 */

const express    = require('express')
const cors       = require('cors')
const helmet     = require('helmet')
const jwt        = require('jsonwebtoken')
const { Pool }   = require('pg')
const Stripe     = require('stripe')
const { v4: uuid } = require('uuid')
const nodemailer = require('nodemailer')
const crypto     = require('crypto')

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
app.use(helmet({ contentSecurityPolicy: false }))
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
}))
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }))
app.use(express.json())

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
  if (payload?.role === 'admin') return next()
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL UNIQUE,
      company     TEXT,
      phone       TEXT,
      address     TEXT,
      notes       TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS magic_links (
      token       TEXT PRIMARY KEY,
      client_id   TEXT REFERENCES clients(id) ON DELETE CASCADE,
      expires_at  TIMESTAMPTZ NOT NULL,
      used        BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id           TEXT PRIMARY KEY,
      client_id    TEXT REFERENCES clients(id) ON DELETE SET NULL,
      name         TEXT NOT NULL,
      description  TEXT,
      status       TEXT DEFAULT 'active',
      type         TEXT DEFAULT 'fixed',
      total_value  NUMERIC(10,2),
      start_date   DATE,
      end_date     DATE,
      notes        TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id                       TEXT PRIMARY KEY,
      invoice_number           TEXT UNIQUE NOT NULL,
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
      stripe_payment_link_id   TEXT,
      stripe_payment_link_url  TEXT,
      stripe_payment_intent_id TEXT,
      notes                    TEXT,
      created_at               TIMESTAMPTZ DEFAULT NOW(),
      updated_at               TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id           TEXT PRIMARY KEY,
      invoice_id   TEXT REFERENCES invoices(id) ON DELETE CASCADE,
      description  TEXT NOT NULL,
      quantity     NUMERIC(10,2) DEFAULT 1,
      unit_price   NUMERIC(10,2) NOT NULL,
      amount       NUMERIC(10,2) NOT NULL,
      sort_order   INT DEFAULT 0
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id          TEXT PRIMARY KEY,
      name        TEXT,
      email       TEXT,
      message     TEXT NOT NULL,
      source      TEXT DEFAULT 'website',
      status      TEXT DEFAULT 'new',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  console.log('[DB] Schema ready')
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function nextInvoiceNumber() {
  const { rows } = await pool.query(`SELECT invoice_number FROM invoices ORDER BY created_at DESC LIMIT 100`)
  const nums = rows.map(r => parseInt(r.invoice_number.replace('INV-', '')) || 0)
  const next = nums.length ? Math.max(...nums) + 1 : 1
  return `INV-${String(next).padStart(4, '0')}`
}

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
    `<tr><td>${li.description}</td><td align="right">${li.quantity}</td><td align="right">$${parseFloat(li.unit_price).toFixed(2)}</td><td align="right">$${parseFloat(li.amount).toFixed(2)}</td></tr>`
  ).join('')

  return `
  <div style="font-family:sans-serif;max-width:600px;margin:auto;color:#111">
    <h2 style="color:#1a1a2e">Invoice ${invoice.invoice_number}</h2>
    <p>Hi ${invoice.client_name || 'there'},</p>
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

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, service: 'bauersoft-billing' }))

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN AUTH
// ─────────────────────────────────────────────────────────────────────────────

// Jack's browser login (returns JWT for admin dashboard)
app.post('/auth/admin/login', (req, res) => {
  const { password } = req.body
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' })
  }
  const token = signToken({ role: 'admin' }, '30d')
  res.json({ token })
})

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT AUTH (magic link)
// ─────────────────────────────────────────────────────────────────────────────

// Client requests login link — sends email
app.post('/auth/client/request', async (req, res) => {
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
        <p>Hi ${client.name || 'there'}, click below to access your invoices:</p>
        <p style="text-align:center;margin:24px 0">
          <a href="${loginUrl}" style="background:#4f46e5;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold">Log In</a>
        </p>
        <p style="color:#666;font-size:0.85em">This link expires in 24 hours. If you didn't request this, ignore this email.</p>
      </div>`,
  })

  res.json({ ok: true })
})

// Client verifies magic link token — returns JWT
app.post('/auth/client/verify', async (req, res) => {
  const { token } = req.body
  if (!token) return res.status(400).json({ error: 'token required' })

  const { rows } = await pool.query(
    `SELECT ml.*, c.email FROM magic_links ml JOIN clients c ON ml.client_id=c.id
     WHERE ml.token=$1 AND ml.used=FALSE AND ml.expires_at > NOW()`,
    [token]
  )
  if (!rows[0]) return res.status(401).json({ error: 'Invalid or expired link' })

  await pool.query(`UPDATE magic_links SET used=TRUE WHERE token=$1`, [token])

  const jwt = signToken({ clientId: rows[0].client_id, email: rows[0].email, role: 'client' }, '7d')
  res.json({ token: jwt, clientId: rows[0].client_id })
})

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT PORTAL
// ─────────────────────────────────────────────────────────────────────────────

// Client views their own invoices
app.get('/client/invoices', requireClient, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.id, i.invoice_number, i.status, i.total, i.currency, i.due_date, i.paid_at,
            i.stripe_payment_link_url, i.created_at
     FROM invoices i WHERE i.client_id=$1 ORDER BY i.created_at DESC`,
    [req.clientId]
  )
  res.json(rows)
})

// Client views a specific invoice with line items
app.get('/client/invoices/:id', requireClient, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.*, c.name as client_name FROM invoices i
     LEFT JOIN clients c ON i.client_id=c.id
     WHERE i.id=$1 AND i.client_id=$2`,
    [req.params.id, req.clientId]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  const { rows: lineItems } = await pool.query(
    `SELECT * FROM invoice_line_items WHERE invoice_id=$1 ORDER BY sort_order`,
    [req.params.id]
  )
  res.json({ ...rows[0], line_items: lineItems })
})

// Client gets their profile
app.get('/client/me', requireClient, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, company, phone FROM clients WHERE id=$1`,
    [req.clientId]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — CLIENTS
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/clients', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM clients ORDER BY name`)
  res.json(rows)
})

app.get('/api/clients/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM clients WHERE id=$1`, [req.params.id])
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

app.post('/api/clients', requireAdmin, async (req, res) => {
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
})

app.patch('/api/clients/:id', requireAdmin, async (req, res) => {
  const allowed = ['name','email','company','phone','address','notes']
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k))
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' })
  const fields = updates.map(([k], i) => `${k}=$${i+2}`).join(',')
  const { rows } = await pool.query(
    `UPDATE clients SET ${fields}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...updates.map(([,v]) => v)]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

app.delete('/api/clients/:id', requireAdmin, async (req, res) => {
  await pool.query(`DELETE FROM clients WHERE id=$1`, [req.params.id])
  res.json({ ok: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — PROJECTS
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/projects', requireAdmin, async (req, res) => {
  const { client_id, status } = req.query
  let q = `SELECT p.*, c.name as client_name FROM projects p LEFT JOIN clients c ON p.client_id=c.id WHERE 1=1`
  const vals = []
  if (client_id) { vals.push(client_id); q += ` AND p.client_id=$${vals.length}` }
  if (status)    { vals.push(status);    q += ` AND p.status=$${vals.length}` }
  const { rows } = await pool.query(q + ` ORDER BY p.created_at DESC`, vals)
  res.json(rows)
})

app.get('/api/projects/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, c.name as client_name FROM projects p LEFT JOIN clients c ON p.client_id=c.id WHERE p.id=$1`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

app.post('/api/projects', requireAdmin, async (req, res) => {
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
})

app.patch('/api/projects/:id', requireAdmin, async (req, res) => {
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
})

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — INVOICES
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/invoices', requireAdmin, async (req, res) => {
  const { client_id, status } = req.query
  let q = `SELECT i.*, c.name as client_name, c.email as client_email
           FROM invoices i LEFT JOIN clients c ON i.client_id=c.id WHERE 1=1`
  const vals = []
  if (client_id) { vals.push(client_id); q += ` AND i.client_id=$${vals.length}` }
  if (status)    { vals.push(status);    q += ` AND i.status=$${vals.length}` }
  const { rows } = await pool.query(q + ` ORDER BY i.created_at DESC`, vals)
  res.json(rows)
})

app.get('/api/invoices/:id', requireAdmin, async (req, res) => {
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
})

app.post('/api/invoices', requireAdmin, async (req, res) => {
  const { client_id, project_id, line_items = [], due_date, notes, tax_rate = 0, currency = 'usd' } = req.body
  if (!client_id) return res.status(400).json({ error: 'client_id required' })
  if (!line_items.length) return res.status(400).json({ error: 'At least one line item required' })

  // Compute amounts
  const enrichedItems = line_items.map(li => ({
    ...li,
    amount: +(parseFloat(li.quantity || 1) * parseFloat(li.unit_price)).toFixed(2)
  }))
  const totals = calcTotals(enrichedItems, tax_rate)
  const invoiceNumber = await nextInvoiceNumber()

  const id = uuid()
  const { rows } = await pool.query(
    `INSERT INTO invoices (id,invoice_number,client_id,project_id,currency,subtotal,tax_rate,tax_amount,total,due_date,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [id, invoiceNumber, client_id, project_id||null, currency,
     totals.subtotal, tax_rate, totals.tax_amount, totals.total, due_date||null, notes||null]
  )

  for (let i = 0; i < enrichedItems.length; i++) {
    const li = enrichedItems[i]
    await pool.query(
      `INSERT INTO invoice_line_items (id,invoice_id,description,quantity,unit_price,amount,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuid(), id, li.description, li.quantity||1, li.unit_price, li.amount, i]
    )
  }

  res.status(201).json({ ...rows[0], line_items: enrichedItems })
})

app.patch('/api/invoices/:id', requireAdmin, async (req, res) => {
  const allowed = ['status','due_date','notes','currency']
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k))
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' })
  const fields = updates.map(([k], i) => `${k}=$${i+2}`).join(',')
  const { rows } = await pool.query(
    `UPDATE invoices SET ${fields}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...updates.map(([,v]) => v)]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

// Send invoice — creates Stripe payment link + emails client
app.post('/api/invoices/:id/send', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.*, c.name as client_name, c.email as client_email
     FROM invoices i LEFT JOIN clients c ON i.client_id=c.id WHERE i.id=$1`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  const invoice = rows[0]

  const { rows: lineItems } = await pool.query(
    `SELECT * FROM invoice_line_items WHERE invoice_id=$1 ORDER BY sort_order`, [req.params.id]
  )

  // Create or reuse Stripe payment link
  let paymentUrl = invoice.stripe_payment_link_url
  if (!paymentUrl && stripe) {
    const price = await stripe.prices.create({
      unit_amount: Math.round(parseFloat(invoice.total) * 100),
      currency: invoice.currency || 'usd',
      product_data: { name: `Invoice ${invoice.invoice_number} — BauerSoft` },
    })
    const link = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: { invoice_id: invoice.id, invoice_number: invoice.invoice_number },
      after_completion: {
        type: 'redirect',
        redirect: { url: `${process.env.APP_URL || 'https://billing.bauersoft.io'}/paid?inv=${invoice.invoice_number}` },
      },
    })
    paymentUrl = link.url
    await pool.query(
      `UPDATE invoices SET stripe_payment_link_id=$1, stripe_payment_link_url=$2, status='sent', updated_at=NOW() WHERE id=$3`,
      [link.id, link.url, invoice.id]
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
})

// Manual mark-paid (cash / bank transfer)
app.post('/api/invoices/:id/mark-paid', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE invoices SET status='paid', paid_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

app.delete('/api/invoices/:id', requireAdmin, async (req, res) => {
  await pool.query(`DELETE FROM invoices WHERE id=$1`, [req.params.id])
  res.json({ ok: true })
})

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
          html: `<p>Hi ${rows[0].name || 'there'}, your payment for Invoice ${rows[0].invoice_number} has been received. Thank you.</p><p style="color:#666;font-size:0.85em">BauerSoft</p>`,
          text: `Payment received for Invoice ${rows[0].invoice_number}. Thank you.`,
        })
      }
    }
  }

  res.json({ received: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT FORM (public)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/contact', async (req, res) => {
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
    html: `<p><strong>Name:</strong> ${name || 'Unknown'}<br><strong>Email:</strong> ${email || 'Not provided'}</p><p>${message}</p>`,
    text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
  })

  res.json({ ok: true })
})

app.get('/api/contacts', requireAdmin, async (req, res) => {
  const { status } = req.query
  const vals = []
  let q = `SELECT * FROM contacts WHERE 1=1`
  if (status) { vals.push(status); q += ` AND status=$1` }
  const { rows } = await pool.query(q + ` ORDER BY created_at DESC`, vals)
  res.json(rows)
})

app.patch('/api/contacts/:id', requireAdmin, async (req, res) => {
  const { status } = req.body
  const { rows } = await pool.query(
    `UPDATE contacts SET status=$1 WHERE id=$2 RETURNING *`, [status, req.params.id]
  )
  res.json(rows[0])
})

// ─────────────────────────────────────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/stats', requireAdmin, async (req, res) => {
  const [clients, invoices, contacts] = await Promise.all([
    pool.query(`SELECT COUNT(*) as total FROM clients`),
    pool.query(`SELECT status, COUNT(*) as count, COALESCE(SUM(total),0) as amount FROM invoices GROUP BY status`),
    pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='new') as unread FROM contacts`),
  ])
  const inv = {}
  invoices.rows.forEach(r => { inv[r.status] = { count: +r.count, amount: +r.amount } })
  res.json({
    clients:     +clients.rows[0].total,
    invoices:    inv,
    contacts:    { total: +contacts.rows[0].total, unread: +contacts.rows[0].unread },
    revenue:     { paid: inv.paid?.amount || 0, outstanding: (inv.sent?.amount || 0) + (inv.overdue?.amount || 0) },
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────
initDb()
  .then(() => app.listen(PORT, () => console.log(`BauerSoft Billing running on :${PORT}`)))
  .catch(err => { console.error('Init failed:', err); process.exit(1) })
