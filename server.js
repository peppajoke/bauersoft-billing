/**
 * BauerSoft Billing API
 * Hosted at billing.bauersoft.io
 *
 * Auth: Jack-only dashboard (JWT). No client portal yet — invoices go out via email with Stripe payment links.
 * Stripe: payment links + webhooks for paid status
 * DB: Postgres (Railway)
 */

const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const { Pool } = require('pg')
const Stripe = require('stripe')
const { v4: uuid } = require('uuid')

require('dotenv').config()

const app = express()
const PORT = process.env.PORT || 3001

// ── DB ────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
})

// ── Stripe ────────────────────────────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY)

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet())
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }))

// Raw body needed for Stripe webhooks
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }))
app.use(express.json())

// ── Auth middleware (simple API key for now — Jack's dashboard only) ──────────
const requireAuth = (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.key
  if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// ── DB Init ───────────────────────────────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT,
      phone TEXT,
      address TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'active',   -- active | completed | paused | cancelled
      type TEXT DEFAULT 'fixed',      -- fixed | retainer | hourly
      total_value NUMERIC(10,2),
      start_date DATE,
      end_date DATE,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      invoice_number TEXT UNIQUE NOT NULL,
      client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'draft',    -- draft | sent | paid | overdue | cancelled
      currency TEXT DEFAULT 'usd',
      subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
      tax_rate NUMERIC(5,4) DEFAULT 0,
      tax_amount NUMERIC(10,2) DEFAULT 0,
      total NUMERIC(10,2) NOT NULL DEFAULT 0,
      due_date DATE,
      paid_at TIMESTAMPTZ,
      stripe_payment_link_id TEXT,
      stripe_payment_link_url TEXT,
      stripe_payment_intent_id TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_line_items (
      id TEXT PRIMARY KEY,
      invoice_id TEXT REFERENCES invoices(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity NUMERIC(10,2) DEFAULT 1,
      unit_price NUMERIC(10,2) NOT NULL,
      amount NUMERIC(10,2) NOT NULL,
      sort_order INT DEFAULT 0
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      message TEXT NOT NULL,
      source TEXT DEFAULT 'website',  -- website | referral | direct
      status TEXT DEFAULT 'new',      -- new | reviewed | converted | archived
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  console.log('[DB] Schema ready')
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function nextInvoiceNumber(existing) {
  // INV-0001, INV-0002, etc.
  const nums = existing.map(n => parseInt(n.replace('INV-', '')) || 0)
  const next = nums.length ? Math.max(...nums) + 1 : 1
  return `INV-${String(next).padStart(4, '0')}`
}

function recalcInvoice(lineItems, taxRate = 0) {
  const subtotal = lineItems.reduce((sum, li) => sum + parseFloat(li.amount), 0)
  const taxAmount = subtotal * taxRate
  return {
    subtotal: subtotal.toFixed(2),
    tax_amount: taxAmount.toFixed(2),
    total: (subtotal + taxAmount).toFixed(2),
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, service: 'bauersoft-billing' }))

// ── Clients ───────────────────────────────────────────────────────────────────

app.get('/api/clients', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM clients ORDER BY name ASC`)
  res.json(rows)
})

app.get('/api/clients/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM clients WHERE id=$1`, [req.params.id])
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

app.post('/api/clients', requireAuth, async (req, res) => {
  const { name, email, company, phone, address, notes } = req.body
  if (!name || !email) return res.status(400).json({ error: 'name and email required' })
  const id = uuid()
  const { rows } = await pool.query(
    `INSERT INTO clients (id, name, email, company, phone, address, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, name, email, company || null, phone || null, address || null, notes || null]
  )
  res.status(201).json(rows[0])
})

app.patch('/api/clients/:id', requireAuth, async (req, res) => {
  const allowed = ['name','email','company','phone','address','notes']
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k))
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' })
  const fields = updates.map(([k], i) => `${k}=$${i + 2}`).join(',')
  const vals = updates.map(([, v]) => v)
  const { rows } = await pool.query(
    `UPDATE clients SET ${fields}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...vals]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  await pool.query(`DELETE FROM clients WHERE id=$1`, [req.params.id])
  res.json({ ok: true })
})

// ── Projects ──────────────────────────────────────────────────────────────────

app.get('/api/projects', requireAuth, async (req, res) => {
  const { client_id, status } = req.query
  let q = `SELECT p.*, c.name as client_name FROM projects p LEFT JOIN clients c ON p.client_id=c.id WHERE 1=1`
  const vals = []
  if (client_id) { vals.push(client_id); q += ` AND p.client_id=$${vals.length}` }
  if (status)    { vals.push(status);    q += ` AND p.status=$${vals.length}` }
  q += ` ORDER BY p.created_at DESC`
  const { rows } = await pool.query(q, vals)
  res.json(rows)
})

app.get('/api/projects/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, c.name as client_name FROM projects p LEFT JOIN clients c ON p.client_id=c.id WHERE p.id=$1`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

app.post('/api/projects', requireAuth, async (req, res) => {
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

app.patch('/api/projects/:id', requireAuth, async (req, res) => {
  const allowed = ['client_id','name','description','status','type','total_value','start_date','end_date','notes']
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k))
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' })
  const fields = updates.map(([k], i) => `${k}=$${i + 2}`).join(',')
  const vals = updates.map(([, v]) => v)
  const { rows } = await pool.query(
    `UPDATE projects SET ${fields}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...vals]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

// ── Invoices ──────────────────────────────────────────────────────────────────

app.get('/api/invoices', requireAuth, async (req, res) => {
  const { client_id, status } = req.query
  let q = `SELECT i.*, c.name as client_name, c.email as client_email
           FROM invoices i LEFT JOIN clients c ON i.client_id=c.id WHERE 1=1`
  const vals = []
  if (client_id) { vals.push(client_id); q += ` AND i.client_id=$${vals.length}` }
  if (status)    { vals.push(status);    q += ` AND i.status=$${vals.length}` }
  q += ` ORDER BY i.created_at DESC`
  const { rows } = await pool.query(q, vals)
  res.json(rows)
})

app.get('/api/invoices/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.*, c.name as client_name, c.email as client_email
     FROM invoices i LEFT JOIN clients c ON i.client_id=c.id WHERE i.id=$1`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  const { rows: lineItems } = await pool.query(
    `SELECT * FROM invoice_line_items WHERE invoice_id=$1 ORDER BY sort_order ASC`,
    [req.params.id]
  )
  res.json({ ...rows[0], line_items: lineItems })
})

app.post('/api/invoices', requireAuth, async (req, res) => {
  const { client_id, project_id, line_items = [], due_date, notes, tax_rate = 0, currency = 'usd' } = req.body
  if (!client_id) return res.status(400).json({ error: 'client_id required' })
  if (!line_items.length) return res.status(400).json({ error: 'At least one line item required' })

  const { rows: existing } = await pool.query(`SELECT invoice_number FROM invoices ORDER BY created_at DESC`)
  const invoiceNumber = nextInvoiceNumber(existing.map(r => r.invoice_number))
  const totals = recalcInvoice(line_items, parseFloat(tax_rate))

  const id = uuid()
  const { rows } = await pool.query(
    `INSERT INTO invoices (id,invoice_number,client_id,project_id,currency,subtotal,tax_rate,tax_amount,total,due_date,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [id, invoiceNumber, client_id, project_id||null, currency, totals.subtotal, tax_rate,
     totals.tax_amount, totals.total, due_date||null, notes||null]
  )

  // Insert line items
  for (let i = 0; i < line_items.length; i++) {
    const li = line_items[i]
    const amount = (parseFloat(li.quantity || 1) * parseFloat(li.unit_price)).toFixed(2)
    await pool.query(
      `INSERT INTO invoice_line_items (id,invoice_id,description,quantity,unit_price,amount,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuid(), id, li.description, li.quantity || 1, li.unit_price, amount, i]
    )
  }

  res.status(201).json({ ...rows[0], line_items })
})

app.patch('/api/invoices/:id', requireAuth, async (req, res) => {
  const allowed = ['status','due_date','notes','currency']
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k))
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' })
  const fields = updates.map(([k], i) => `${k}=$${i + 2}`).join(',')
  const vals = updates.map(([, v]) => v)
  const { rows } = await pool.query(
    `UPDATE invoices SET ${fields}, updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id, ...vals]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

// Send invoice — generates Stripe payment link and emails client
app.post('/api/invoices/:id/send', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.*, c.name as client_name, c.email as client_email
     FROM invoices i LEFT JOIN clients c ON i.client_id=c.id WHERE i.id=$1`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  const invoice = rows[0]

  // Create Stripe payment link
  let paymentLinkUrl = invoice.stripe_payment_link_url
  if (!paymentLinkUrl && process.env.STRIPE_SECRET_KEY) {
    try {
      // Create a one-time price for this invoice
      const price = await stripe.prices.create({
        unit_amount: Math.round(parseFloat(invoice.total) * 100),
        currency: invoice.currency || 'usd',
        product_data: {
          name: `Invoice ${invoice.invoice_number} — BauerSoft`,
        },
      })
      const link = await stripe.paymentLinks.create({
        line_items: [{ price: price.id, quantity: 1 }],
        metadata: { invoice_id: invoice.id, invoice_number: invoice.invoice_number },
        after_completion: { type: 'redirect', redirect: { url: `${process.env.APP_URL || 'https://billing.bauersoft.io'}/paid` } },
      })
      paymentLinkUrl = link.url
      await pool.query(
        `UPDATE invoices SET stripe_payment_link_id=$1, stripe_payment_link_url=$2, status='sent', updated_at=NOW() WHERE id=$3`,
        [link.id, link.url, invoice.id]
      )
    } catch (err) {
      console.error('[Stripe]', err.message)
      return res.status(500).json({ error: 'Stripe payment link creation failed', detail: err.message })
    }
  }

  // TODO: email the client via nodemailer / GOG Gmail
  // For now, return the payment link for manual sending
  res.json({ ok: true, payment_link: paymentLinkUrl, invoice_number: invoice.invoice_number })
})

// Mark paid manually (for cash/bank transfers)
app.post('/api/invoices/:id/mark-paid', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE invoices SET status='paid', paid_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`,
    [req.params.id]
  )
  if (!rows[0]) return res.status(404).json({ error: 'Not found' })
  res.json(rows[0])
})

// ── Stripe Webhook ────────────────────────────────────────────────────────────
app.post('/api/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` })
  }

  if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
    const obj = event.data.object
    const invoiceId = obj.metadata?.invoice_id
    if (invoiceId) {
      await pool.query(
        `UPDATE invoices SET status='paid', paid_at=NOW(), stripe_payment_intent_id=$1, updated_at=NOW() WHERE id=$2`,
        [obj.id, invoiceId]
      )
      console.log(`[Stripe] Invoice ${invoiceId} marked paid`)
    }
  }

  res.json({ received: true })
})

