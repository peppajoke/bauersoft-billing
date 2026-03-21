# BauerSoft Billing API

Backend for `billing.bauersoft.io`. Handles clients, projects, invoices, Stripe payment links, and contact form submissions.

## API Reference

All admin endpoints require `x-api-key` header.

### Stats
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/stats` | Dashboard summary — revenue, outstanding, client count |

### Clients
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/clients` | List all clients |
| GET | `/api/clients/:id` | Get client |
| POST | `/api/clients` | Create client |
| PATCH | `/api/clients/:id` | Update client |
| DELETE | `/api/clients/:id` | Delete client |

### Projects
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/projects` | List projects (`?client_id=&status=`) |
| GET | `/api/projects/:id` | Get project |
| POST | `/api/projects` | Create project |
| PATCH | `/api/projects/:id` | Update project |

### Invoices
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/invoices` | List invoices (`?client_id=&status=`) |
| GET | `/api/invoices/:id` | Get invoice with line items |
| POST | `/api/invoices` | Create invoice with line items |
| PATCH | `/api/invoices/:id` | Update invoice (status, due_date, notes) |
| POST | `/api/invoices/:id/send` | Generate Stripe payment link + mark sent |
| POST | `/api/invoices/:id/mark-paid` | Manually mark paid (cash/bank) |

### Contacts
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/contact` | **Public** — contact form submission |
| GET | `/api/contacts` | List contacts (`?status=new`) |
| PATCH | `/api/contacts/:id` | Update contact status |

### Webhooks
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/webhooks/stripe` | Stripe webhook — auto-marks invoices paid |

## Deploy

1. Create Railway service, point to this repo
2. Add env vars from `.env.example`
3. Add custom domain `billing.bauersoft.io` in Railway
4. Add CNAME record in DNS: `billing` → Railway domain

## TODO (pending Jack's answers)
- [ ] Email delivery (invoice PDFs, contact notifications)
- [ ] Invoice PDF generation
- [ ] Client-facing payment portal (if needed)
- [ ] Rate limiting on `/api/contact`
