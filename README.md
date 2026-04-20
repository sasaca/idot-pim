# iDOT Product Information Management

A full-stack Master Data Management (MDM) platform for Vendor, Customer, and Product data, with configurable approval workflows, segregation of duties, conditional compliance branches (LATAM, EU, SOX, GxP), and agent-assisted document validation.

Built as a generic MDM SaaS — no ServiceNow coupling, no client-specific references.

---

## 1. Tech stack

| Layer       | Choice |
|-------------|--------|
| Runtime     | Node.js 18+ |
| Web         | Express 4 + EJS server-rendered views |
| Database    | `better-sqlite3` (single-file, zero-config) |
| Sessions    | `express-session` (dev secret, swap for prod) |
| Uploads     | `multer` (local disk under `uploads_store/`) |
| UI          | Tailwind via CDN + Chart.js 4 |
| Testability | Pure Node modules, no bundler |

---

## 2. Quick start

```bash
cd idot-pim
npm install                    # install dependencies
npm run seed                   # create + seed SQLite DB (db/idot.sqlite)
npm start                      # boot on http://localhost:3000
```

To reset the DB: `npm run reset`.

---

## 3. Demo accounts (password: any — demo login by email)

| Role                | Email |
|---------------------|-------|
| BU Requestor        | `buyer@demo.com` |
| Supply Chain        | `sc@demo.com` |
| Master Admin        | `admin@demo.com` |
| Legal               | `legal@demo.com` |
| Supplier self-serve | `supplier@demo.com` |
| Customer Service    | `cs@demo.com` |
| MDM Team            | `mdm1@demo.com` / `mdm2@demo.com` |
| Quality Regulatory  | `quality@demo.com` |
| Corp Security       | `corpsec@demo.com` |
| Credit Management   | `credit@demo.com` |
| Financial Mgmt.     | `finmgmt@demo.com` |
| Master Data Supervisor | `supervisor@demo.com` |
| Sales               | `sales@demo.com` |

Use `mdm2@demo.com` to approve an MDM request raised by `mdm1@demo.com` — the segregation-of-duties engine will block `mdm1` from approving their own request.

---

## 4. Domain model

Three master-data domains, each with its own list / detail / new / update views:

- **Vendor**: `/vendors` — onboarding, one-time, bank update, terms update, deactivation, reactivation.
- **Customer**: `/customers` — partner-function wizard (SP/SH/BP/PY), extension, block, reactivate, modify (typed by change_type).
- **Product**: `/products` — create + update with classification and plant/procurement.

Cross-cutting:

- **Requests**: `/requests` — every change is a workflow request with status, SLA, timeline, comments, compliance checks, and reason codes.
- **Portal**: `/portal` — external supplier / customer self-service.
- **Dashboard**: `/` — KPIs + open tasks.
- **Reports**: `/reports` — doughnut / bar / horizontal charts; SLA breaches; byAssignee.
- **Admin**: `/admin` — reference data and users.

---

## 5. Customer Master — BRD implementation

### Partner functions
The onboarding wizard asks two yes/no questions and routes into one of four record configurations:

| Answer                                 | Records to create                |
|----------------------------------------|----------------------------------|
| All four roles same                    | 1 — End-to-End (SP/SH/BP/PY)     |
| Sold-To = Ship-To; Bill-To = Payer     | 2 — (SP+SH), (BP+PY)             |
| Sold-To ≠ Ship-To; Bill-To = Payer     | 3 — SP, SH, (BP+PY)              |
| Sold-To = Ship-To; Bill-To ≠ Payer     | 3 — (SP+SH), BP, PY              |
| All four different                     | 4 — SP, SH, BP, PY               |

Each tab exposes `name_1..4`, full address, tax ID, VAT/GST, contact. A **Copy from** dropdown duplicates one partner's fields into another. An **invoice preview pane** renders the four address blocks live as you type.

### Workflows (context-aware)

The workflow engine filters conditional steps at request-creation time and on every advance. Key Customer flows:

- **ONBOARDING** — CS → MDM → Quality → **[Corp Security if LATAM]** → **[Credit if Sold-To]** → **[Finance if Sold-To/Payer]** → Sales → MDM Final → **[Supervisor if SOX fields touched]** → **[Finance EU Final if EU]** → ERP
- **CUSTOMER_EXTENSION** — Sales → MDM → Quality → Credit/Finance (conditional) → MDM → **[Supervisor SOX]** → ERP
- **CUSTOMER_BLOCK** — Requestor → MDM → **[Supervisor SOX]** → ERP
- **CUSTOMER_REACTIVATION** — Sales → MDM → **[Quality if Permanent]** → **[Credit if Permanent]** → Finance → MDM → ERP
- **CUSTOMER_UPDATE (Modify)** — Sales → MDM → **[Quality if NAME/ADDR/TAX_ID]** → **[Credit if PAYMENT_TERMS]** → **[Finance if PAYMENT_TERMS]** → Sales → MDM → **[Supervisor if SOX]** → ERP

Country classifications used by the predicates:

- **LATAM** (Corp Security review): AR, BO, BR, CL, CO, CR, CU, DO, EC, SV, GT, HT, HN, JM, MX, NI, PA, PY, PE, PR, TT, UY, VE
- **EU** (Finance final approval): AT, BE, CZ, DK, FI, FR, DE, GR, HU, IE, IT, LU, NL, NO, PL, PT, RO, ES, SE, CH, GB