// ── Contact form (public — no auth) ──────────────────────────────────────────
app.post('/api/contact', async (req, res) => {
  const { name, email, message, source } = req.body
  if (!message) return res.status(400).json({ error: 'message required' })

  // Rate limit placeholder — add redis or DB-based rate limiting before going live
  const id = uuid()
  await pool.query(
    `INSERT INTO contacts (id,name,email,message,source) VALUES ($1,$2,$3,$4,$5)`,
    [id, name||null, email||null, message, source||'website']
  )

  // TODO: notify Jack via email/Discord
  // For now logged to DB — wire up notification in next pass

  res.json({ ok: true, id })
})

app.get('/api/contacts', requireAuth, async (req, res) => {
  const { status } = req.query
  let q = `SELECT * FROM contacts WHERE 1=1`
  const vals = []
  if (status) { vals.push(status); q += ` AND status=$${vals.length}` }
  q += ` ORDER BY created_at DESC`
  const { rows } = await pool.query(q, vals)
  res.json(rows)
})

app.patch('/api/contacts/:id', requireAuth, async (req, res) => {
  const { status } = req.body
  const { rows } = await pool.query(
    `UPDATE contacts SET status=$1 WHERE id=$2 RETURNING *`,
    [status, req.params.id]
  )
  res.json(rows[0])
})

