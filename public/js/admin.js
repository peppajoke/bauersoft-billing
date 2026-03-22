const API = ''  // same origin
let token = localStorage.getItem('bs_admin_token')
let clients = [], projects = []

// ── Boot ──────────────────────────────────────────────────────────────────────
window.onload = () => {
  if (token) showApp()
  else showAuth()
}

function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden')
  document.getElementById('app-screen').classList.add('hidden')
  document.getElementById('auth-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin()
  })
}

function showApp() {
  document.getElementById('auth-screen').classList.add('hidden')
  document.getElementById('app-screen').classList.remove('hidden')
  loadAll()
  showSection('dashboard')
}

async function doLogin() {
  const pw = document.getElementById('auth-password').value
  const err = document.getElementById('auth-error')
  err.classList.add('hidden')
  try {
    const r = await fetch('/auth/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Invalid password')
    token = d.token
    localStorage.setItem('bs_admin_token', token)
    showApp()
  } catch(e) {
    err.textContent = e.message
    err.classList.remove('hidden')
  }
}

function logout() {
  localStorage.removeItem('bs_admin_token')
  token = null
  showAuth()
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  })
  if (r.status === 401) { logout(); return null }
  return r.json()
}

function fmt(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.className = `toast ${type}`
  t.classList.remove('hidden')
  setTimeout(() => t.classList.add('hidden'), 3000)
}

// ── Nav ───────────────────────────────────────────────────────────────────────
const sections = ['dashboard', 'clients', 'invoices', 'projects']
const titles = { dashboard: 'Dashboard', clients: 'Clients', invoices: 'Invoices', projects: 'Projects' }
const actions = { dashboard: '+ New Invoice', clients: '+ Add Client', invoices: '+ New Invoice', projects: '+ New Project' }

function showSection(name) {
  sections.forEach(s => {
    document.getElementById(`s-${s}`).classList.toggle('hidden', s !== name)
    document.getElementById(`nav-${s}`).classList.toggle('active', s === name)
  })
  document.getElementById('section-title').textContent = titles[name]
  document.getElementById('topbar-action').textContent = actions[name]
  if (name === 'dashboard') loadDashboard()
  if (name === 'clients')   renderClients()
  if (name === 'invoices')  loadInvoices()
  if (name === 'projects')  renderProjects()
}

function topbarAction() {
  const active = sections.find(s => !document.getElementById(`s-${s}`).classList.contains('hidden'))
  if (active === 'clients')  openClientModal()
  else if (active === 'projects') openProjectModal()
  else openInvoiceModal()
}

// ── Load all data ─────────────────────────────────────────────────────────────
async function loadAll() {
  const [c, p] = await Promise.all([api('/api/clients'), api('/api/projects')])
  clients  = c || []
  projects = p || []
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  const [invoices, c] = await Promise.all([api('/api/invoices'), api('/api/clients')])
  if (!invoices) return
  clients = c || []

  const outstanding = invoices.filter(i => i.status === 'sent').reduce((s, i) => s + +i.total, 0)
  const now = new Date()
  const paidThisMonth = invoices.filter(i => {
    if (i.status !== 'paid' || !i.paid_at) return false
    const d = new Date(i.paid_at)
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  }).reduce((s, i) => s + +i.total, 0)
  const open = invoices.filter(i => ['draft','sent'].includes(i.status)).length

  document.getElementById('stat-outstanding').textContent = fmt(outstanding)
  document.getElementById('stat-paid').textContent = fmt(paidThisMonth)
  document.getElementById('stat-open').textContent = open
  document.getElementById('stat-clients').textContent = clients.length

  const recent = [...invoices].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 8)
  const tbody = document.getElementById('recent-invoices-body')
  tbody.innerHTML = recent.length ? recent.map(inv => `
    <tr>
      <td><strong>${inv.invoice_number}</strong></td>
      <td>${inv.client_name || '—'}</td>
      <td>${fmt(inv.total)}</td>
      <td>${badge(inv.status)}</td>
      <td class="text-muted">${fmtDate(inv.due_date)}</td>
    </tr>
  `).join('') : '<tr><td colspan="5" class="empty">No invoices yet</td></tr>'
}