### SOX-sensitive fields
Any change to `tax_id, credit_limit, payment_terms, bank_account, iban, legal_name, name_1..name_4` triggers the Supervisor SOX Review step. The Modify screen warns users inline when SOX is engaged.

### GxP-sensitive fields
`quality_class, gxp_flag, regulatory_market` — trigger Quality Regulatory review.

### Reason codes
Every Reject and Request-More-Info action surfaces a reason-code dropdown. Codes are derived from the BRD:

- QA_REJECT_UNSAT, CF_REJECT_UNSAT, MDM_REJECT_TYPE, MDM_REJECT_CUST, DUPLICATE, MK_DENIAL_HIT, POLICY_VIOLATION, OTHER
- QA_RMI_MISSING / INCORRECT / DATA, CF_RMI_MISSING / INCORRECT / DATA, MDM_RMI_APPROVAL / MISSING / INCORRECT / DATA_CUST / DATA_STD, OTHER

Codes are persisted in `workflow_steps.reason_code` and prepended to the comment so they surface in the timeline.

### Segregation of duties
The engine (`lib/workflow.js → advanceRequest`) enforces two rules and throws before any mutation:

1. A requestor cannot approve their own request.
2. An MDM-raised request must be approved by a different MDM team member.

---

## 6. Architecture

```
idot-pim/
├── server.js                    Express bootstrap, middleware, route mount
├── db/
│   ├── schema.sql               Full SQL schema (all tables)
│   ├── seed.js                  Deterministic seed with demo users + reference data
│   └── connection.js            better-sqlite3 singleton
├── lib/
│   └── workflow.js              Pure workflow engine — FLOWS, conditional steps,
│                                segregation of duties, reason codes, ERP stub
├── routes/                      Thin controllers per domain
│   ├── vendors.js / customers.js / products.js
│   ├── requests.js              Request list, detail, action (approve/reject/info)
│   ├── portal.js                Supplier/customer self-service
│   ├── reports.js / admin.js / dashboard.js / auth.js / api.js
├── views/                       EJS templates
│   ├── partials/                head, nav, topbar, footer
│   ├── vendors/ customers/ products/
│   ├── requests/                list, detail (with timeline + reason-code dropdowns)
│   ├── portal/ reports/ admin/
├── public/css/                  Custom utility classes (cards, chips, timeline)
└── uploads_store/               Multer target
```

### Workflow engine design

`lib/workflow.js` is the single source of truth for:

- `FLOWS[domain][requestType]` — array of `{name, role, optional?, condition?}` step defs.
- `getActiveFlow(domain, type, ctx)` — returns the flow filtered by each step's `condition(ctx)` predicate. Used both at `createRequest` (to set the first step) and at `advanceRequest` (so the step path stays consistent as payload changes).
- `advanceRequest(id, action, user, comment, reasonCode)` — advances, rejects, requests-info; enforces segregation of duties; logs reason codes; runs the ERP integration stub when the next step's role is `SYSTEM`.

### Data flow for a customer onboarding

1. CS user hits `/customers/new/onboarding`, fills partner tabs + commercial + compliance + sees live invoice.
2. POST `/customers/new/onboarding` → `wf.createRequest({domain:'CUSTOMER', requestType:'ONBOARDING', payload:{...}})`.
3. Engine filters flow by country / partner / SOX / EU, creates request row with the first step assigned and an SLA due date.
4. Each approver acts at `/requests/:id/action`; rejects/RMI require a reason code; approvals advance the step.
5. When the `SYSTEM` step is reached, the ERP integration stub fires, either synthesizing a new `CUS######` ID or moving the request to `ON_HOLD` with a support task.

---

## 7. Not yet implemented (roadmap)

- **Chatbot widget** for conversational data collection (BRD Section 4). The reference categories `REASON_REJECT`, `REASON_RMI`, `PARTNER_FUNCTION` etc. are seeded and ready for a future chat UI.
- **Agentic document validation** (BRD Section 5): PAN, W9, W8, VAT, GST extraction. Stubbed as compliance_checks today; plug in an OCR + LLM call later.
- **Real ERP connector** — currently a stochastic success/failure simulator in `lib/workflow.js → runErpIntegration`.
- **Multi-tenancy** — the schema supports it at the column level but there is no tenant scoping yet.

---

## 8. Verified behaviors (static tests)

Run `node -e '...'` against `lib/workflow.js` confirmed:

- LATAM onboarding inserts Corp Security step. ✓
- EU onboarding adds Finance EU Final Approval step. ✓
- US / Payer-only onboarding skips Corp Security and Credit (not Sold-To). ✓
- SOX-sensitive onboarding (non-empty tax_id) inserts Supervisor SOX Review. ✓
- CUSTOMER_UPDATE with change_type=PAYMENT_TERMS routes through Credit + Finance + Supervisor. ✓
- CUSTOMER_BLOCK — 3-step fast path. ✓
- CUSTOMER_REACTIVATION (Permanent) — full Quality/Credit/Finance chain. ✓
- CUSTOMER_REACTIVATION (Temporal) — Quality + Credit skipped. ✓

---

## 9. Commands cheatsheet

```bash
npm install             # install deps
npm run seed            # seed DB
npm run reset           # drop + reseed
npm start               # run server on :3000
```

Open the app at `http://localhost:3000` and sign in with any demo email above.