// ── Stats (dashboard summary) ─────────────────────────────────────────────────
app.get('/api/stats', requireAuth, async (req, res) => {
  const [clients, invoices, contacts] = await Promise.all([
    pool.query(`SELECT COUNT(*) as total FROM clients`),
    pool.query(`SELECT status, COUNT(*) as count, COALESCE(SUM(total),0) as amount FROM invoices GROUP BY status`),
    pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='new') as unread FROM contacts`),
  ])

  const invoiceStats = {}
  invoices.rows.forEach(r => { invoiceStats[r.status] = { count: parseInt(r.count), amount: parseFloat(r.amount) } })

  res.json({
    clients: parseInt(clients.rows[0].total),
    invoices: invoiceStats,
    contacts: {
      total: parseInt(contacts.rows[0].total),
      unread: parseInt(contacts.rows[0].unread),
    },
    revenue: {
      paid: invoiceStats.paid?.amount || 0,
      outstanding: (invoiceStats.sent?.amount || 0) + (invoiceStats.overdue?.amount || 0),
    },
  })
})

// ── Boot ──────────────────────────────────────────────────────────────────────
initDb()
  .then(() => app.listen(PORT, () => console.log(`BauerSoft Billing API running on :${PORT}`)))
  .catch(err => { console.error('Init failed:', err); process.exit(1) })