// ── Clients ───────────────────────────────────────────────────────────────────
function renderClients() {
  const tbody = document.getElementById('clients-body')
  tbody.innerHTML = clients.length ? clients.map(c => `
    <tr>
      <td><strong>${c.name}</strong></td>
      <td class="text-muted">${c.company || '—'}</td>
      <td>${c.email}</td>
      <td>
        <div class="gap-8">
          <button class="btn btn-ghost btn-sm" onclick="openClientModal('${c.id}')">Edit</button>
          <button class="btn btn-ghost btn-sm" onclick="sendMagicLink('${c.email}')">Magic Link</button>
        </div>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="4" class="empty">No clients yet</td></tr>'
}

function openClientModal(id) {
  const c = id ? clients.find(x => x.id === id) : null
  document.getElementById('client-modal-title').textContent = c ? 'Edit Client' : 'New Client'
  document.getElementById('client-id').value   = c?.id || ''
  document.getElementById('c-name').value      = c?.name || ''
  document.getElementById('c-email').value     = c?.email || ''
  document.getElementById('c-company').value   = c?.company || ''
  document.getElementById('c-phone').value     = c?.phone || ''
  document.getElementById('c-address').value   = c?.address || ''
  document.getElementById('c-notes').value     = c?.notes || ''
  document.getElementById('client-modal').classList.remove('hidden')
}

async function saveClient() {
  const id = document.getElementById('client-id').value
  const body = {
    name:    document.getElementById('c-name').value.trim(),
    email:   document.getElementById('c-email').value.trim(),
    company: document.getElementById('c-company').value.trim(),
    phone:   document.getElementById('c-phone').value.trim(),
    address: document.getElementById('c-address').value.trim(),
    notes:   document.getElementById('c-notes').value.trim(),
  }
  if (!body.name || !body.email) return toast('Name and email are required', 'error')
  const r = id
    ? await api(`/api/clients/${id}`, { method: 'PATCH', body })
    : await api('/api/clients', { method: 'POST', body })
  if (r?.error) return toast(r.error, 'error')
  toast(id ? 'Client updated' : 'Client created')
  closeModals()
  const c = await api('/api/clients')
  clients = c || []
  renderClients()
}

async function sendMagicLink(email) {
  const r = await api('/auth/client/request', { method: 'POST', body: { email } })
  if (r?.error) return toast(r.error, 'error')
  toast(`Magic link sent to ${email}`)
}

// ── Invoices ──────────────────────────────────────────────────────────────────
async function loadInvoices() {
  const inv = await api('/api/invoices')
  if (!inv) return
  const tbody = document.getElementById('invoices-body')
  tbody.innerHTML = inv.length ? inv.map(i => `
    <tr>
      <td><strong>${i.invoice_number}</strong></td>
      <td>${i.client_name || '—'}</td>
      <td>${fmt(i.total)}</td>
      <td>${badge(i.status)}</td>
      <td class="text-muted">${fmtDate(i.due_date)}</td>
      <td>
        <div class="gap-8">
          ${i.status === 'draft' ? `<button class="btn btn-primary btn-sm" onclick="sendInvoice('${i.id}')">Send</button>` : ''}
          ${i.status === 'sent'  ? `<button class="btn btn-ghost btn-sm" onclick="markPaid('${i.id}')">Mark Paid</button>` : ''}
          ${i.stripe_payment_link_url ? `<a href="${i.stripe_payment_link_url}" target="_blank" class="btn btn-ghost btn-sm">Pay Link</a>` : ''}
        </div>
      </td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="empty">No invoices yet</td></tr>'
}

function openInvoiceModal() {
  // Populate client select
  const sel = document.getElementById('inv-client')
  sel.innerHTML = '<option value="">Select client...</option>' +
    clients.map(c => `<option value="${c.id}">${c.name}${c.company ? ` (${c.company})` : ''}</option>`).join('')

  // Populate project select
  const psel = document.getElementById('inv-project')
  psel.innerHTML = '<option value="">None</option>' +
    projects.map(p => `<option value="${p.id}">${p.name}</option>`).join('')

  // Default due date = 30 days out
  const due = new Date(); due.setDate(due.getDate() + 30)
  document.getElementById('inv-due').value = due.toISOString().split('T')[0]

  // Clear line items
  document.getElementById('line-items-body').innerHTML = ''
  document.getElementById('inv-notes').value = 'Net 30. Payment via ACH or card.'
  document.getElementById('inv-tax').value = '0'
  addLineItem()

  document.getElementById('invoice-modal').classList.remove('hidden')
}

let lineCount = 0
function addLineItem() {
  lineCount++
  const n = lineCount
  const tr = document.createElement('tr')
  tr.id = `li-${n}`
  tr.innerHTML = `
    <td><input placeholder="Description" id="li-desc-${n}" oninput="calcTotal()" /></td>
    <td><input type="number" value="1" min="0.01" step="0.01" id="li-qty-${n}" style="width:60px" oninput="calcTotal()" /></td>
    <td><input type="number" placeholder="0.00" step="0.01" id="li-price-${n}" style="width:80px" oninput="calcTotal()" /></td>
    <td id="li-amt-${n}" style="font-weight:600;white-space:nowrap">$0.00</td>
    <td><button class="btn btn-danger btn-sm" onclick="removeLineItem(${n})">×</button></td>
  `
  document.getElementById('line-items-body').appendChild(tr)
}

function removeLineItem(n) {
  document.getElementById(`li-${n}`)?.remove()
  calcTotal()
}

function calcTotal() {
  const rows = document.getElementById('line-items-body').querySelectorAll('tr')
  let sub = 0
  rows.forEach(tr => {
    const n = tr.id.replace('li-', '')
    const qty   = parseFloat(document.getElementById(`li-qty-${n}`)?.value || 0)
    const price = parseFloat(document.getElementById(`li-price-${n}`)?.value || 0)
    const amt   = +(qty * price).toFixed(2)
    const amtEl = document.getElementById(`li-amt-${n}`)
    if (amtEl) amtEl.textContent = fmt(amt)
    sub += amt
  })
  const tax = parseFloat(document.getElementById('inv-tax').value || 0) / 100
  const total = +(sub * (1 + tax)).toFixed(2)
  document.getElementById('inv-total').textContent = fmt(total)
}

async function saveInvoice() {
  const clientId = document.getElementById('inv-client').value
  if (!clientId) return toast('Select a client', 'error')

  const rows = document.getElementById('line-items-body').querySelectorAll('tr')
  const line_items = []
  rows.forEach(tr => {
    const n     = tr.id.replace('li-', '')
    const desc  = document.getElementById(`li-desc-${n}`)?.value.trim()
    const qty   = parseFloat(document.getElementById(`li-qty-${n}`)?.value || 0)
    const price = parseFloat(document.getElementById(`li-price-${n}`)?.value || 0)
    if (desc && price > 0) line_items.push({ description: desc, quantity: qty, unit_price: price, amount: +(qty*price).toFixed(2) })
  })
  if (!line_items.length) return toast('Add at least one line item', 'error')

  const body = {
    client_id:  clientId,
    project_id: document.getElementById('inv-project').value || null,
    due_date:   document.getElementById('inv-due').value || null,
    tax_rate:   (parseFloat(document.getElementById('inv-tax').value || 0) / 100).toFixed(4),
    notes:      document.getElementById('inv-notes').value,
    line_items
  }
  const r = await api('/api/invoices', { method: 'POST', body })
  if (r?.error) return toast(r.error, 'error')
  toast('Invoice created')
  closeModals()
  loadInvoices()
}

async function sendInvoice(id) {
  const r = await api(`/api/invoices/${id}/send`, { method: 'POST' })
  if (r?.error) return toast(r.error, 'error')
  toast('Invoice sent')
  loadInvoices()
}

async function markPaid(id) {
  if (!confirm('Mark this invoice as paid?')) return
  const r = await api(`/api/invoices/${id}/mark-paid`, { method: 'POST' })
  if (r?.error) return toast(r.error, 'error')
  toast('Marked as paid')
  loadInvoices()
}

// ── Projects ──────────────────────────────────────────────────────────────────
function renderProjects() {
  const tbody = document.getElementById('projects-body')
  tbody.innerHTML = projects.length ? projects.map(p => `
    <tr>
      <td><strong>${p.name}</strong></td>
      <td class="text-muted">${p.client_name || '—'}</td>
      <td>${badge(p.status)}</td>
      <td>${p.total_value ? fmt(p.total_value) : '—'}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="openProjectModal('${p.id}')">Edit</button></td>
    </tr>
  `).join('') : '<tr><td colspan="5" class="empty">No projects yet</td></tr>'
}

function openProjectModal(id) {
  const p = id ? projects.find(x => x.id === id) : null
  const sel = document.getElementById('p-client')
  sel.innerHTML = '<option value="">None</option>' +
    clients.map(c => `<option value="${c.id}" ${p?.client_id === c.id ? 'selected' : ''}>${c.name}</option>`).join('')

  document.getElementById('proj-modal-title').textContent = p ? 'Edit Project' : 'New Project'
  document.getElementById('proj-id').value  = p?.id || ''
  document.getElementById('p-name').value   = p?.name || ''
  document.getElementById('p-type').value   = p?.type || 'fixed'
  document.getElementById('p-value').value  = p?.total_value || ''
  document.getElementById('p-start').value  = p?.start_date?.split('T')[0] || ''
  document.getElementById('p-end').value    = p?.end_date?.split('T')[0] || ''
  document.getElementById('p-desc').value   = p?.description || ''
  document.getElementById('project-modal').classList.remove('hidden')
}

async function saveProject() {
  const id = document.getElementById('proj-id').value
  const body = {
    name:        document.getElementById('p-name').value.trim(),
    client_id:   document.getElementById('p-client').value || null,
    type:        document.getElementById('p-type').value,
    total_value: parseFloat(document.getElementById('p-value').value) || null,
    start_date:  document.getElementById('p-start').value || null,
    end_date:    document.getElementById('p-end').value || null,
    description: document.getElementById('p-desc').value.trim(),
  }
  if (!body.name) return toast('Project name is required', 'error')
  const r = id
    ? await api(`/api/projects/${id}`, { method: 'PATCH', body })
    : await api('/api/projects', { method: 'POST', body })
  if (r?.error) return toast(r.error, 'error')
  toast(id ? 'Project updated' : 'Project created')
  closeModals()
  const p = await api('/api/projects')
  projects = p || []
  renderProjects()
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function badge(status) {
  return `<span class="badge badge-${status}">${status}</span>`
}

function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'))
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModals()
})
