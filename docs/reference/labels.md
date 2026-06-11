# Labels — the configurable taxonomy

> Generated from `board/lib/label-bundles.ts` by `scripts/gen-labels-doc.mjs`.
> Edit the bundle data there (or re-run the design workflow) and regenerate; do not hand-edit this file.

A **label** is a structured, catalog-backed category that organizes the demands flowing
onto the board — richer than the freeform `tags` string. It is the layer that cuts
through the noise: a manager filters to `approval-needed`, a release manager to `doc-chase`,
anyone to the universal `waiting-on`. Each label is:

```ts
{ id, title, description, color?, bundle?, domain? }
```

The **`description` is first-class** — it states *when the label applies*, so an AI agent
(or a human) can pick the right one. Labels are **personalizable**: you install only the
bundles that fit your role and life, add your own, and edit any of them — entirely from the
board UI. The active set lives in the store (`db.labels`) and is fetched over the API so
the agent skills assign valid labels and the filter reflects exactly what you use.

## Catalog at a glance

- **37 bundles** — 23 role, 13 life, 1 universal.
- **380 labels** (359 distinct ids; shared concepts reuse one id across bundles).
- Install a bundle and its labels union into your catalog (idempotent). Remove or rename any.
- Some labels are **shared across bundles by design** (one concept = one id, e.g. `onboarding`). When two
  bundles define the same id with a *different* meaning, the first install wins and the install **surfaces a
  conflict notice** — the existing definition is kept, not silently overwritten — so you can rename or edit it.

## How it works

**Data model** (`board/lib/types.ts`)
- `LabelDef` — a catalog entry. `db.labels: LabelDef[]` is the active catalog (versioned, backed up, lint-checked).
- `CaseRecord.labels: string[]` — the label ids assigned to a case.
- `LabelColor` — a fixed 12-colour palette so chips always render (Tailwind-safe map in `lib/format.ts`).
- **Bundles** (`board/lib/label-bundles.ts`) are static installable packs — `LABEL_BUNDLES`.

**API**
- `GET  /api/labels` — the active catalog. *This is what skills/agents fetch before a case write.*
- `POST /api/labels` — add a custom label (id minted from the title, de-duplicated).
- `PATCH/DELETE /api/labels/:id` — edit / remove a label (`?scrub=1` also strips it from every case).
- `GET  /api/labels/bundles` — the installable bundles (per-bundle `installedCount` + `ownedCount`).
- `POST /api/labels/bundles` — install a bundle's labels (idempotent; reports conflicts).
- `DELETE /api/labels/bundles/:id` — uninstall a bundle (remove the labels it owns; `?scrub=0` keeps case refs).
- **Case writes validate labels**: `POST/PATCH /api/cases` reject any label id not in the catalog with a
  `400` that names the unknown id(s) **and the valid set** — the anti-failure contract, so a skill that
  fetched the catalog first never silently drops a category.

**MCP (agent surface, `mcp/board-server`)**
- `list_labels` — fetch the catalog (id + title + description) before assigning.
- `list_label_bundles` / `install_label_bundle` / `uninstall_label_bundle` — discover, install, remove packs.
- `create_case` / `update_case` / `update_cases` take a `labels` array of catalog ids.

**UI (`board/components/board`)**
- **Card chips** — each case shows its labels (colour + title, description on hover); click a chip to filter.
- **Drawer picker** — assign/remove labels from a checklist that shows each label's description.
- **Filter dropdown** — a "Labels" dropdown with a precise **category selector** (your installed bundles,
  grouped) + search. Bundles are collapsible groups with a **tri-state select-all**, so you can filter by a
  whole bundle — or a *scope of several bundles* — in one click, or drill in to pick individual labels. Drives
  an OR facet; the active selection shows as removable chips. Plus *group by Label*.
- **Labels manager** — install bundles, add custom labels, edit titles/descriptions/colours, delete — all in-UI.

**Skills** — `second-brain-ingest` and the developer-platform skill call `list_labels` first, then assign
only returned ids (see each SKILL.md).

## Regenerate

```bash
# 1. (re)design the taxonomy — multi-agent workflow → JSON
#    (Workflow: design-label-taxonomy)
# 2. write it into board/lib/label-bundles.ts
node scripts/gen-label-bundles.mjs <workflow-output.json>
# 3. regenerate this doc
node scripts/gen-labels-doc.mjs
```

---

## The bundles

## Role bundles

### People Manager / Team Lead `manager`

For an engineering or team lead managing people, approvals, hiring, and delivery health.

| id | label | when to apply | color |
|---|---|---|---|
| `approval-needed` | Approval needed | Apply when a request awaits your manager sign-off, such as a PR, expense, contract, PTO request, or access grant. | amber |
| `one-on-one` | 1-1 prep | Apply when the item is preparing for, scheduling, or following up on a recurring 1-1 with a direct report. | blue |
| `time-off` | Time off / coverage | Apply when a report requests PTO, sick, or parental leave, or you must arrange coverage for someone away. | sky |
| `hiring` | Hiring | Apply when the item is a job req, candidate review, interview, debrief, or offer for an open role on your team. | teal |
| `performance` | Performance | Apply when the item involves a review cycle, calibration, promotion case, PIP, or feedback you must give a report. | violet |
| `team-blocker` | Team blocker | Apply when a report is stuck and needs you to unblock them, remove a dependency, or make a call to keep work moving. | red |
| `escalation` | Escalation | Apply when a stakeholder, exec, or customer escalates an issue to you that demands a same-day response or resolution. | red |
| `people-conflict` | People issue | Apply when the item concerns interpersonal conflict, morale, attrition risk, or an HR-sensitive matter on your team. | fuchsia |
| `budget-headcount` | Budget / headcount | Apply when the item touches team budget, vendor spend, headcount planning, or a forecast you own. | orange |
| `onboarding` | Onboarding | Apply when the item is ramping a new hire or transfer, including setup, buddy assignment, and 30-60-90 check-ins. | green |
| `status-report` | Status report | Apply when you must produce or roll up a team status update, delivery report, or metrics summary for leadership. | indigo |

### Executive / Founder `executive-leadership`

For a CEO/founder fielding board, fundraising, strategy, hiring, partnership, and PR demands across every channel.

| id | label | when to apply | color |
|---|---|---|---|
| `board-investor-update` | Board & investors | Apply when the item is board prep, a board ask, an investor update, or a request from a board member or investor. | violet |
| `fundraise` | Fundraising | Apply when the item involves raising capital: investor outreach, deck or data-room prep, diligence, or term sheets. | indigo |
| `strategy-bet` | Strategy bet | Apply when the item is long-range direction: positioning, a new product line or pivot, build-vs-buy, or a company bet. | pink |
| `exec-decision` | Decision needed | Apply when someone escalates a call only the founder can make: a tradeoff, sign-off, or tie-breaker that is blocked on you. | red |
| `key-hire` | Key hire | Apply when the item is recruiting, closing, or onboarding a senior role, or an offer/comp decision at leadership level. | teal |
| `people-org` | People & org | Apply when the item is an exec 1:1, performance or comp issue, org-design change, or a sensitive personnel matter. | green |
| `partnership-deal` | Partnership / BD | Apply when the item is a strategic partnership, key-customer deal, or negotiation expecting founder-level engagement. | sky |
| `pr-public` | PR & public | Apply when the item is a press request, interview, speaking invite, or public statement carrying reputational weight. | fuchsia |
| `okr-metrics` | OKRs & metrics | Apply when the item is goal-setting or progress against targets: OKR planning, a KPI review, or an off-track signal. | blue |
| `runway-finance` | Runway & finance | Apply when the item touches company finances you own: budget, burn or runway, major spend, or a cash-flow flag. | amber |
| `legal-risk` | Legal & risk | Apply when the item is a contract to sign, a legal or compliance question, or any incident posing real risk to the company. | orange |

### Executive Assistant / Admin `administrative-ea`

For an executive assistant or admin running an exec's calendar, travel, inbox, and office logistics.

| id | label | when to apply | color |
|---|---|---|---|
| `scheduling-request` | Scheduling | Apply when someone asks to book, move, or cancel a meeting, or to find a time on the exec's calendar. | blue |
| `calendar-conflict` | Calendar conflict | Apply when two commitments overlap or a double-booking must be resolved before the exec's day breaks. | red |
| `travel-booking` | Travel & logistics | Apply when the item involves booking or changing flights, hotels, cars, visas, or an itinerary for a trip. | sky |
| `expense-report` | Expenses | Apply when receipts, reimbursements, an expense report, or a corporate-card reconciliation need processing. | teal |
| `inbox-triage` | Inbox triage | Apply when an email or message must be read, sorted, delegated, or drafted on the exec's behalf. | indigo |
| `meeting-prep` | Meeting prep | Apply when an upcoming meeting needs an agenda, briefing doc, attendee research, or materials assembled. | violet |
| `gatekeeping` | Gatekeeping | Apply when someone requests access to the exec's time or attention and you must screen, route, or decline it. | amber |
| `signature-approval` | Signature / approval | Apply when a document, contract, PO, or request is waiting on the exec's signature or sign-off. | orange |
| `office-ops` | Office ops | Apply when the item is facilities, supplies, equipment, vendor coordination, or event/catering logistics. | green |
| `personal-errand` | Personal errand | Apply when the exec asks for a personal task such as gifts, appointments, reservations, or family logistics. | pink |

### Project / Program Manager `project-management`

For a project or program manager juggling milestones, risks, dependencies, and stakeholder asks across teams.

| id | label | when to apply | color |
|---|---|---|---|
| `milestone` | Milestone | Apply when the item is tied to hitting or shipping a dated delivery, phase gate, launch, or release on the plan. | violet |
| `risk` | Risk | Apply when something threatens scope, schedule, budget, or quality and needs to be logged, owned, and mitigated. | orange |
| `dependency` | Dependency | Apply when progress is gated by another team, vendor, or workstream delivering something first. | amber |
| `scope-change` | Scope change | Apply when someone requests adding, cutting, or changing deliverables versus baseline and it needs change control. | fuchsia |
| `status-report` | Status report | Apply when the demand is to produce, update, or send a status update, weekly report, or steering deck. | indigo |
| `stakeholder-ask` | Stakeholder ask | Apply when a sponsor, exec, or key stakeholder requests information, a decision, or action from you directly. | blue |
| `decision-needed` | Decision needed | Apply when the item is parked awaiting a go/no-go, trade-off call, or sign-off before work can move forward. | violet |
| `resource-ask` | Resource ask | Apply when the item concerns staffing, capacity, budget allocation, or filling a gap on the team. | teal |
| `ceremony` | Ceremony | Apply when the item is a recurring planning, standup, retro, sprint review, or kickoff meeting to run or prep. | sky |
| `issue-escalation` | Issue / escalation | Apply when an active blocker or incident has been raised to you to drive to resolution or escalate upward. | red |

### IT / Sysadmin / Helpdesk `it-support`

For IT support staff, sysadmins, and helpdesk engineers fielding incidents, access, and infrastructure demands.

| id | label | when to apply | color |
|---|---|---|---|
| `incident` | Incident | Apply when a user or alert reports something broken or degraded that needs a fix or restore, like a dead app or VPN. | red |
| `outage` | Major outage | Apply when a shared service or system is fully down affecting many users or a whole site and needs major-incident coordination. | red |
| `security-alert` | Security alert | Apply when a suspected breach, malware, phishing report, or SIEM/EDR detection needs triage and containment. | orange |
| `access-request` | Access request | Apply when someone asks to grant, change, or revoke permissions, group membership, app access, or a password/MFA reset. | amber |
| `provisioning` | Provisioning | Apply when a new hire, leaver, or role change requires setting up or decommissioning accounts, mailboxes, and devices. | sky |
| `patch-update` | Patch / update | Apply when OS, firmware, or software patches and version upgrades need to be scheduled, tested, or rolled out. | blue |
| `change-request` | Change request | Apply when a planned config, network, or infra change needs review, approval, and a maintenance window before rollout. | indigo |
| `procurement` | Procurement | Apply when new hardware, software licenses, or a vendor/cloud subscription needs to be quoted, ordered, or renewed. | green |
| `backup-restore` | Backup / restore | Apply when a backup job, data recovery, or restore-from-backup request needs to be run or verified. | teal |
| `how-to` | How-to / setup | Apply when a user needs guidance, configuration help, or a walkthrough rather than a fix for a broken system. | violet |
| `asset-tracking` | Asset / inventory | Apply when a device, license, or asset record needs to be assigned, reclaimed, audited, or updated in inventory. | gray |

### Software Engineer `software-engineering`

For an individual-contributor software engineer triaging incoming work across code, reviews, deploys, and on-call.

| id | label | when to apply | color |
|---|---|---|---|
| `production-incident` | Production incident | Apply when something is broken or degraded in production right now and needs active firefighting or mitigation. | red |
| `on-call` | On-call | Apply when the item is a page, alert, or on-call rotation duty you must triage while carrying the pager. | orange |
| `bug-fix` | Bug fix | Apply when a reported defect in existing functionality needs to be reproduced and fixed (not a live outage). | amber |
| `code-review` | Code review | Apply when a teammate's pull request or design doc is waiting on your review, approval, or feedback. | violet |
| `feature-work` | Feature work | Apply when the demand is to build new product or user-facing functionality from a ticket, spec, or PRD. | blue |
| `spike` | Spike / research | Apply when you need a time-boxed investigation, prototype, or technical evaluation before committing to an approach. | sky |
| `deploy-release` | Deploy / release | Apply when the work is shipping a release, cutting a build, running migrations, or coordinating a rollout or rollback. | indigo |
| `tech-debt` | Tech debt | Apply when the item is refactoring, cleanup, dependency upgrades, or maintenance work with no new behavior. | gray |
| `infra-tooling` | Infra / tooling | Apply when the demand concerns CI/CD, build systems, dev environments, or developer tooling rather than product code. | teal |
| `support-request` | Support request | Apply when another team or user asks you to debug, explain, integrate with, or unblock them on your service or code. | pink |
| `security-fix` | Security / vuln | Apply when a vulnerability report, CVE, dependency advisory, or security review requires a remediation or patch. | fuchsia |

### Product Manager `product-management`

For a product manager triaging incoming demands across discovery, roadmap, specs, launches, experiments, and metrics.

| id | label | when to apply | color |
|---|---|---|---|
| `user-feedback` | User feedback | Apply when a customer or user reports a need, complaint, request, or reaction to the product that should inform decisions. | teal |
| `discovery` | Discovery | Apply when the demand is to research a problem, run user interviews, or validate an opportunity before building anything. | violet |
| `roadmap` | Roadmap | Apply when the item asks you to plan, sequence, or update what the team will build over the coming quarters. | indigo |
| `prioritization` | Prioritization | Apply when someone asks you to decide what gets built first, trade off requests, or scope down to fit a deadline. | amber |
| `spec` | Spec / PRD | Apply when the demand is to write, review, or clarify a PRD, user story, or acceptance criteria so engineering can build. | blue |
| `stakeholder-update` | Stakeholder update | Apply when leadership, sales, or another team asks for a status, demo, or alignment on what your product ships and when. | sky |
| `experiment` | Experiment | Apply when the item involves designing, launching, or reading out an A/B test, flag rollout, or product hypothesis test. | fuchsia |
| `metrics-review` | Metrics review | Apply when the demand is to analyze metrics, explain a dashboard movement, or investigate adoption or retention changes. | pink |
| `launch` | Launch | Apply when the item is a go-to-market or ship task such as release readiness, rollout coordination, or launch comms. | green |
| `incident` | Incident / regression | Apply when a live bug, outage, or broken product behavior needs your triage, severity call, or customer comms now. | red |
| `competitive-intel` | Competitive intel | Apply when the item is a competitor move, market shift, or analyst signal you must assess for impact on strategy. | orange |

### Sales / Account Executive `sales`

For a quota-carrying account executive triaging the inbound demands of a live sales pipeline — leads, demos, proposals, deals, renewals, and at-risk accounts.

| id | label | when to apply | color |
|---|---|---|---|
| `inbound-lead` | Inbound lead | Apply when a new prospect, demo request, or marketing/SDR-routed lead lands and needs qualifying and a first touch. | sky |
| `demo-prep` | Demo / discovery | Apply when a discovery or demo call must be scheduled, prepped, tailored, or followed up on for a prospect. | blue |
| `proposal` | Proposal / quote | Apply when you owe a prospect a proposal, pricing quote, or order form to advance the deal. | indigo |
| `rfp-security` | RFP / security review | Apply when a buyer requests an RFP response, security questionnaire, or vendor-assessment paperwork to complete. | violet |
| `negotiation` | Negotiation / close | Apply when a deal is in late-stage terms, discounting, legal/MSA redlines, procurement, or signature. | amber |
| `renewal` | Renewal | Apply when an existing account is approaching its renewal date and needs to be re-contracted or upsold. | teal |
| `churn-risk` | Churn risk | Apply when an account shows risk signals like low usage, complaints, a sponsor change, or a competitor threat. | red |
| `expansion` | Expansion / upsell | Apply when a current customer opens a cross-sell, upsell, or new-seat opportunity worth a fresh deal motion. | green |
| `forecast-crm` | Forecast / CRM | Apply when you must update CRM stages, log activity, or submit a pipeline forecast or commit for review. | gray |
| `champion-touch` | Champion check-in | Apply when a key contact or champion needs a relationship touch, intro, or nudge to keep a deal warm. | fuchsia |
| `closed-won` | Closed-won handoff | Apply when a signed deal needs onboarding kickoff or handoff to customer success or implementation. | pink |

### Marketing `marketing`

For marketers fielding daily demands across campaigns, content, brand, web, and growth.

| id | label | when to apply | color |
|---|---|---|---|
| `campaign-planning` | Campaign | Apply when the demand is to plan, build, or run a multi-channel campaign: briefs, targeting, budget, or scheduling. | violet |
| `product-launch` | Launch | Apply when the work is tied to a dated product, feature, or announcement launch with go-to-market deliverables. | red |
| `content-request` | Content | Apply when someone requests writing or producing content such as blog posts, emails, landing copy, scripts, or video. | blue |
| `creative-review` | Creative review | Apply when the ask is to review, approve, or give feedback on design, ad creative, or copy before it ships. | amber |
| `social-media` | Social | Apply when the demand concerns organic social posting, scheduling, community replies, or platform-specific content. | sky |
| `event-marketing` | Event | Apply when the work is preparing for or following up on a webinar, conference, booth, or field/hosted event. | teal |
| `seo-web` | SEO & web | Apply when the ask involves search ranking, keywords, site pages, technical SEO, or website content updates. | green |
| `paid-media` | Paid media | Apply when the demand is about paid ad spend, bidding, budgets, or optimizing ads across search, social, or display. | orange |
| `analytics-request` | Analytics | Apply when someone requests performance data, a report, dashboard, attribution, or campaign results analysis. | indigo |
| `brand-guideline` | Brand | Apply when the work concerns brand identity, voice, positioning, messaging, or enforcing brand guidelines and assets. | fuchsia |
| `pr-comms` | PR & comms | Apply when the demand is a press inquiry, media pitch, spokesperson request, or external announcement statement. | pink |

### Customer Success / Support `customer-success-support`

For CSMs and support leads triaging tickets, escalations, renewals, and account health across their book of business.

| id | label | when to apply | color |
|---|---|---|---|
| `support-ticket` | Support ticket | Apply when a customer reports a problem or asks a how-to question needing a troubleshooting response or resolution. | sky |
| `escalation` | Escalation | Apply when an account is angry, threatening to churn, or a stuck issue is pushed to a manager for urgent intervention. | red |
| `outage-incident` | Outage / incident | Apply when customers report the product is down, degraded, or broken at scale and incident response or updates are needed. | red |
| `bug-report` | Bug report | Apply when a customer surfaces a reproducible defect that needs to be confirmed and handed to engineering. | orange |
| `onboarding` | Onboarding | Apply when a newly signed account needs setup, kickoff, training, or first-value tasks to get live. | teal |
| `feature-request` | Feature request | Apply when a customer asks for new functionality or an enhancement that should be captured and routed to product. | violet |
| `renewal` | Renewal | Apply when a contract is approaching its end date and needs a renewal conversation, quote, or paperwork. | amber |
| `expansion` | Expansion | Apply when an account shows an upsell or cross-sell opportunity for more seats, tier, or add-ons. | green |
| `qbr-review` | QBR / review | Apply when a recurring business review or health check-in must be prepped, scheduled, or delivered to an account. | indigo |
| `churn-risk` | Churn risk | Apply when usage drops, a champion leaves, or sentiment signals an account is at risk and needs a save play. | fuchsia |
| `billing-issue` | Billing issue | Apply when a customer raises an invoice, payment, refund, or account-admin/access dispute needing resolution. | pink |

### Finance / Accounting `finance-accounting`

For finance and accounting professionals triaging invoices, approvals, close tasks, audits, and reporting demands.

| id | label | when to apply | color |
|---|---|---|---|
| `invoice-payable` | Invoice / AP | Apply when a vendor or supplier invoice arrives and needs coding, matching to a PO, or scheduling for payment. | blue |
| `approval-needed` | Approval / sign-off | Apply when a payment, expense, journal entry, or PO is waiting on your authorization before it can proceed. | amber |
| `expense-report` | Expenses | Apply when an employee expense claim or corporate-card reconciliation needs review, policy check, or reimbursement. | sky |
| `payroll-run` | Payroll | Apply when a payroll cycle, salary change, bonus, or benefits/tax-withholding item must be processed by a pay date. | indigo |
| `month-end-close` | Month-end close | Apply when a task belongs to the period-end close checklist, like accruals, journal entries, or reconciliations. | teal |
| `reconciliation` | Reconciliation | Apply when a bank, ledger, or intercompany balance shows a mismatch or variance that must be investigated and cleared. | orange |
| `budget-forecast` | Budget / forecast | Apply when a budget input, reforecast, variance explanation, or spend-vs-plan question lands from a team or leadership. | violet |
| `financial-reporting` | Financial reporting | Apply when financial statements, board decks, KPIs, or management reports must be prepared, reviewed, or distributed. | fuchsia |
| `audit-request` | Audit request | Apply when internal or external auditors request documentation, evidence, or explanations on a PBC list or test. | pink |
| `tax-compliance` | Tax / compliance | Apply when a tax filing, VAT/sales-tax return, regulatory submission, or statutory deadline requires action. | red |
| `ar-collections` | AR / collections | Apply when a customer invoice is overdue, disputed, or needs a credit decision, dunning follow-up, or cash-app fix. | green |

### HR / People Ops `hr-people-ops`

For HR / People Ops leads who triage recruiting, onboarding, benefits, ER, and payroll demands

| id | label | when to apply | color |
|---|---|---|---|
| `employee-relations` | Employee relations | Apply when a complaint, conflict, harassment/misconduct report, or investigation involving employees needs handling. | red |
| `compliance-legal` | Compliance & legal | Apply when the item is a labor-law deadline, audit, leave eligibility, or a legal/regulatory request like an EEOC notice. | red |
| `payroll-issue` | Payroll issue | Apply when someone reports a pay error, missing paycheck, tax question, timesheet fix, or a payroll cutoff is near. | orange |
| `approval-needed` | Approval needed | Apply when an offer, requisition, comp change, promotion, or termination is waiting on your or an approver's sign-off. | amber |
| `recruiting` | Recruiting | Apply when the item is an open req, candidate sourcing, interview scheduling, a debrief, or moving someone through hiring. | sky |
| `onboarding` | Onboarding | Apply when a new or returning hire needs setup: paperwork, background check, equipment, accounts, or orientation. | blue |
| `offboarding` | Offboarding | Apply when a departure needs processing: resignation, final pay, exit interview, COBRA, or access and asset revocation. | gray |
| `benefits-leave` | Benefits & leave | Apply when an employee asks about or enrolls in benefits, open enrollment, FMLA/parental leave, PTO, or a 401(k) change. | teal |
| `policy-question` | Policy question | Apply when someone asks how a policy works or you must draft, update, or communicate a handbook or conduct policy. | indigo |
| `performance-comp` | Performance & comp | Apply when the item is a review cycle, PIP, calibration, merit/bonus planning, or a compensation-band question. | violet |
| `culture-engagement` | Culture & engagement | Apply when planning a team event, DEI initiative, engagement-survey action, recognition program, or an all-hands. | green |

### Legal / Compliance `legal-compliance`

For in-house legal counsel and compliance officers triaging contracts, risk, regulatory filings, and disputes.

| id | label | when to apply | color |
|---|---|---|---|
| `contract-review` | Contract review | Apply when someone asks you to draft, review, redline, or negotiate a commercial agreement like an MSA, SOW, or vendor deal. | blue |
| `nda-request` | NDA request | Apply when the demand is to issue, review, or countersign an NDA or confidentiality agreement before a deal proceeds. | sky |
| `approval-needed` | Legal sign-off | Apply when a deal, marketing asset, contract, or release is blocked pending your legal review and go/no-go approval. | amber |
| `regulatory-filing` | Regulatory filing | Apply when there is a statutory or regulatory submission to prepare and file by a deadline, like SEC, GDPR, or a license. | green |
| `compliance-incident` | Compliance incident | Apply when a suspected violation, breach, conflict of interest, or whistleblower report needs investigation or remediation. | red |
| `litigation-dispute` | Litigation / dispute | Apply when the matter involves a claim, demand letter, lawsuit, subpoena, or active dispute with a counterparty. | red |
| `audit-request` | Audit / exam | Apply when an internal, external, or regulatory audit or exam requests evidence, controls testing, or documentation. | orange |
| `policy-update` | Policy update | Apply when you must draft, revise, or roll out an internal policy, code of conduct, or compliance procedure. | violet |
| `risk-assessment` | Risk assessment | Apply when asked to evaluate legal or regulatory exposure on a new product, market, vendor, or decision before it moves. | fuchsia |
| `data-privacy` | Data / privacy | Apply when the request concerns personal-data handling, a DPA, a data-subject access request, or a privacy review. | teal |
| `ip-trademark` | IP / trademark | Apply when the demand involves protecting or clearing IP: trademark, patent, copyright, licensing, or infringement. | indigo |

### Operations `operations`

For an operations lead fielding incidents, vendor issues, SLAs, capacity, and cost demands.

| id | label | when to apply | color |
|---|---|---|---|
| `incident` | Incident | Apply when something is broken or degraded in service right now and needs triage, mitigation, or restoration. | red |
| `sla-risk` | SLA risk | Apply when a service-level or response-time commitment is breached or about to breach and needs intervention. | orange |
| `vendor-issue` | Vendor issue | Apply when a supplier or third-party provider raises a problem, fails to deliver, or needs a decision on their service. | fuchsia |
| `contract-renewal` | Contract renewal | Apply when a vendor contract, license, or subscription is up for renewal, renegotiation, or termination. | violet |
| `supply-shortage` | Supply shortage | Apply when inventory, stock, or materials are running low, delayed, or out and need reordering or sourcing. | amber |
| `logistics` | Logistics | Apply when a shipment, delivery, fulfillment, or transport movement needs coordinating, rerouting, or tracking. | sky |
| `capacity-planning` | Capacity planning | Apply when staffing, throughput, or resource capacity must be forecast or adjusted to meet expected demand. | teal |
| `cost-control` | Cost control | Apply when a budget overrun, spend approval, or cost-reduction opportunity needs review or sign-off. | green |
| `process-improvement` | Process improvement | Apply when a recurring workflow, SOP, or bottleneck needs documenting, fixing, or optimizing. | blue |
| `compliance-audit` | Compliance / audit | Apply when a safety, regulatory, quality, or audit requirement needs evidence, remediation, or certification. | indigo |

### Consultant / Professional Services `consulting-services`

For independent consultants and professional-services teams juggling proposals, client deliverables, and billable work.

| id | label | when to apply | color |
|---|---|---|---|
| `new-lead` | New lead | Apply when an inbound inquiry, referral, or RFP arrives from a prospect who is not yet a signed client and needs qualifying. | violet |
| `proposal` | Proposal / SOW | Apply when you need to draft, price, or send a proposal, statement of work, or contract to win or renew an engagement. | indigo |
| `scoping` | Scoping | Apply when defining the engagement's objectives, boundaries, timeline, or assumptions to prevent scope creep. | sky |
| `deliverable` | Deliverable | Apply when a client-facing report, deck, model, design, or recommendation must be produced or finalized by a deadline. | blue |
| `client-request` | Client request | Apply when an active client asks for extra work, a change, a quick answer, or anything ad hoc outside planned deliverables. | teal |
| `research` | Research / analysis | Apply when the task is gathering data, interviewing, benchmarking, or analyzing to build the evidence base for a recommendation. | green |
| `billing` | Billing | Apply when an invoice, timesheet, expense, retainer drawdown, or chasing an overdue payment is the demand. | amber |
| `scope-risk` | Scope / budget risk | Apply when work drifts beyond agreed scope, hours, or budget and needs a change order or client conversation. | red |
| `status-report` | Status update | Apply when the demand is a recurring status report, steering-committee update, or stakeholder comms on progress. | orange |
| `engagement-closeout` | Engagement close-out | Apply when wrapping up a project: final handoff, retrospective, references, or setting up the next phase or renewal. | fuchsia |

### Designer / Creative `design-creative`

For product, brand, and visual designers fielding requests, reviews, and asset work across channels.

| id | label | when to apply | color |
|---|---|---|---|
| `design-request` | Design request | Apply when someone asks you to create or change a new design, screen, mockup, or visual deliverable from scratch. | blue |
| `design-review` | Review needed | Apply when a stakeholder, PM, or peer asks you to review their work or wants your sign-off on a design before it ships. | violet |
| `feedback-incoming` | Feedback to address | Apply when you receive critique, comments, or change requests on a design you already shared that you now must act on. | amber |
| `iteration` | Iteration / revision | Apply when the demand is to refine, tweak, or produce another round of an existing design rather than make something new. | sky |
| `asset-delivery` | Asset delivery | Apply when someone needs final exported files, specs, or assets like icons, logos, or images packaged and sent. | teal |
| `dev-handoff` | Dev handoff | Apply when engineering needs design specs, redlines, prototypes, or component details to start or unblock implementation. | indigo |
| `brand-guidance` | Brand question | Apply when someone asks for brand approval, guidelines, or whether something is on-brand: colors, type, voice, or logo. | fuchsia |
| `design-research` | Research / discovery | Apply when the demand involves user research, competitive teardown, exploration, or gathering input before designing. | green |
| `design-system` | Design system | Apply when the request is to add, update, or document a shared component, token, or pattern in the design system. | gray |
| `creative-brief` | Creative brief | Apply when a new campaign, project, or initiative kicks off and you need to scope direction, deliverables, and goals. | orange |

### Data / Analytics `data-analytics`

For data analysts, analytics engineers, and data scientists fielding ad-hoc pulls, dashboards, pipelines, and metric questions.

| id | label | when to apply | color |
|---|---|---|---|
| `ad-hoc-pull` | Ad-hoc data pull | Apply when someone asks for a one-off query, extract, list, or count to answer a specific question right now. | sky |
| `dashboard-request` | Dashboard / report | Apply when the demand is to build, change, or fix a recurring dashboard, scheduled report, or BI view. | blue |
| `pipeline-incident` | Pipeline broken | Apply when an ETL/ELT job, sync, or scheduled DAG has failed, is late, or stopped delivering fresh data. | red |
| `data-quality` | Data quality issue | Apply when numbers look wrong, duplicated, null, or mismatched and the underlying data needs validation or a fix. | orange |
| `metric-definition` | Metric question | Apply when someone disputes a number or asks how a metric is defined, sourced, or why two reports disagree. | amber |
| `model-forecast` | Model / forecast | Apply when the ask is to build, retrain, score, or explain a predictive model, forecast, or scoring algorithm. | violet |
| `experiment-readout` | Experiment readout | Apply when an A/B test or experiment needs design, monitoring, or a results analysis to call a winner. | indigo |
| `tracking-instrumentation` | Tracking / events | Apply when the demand is to define, add, or QA event tracking, tags, or instrumentation so data is captured correctly. | teal |
| `data-access` | Data access request | Apply when someone needs permissions, credentials, or access provisioned to a dataset, warehouse, or BI tool. | fuchsia |
| `self-serve-enablement` | Self-serve enablement | Apply when the request is to document a dataset, certify a table, or teach a stakeholder to answer it themselves. | green |

### Developer Platform Lead (DX Lead) `developer-platform-lead`

For a developer-experience lead managing platform adopters, onboarding, and the platform's cost-efficiency.

| id | label | when to apply | color |
|---|---|---|---|
| `prospect` | Prospect | Apply when the demand is a new lead or first-call opportunity not yet an adopter, like an intro, referral, or pitch to win. | violet |
| `onboarding` | Onboarding | Apply when the demand is bringing on a new team or workspace: account provisioning, environment setup, or the new-adopter checklist. | sky |
| `access-review` | Access review | Apply when the demand concerns access due diligence, scope and permission audits, dependency or license screening, or a security query to clear. | red |
| `doc-chase` | Document chase | Apply when you are waiting on or collecting outstanding paperwork like an API token, an integration spec, or a signed agreement. | amber |
| `compatibility` | Compatibility | Apply when matching a feature or release to the team's stack, version constraints, or supported-config rules before rollout. | orange |
| `transaction` | Transaction | Apply when the demand is a team instruction to execute: a deploy, migration, plan change, payment, or transfer. | blue |
| `cost-efficiency` | Cost-efficiency | Apply when the demand concerns platform economics: pricing, fee or usage-rebate review, usage/revenue, or account margin. | teal |
| `portfolio-review` | Account review | Apply when the demand is a periodic or ad-hoc review of a team's usage, performance, allocation, or review meeting. | indigo |
| `usage-billing` | Credit / usage billing | Apply when the demand is billing against usage: a usage-based plan, prepaid credits, an overage charge, or a quota shortfall. | pink |
| `client-care` | Adopter care | Apply when the demand is a relationship touch with an existing team: a service request, complaint, milestone, or check-in. | green |

### Teacher / Educator `teaching-education`

For a classroom teacher or instructor juggling lessons, grading, students, and parent and admin demands.

| id | label | when to apply | color |
|---|---|---|---|
| `lesson-planning` | Lesson planning | Apply when the demand is preparing, sequencing, or adapting a lesson, unit, activity, or teaching material to deliver. | blue |
| `grading` | Grading | Apply when student work, an assignment, quiz, or exam is waiting to be marked, scored, or have feedback returned. | amber |
| `parent-comms` | Parent contact | Apply when a parent or guardian message, conference, progress update, or concern about a student needs a response. | sky |
| `student-support` | Student support | Apply when an individual student needs intervention, accommodation, an IEP/504 task, or pastoral or behavioral follow-up. | violet |
| `assessment-deadline` | Assessment / deadline | Apply when a dated exam, test window, report-card cutoff, or grade-submission deadline is approaching. | red |
| `admin-paperwork` | School admin | Apply when the item is school paperwork, attendance, compliance forms, duty rosters, or a request from administration. | gray |
| `meeting-pd` | Meeting / PD | Apply when the demand is a staff meeting, department meeting, training, or professional-development session to attend or prep. | indigo |
| `event-trip` | Event / field trip | Apply when organizing or chaperoning a field trip, assembly, performance, sports event, or other school activity. | teal |
| `resources-supplies` | Resources / supplies | Apply when classroom materials, books, equipment, tech, or supplies need to be sourced, requested, or set up. | green |
| `curriculum-planning` | Curriculum | Apply when the item is longer-range curriculum mapping, scheme-of-work design, or standards alignment beyond one lesson. | fuchsia |

### Recruiter / Talent Acquisition `recruiting-talent`

For a full-time recruiter or sourcer running candidate pipelines from req intake to offer across many roles.

| id | label | when to apply | color |
|---|---|---|---|
| `intake-req` | Intake / new req | Apply when a new open role needs an intake meeting, scorecard, job description, or kickoff with the hiring manager. | indigo |
| `sourcing` | Sourcing | Apply when the task is actively finding candidates: searches, outreach, referrals, or building a pipeline for a role. | sky |
| `screening` | Screening | Apply when a candidate needs a resume review, recruiter phone screen, or qualification check before advancing. | blue |
| `interview-coord` | Interview coord | Apply when an interview loop or panel must be scheduled, coordinated, or rescheduled across candidate and interviewers. | teal |
| `candidate-followup` | Candidate follow-up | Apply when a candidate is awaiting a reply, status update, or nudge to keep them warm and moving through the process. | green |
| `debrief-decision` | Debrief / decision | Apply when interviewer feedback must be collected or a hire/no-hire decision is parked awaiting the loop's verdict. | violet |
| `offer-stage` | Offer | Apply when an offer needs to be approved, extended, negotiated, or is awaiting a candidate's accept or decline. | amber |
| `offer-decline-risk` | At-risk candidate | Apply when a candidate may drop out, has a competing offer, or has gone quiet and the placement is in jeopardy. | red |
| `ats-admin` | ATS / pipeline admin | Apply when you must update applicant-tracking records, disposition candidates, or report on pipeline and funnel metrics. | gray |
| `hm-update` | Hiring manager update | Apply when the hiring manager or panel needs a pipeline update, sync, or alignment on the search's progress. | orange |

### Clinician / Healthcare Provider `clinical-care`

For a nurse, doctor, or allied clinician managing patients, charting, orders, and care coordination across a caseload.

| id | label | when to apply | color |
|---|---|---|---|
| `patient-followup` | Patient follow-up | Apply when a patient needs a callback, result communicated, recheck, or follow-up contact after a visit or test. | sky |
| `charting` | Charting / notes | Apply when a clinical note, encounter, or documentation must be completed, signed, or amended in the record. | blue |
| `orders-rx` | Orders / Rx | Apply when a prescription, lab, imaging, or treatment order needs to be placed, renewed, or signed off. | teal |
| `results-review` | Results to review | Apply when lab work, imaging, or diagnostic results have returned and need clinical review and a disposition. | violet |
| `referral-coord` | Referral / coordination | Apply when care must be coordinated with another provider, specialist, facility, or service via a referral or handoff. | green |
| `urgent-clinical` | Urgent clinical | Apply when a patient situation is acute or deteriorating and needs same-day clinical attention or escalation. | red |
| `prior-auth` | Prior auth / insurance | Apply when a treatment, drug, or procedure needs insurance authorization, appeal, or coverage paperwork to proceed. | amber |
| `patient-message` | Patient message | Apply when a patient portal message, question, or non-urgent request is waiting for a clinical reply. | indigo |
| `compliance-quality` | Compliance / quality | Apply when the item is a mandatory training, audit, quality measure, incident report, or regulatory clinical requirement. | orange |
| `shift-handoff` | Shift / handoff | Apply when the task is a shift handoff, on-call duty, rounding list, or coverage item tied to your clinical shift. | fuchsia |

### Real Estate Agent / Broker `real-estate-agent`

For a residential or commercial agent juggling listings, buyers, showings, offers, and closings across deals.

| id | label | when to apply | color |
|---|---|---|---|
| `new-lead` | New lead | Apply when a buyer or seller inquiry, referral, or sphere contact arrives and needs qualifying and a first response. | sky |
| `listing-prep` | Listing prep | Apply when a property needs to be readied to list: pricing, photos, staging, paperwork, or MLS entry. | violet |
| `showing` | Showing / open house | Apply when a private showing, open house, or property tour must be scheduled, hosted, or followed up on. | teal |
| `offer-negotiation` | Offer / negotiation | Apply when an offer needs to be written, presented, countered, or negotiated on behalf of a buyer or seller. | amber |
| `under-contract` | Under contract | Apply when a deal is in escrow and needs inspections, appraisal, contingencies, or contract milestones managed. | indigo |
| `closing` | Closing | Apply when a transaction is approaching settlement and needs final docs, walkthrough, funds, or signing coordinated. | green |
| `deadline-contingency` | Deadline / contingency | Apply when a contractual deadline or contingency date is approaching that could break the deal if missed. | red |
| `client-followup` | Client follow-up | Apply when a current or past client needs a check-in, update, or nurture touch to keep the relationship warm. | blue |
| `vendor-coord` | Vendor coordination | Apply when a lender, inspector, photographer, title, or other transaction vendor must be booked or chased. | orange |
| `transaction-admin` | Transaction admin | Apply when disclosures, commissions, compliance files, or CRM records for a deal need to be completed or filed. | gray |

### Researcher / Academic `research-academia`

For an academic or researcher balancing papers, grants, peer review, teaching, and lab or fieldwork.

| id | label | when to apply | color |
|---|---|---|---|
| `manuscript` | Manuscript | Apply when the task is writing, revising, or submitting a paper, abstract, or responding to reviewer comments. | blue |
| `grant-funding` | Grant / funding | Apply when a grant proposal, renewal, budget, or funder report must be prepared or submitted by a deadline. | green |
| `peer-review` | Peer review | Apply when you are asked to review a paper, proposal, or abstract for a journal, conference, or panel. | violet |
| `experiment-data` | Experiment / data | Apply when the work is running an experiment, collecting or analyzing data, or managing a study or lab protocol. | teal |
| `submission-deadline` | Submission deadline | Apply when a hard external date looms: a conference CFP, journal, grant, or abstract submission cutoff. | red |
| `teaching-supervision` | Teaching / advising | Apply when the item is teaching a course, grading, or supervising and advising students or research mentees. | sky |
| `collaboration` | Collaboration | Apply when a co-author, collaborator, or partner lab is awaiting input, a contribution, or coordination from you. | indigo |
| `conference-talk` | Conference / talk | Apply when preparing, scheduling, or traveling for a conference, seminar, poster, or invited talk. | fuchsia |
| `ethics-compliance` | Ethics / compliance | Apply when an IRB/ethics approval, data-management plan, or research-compliance requirement needs action. | orange |
| `admin-service` | Admin / service | Apply when the item is departmental service, committee work, reporting, or institutional admin outside research. | gray |

## Life bundles

### Household Admin `life-household-admin`

For the person running a household — bills, paperwork, appointments, renewals and the steady drip of admin.

| id | label | when to apply | color |
|---|---|---|---|
| `bill-to-pay` | Bill to pay | Apply when an invoice, statement, or payment request has arrived and money must be sent or scheduled by a due date. | red |
| `renewal-due` | Renewal due | Apply when a subscription, membership, licence, passport, or domain is expiring and must be renewed or cancelled. | amber |
| `insurance` | Insurance | Apply when the item concerns a policy, quote, claim, or coverage change for home, auto, health, life, or contents. | indigo |
| `appointment` | Appointment | Apply when something needs a slot booked, confirmed, or rescheduled: doctor, dentist, vet, salon, viewing, or service. | sky |
| `form-to-file` | Form to file | Apply when a form, application, or government/school/bank submission must be completed and sent to meet a deadline. | violet |
| `document-needed` | Document needed | Apply when you must locate, request, scan, sign, or file a document like a contract, certificate, or proof of address. | blue |
| `delivery-tracking` | Delivery / return | Apply when a parcel, order, or shipment needs tracking, collecting, accepting at home, or returning. | teal |
| `repair-maintenance` | Repair / upkeep | Apply when something at home is broken or due for maintenance and needs a tradesperson, part, or scheduled service. | orange |
| `utilities-account` | Utilities / account | Apply when setting up, switching, disputing, or changing an account with a utility, telecom, bank, or service provider. | gray |
| `warranty-claim` | Warranty / dispute | Apply when chasing a refund, warranty repair, overcharge, or billing error with a vendor or service. | fuchsia |

### Personal Finance `life-personal-finance`

For an individual managing their own money: budgeting, taxes, investing, debt, and big purchases.

| id | label | when to apply | color |
|---|---|---|---|
| `bill-due` | Bill due | Apply when a bill, loan payment, or invoice has a hard due date and risks a late fee or service cutoff if missed. | red |
| `tax-filing` | Tax filing | Apply when the item is filing returns, quarterly estimates, deductions, document collection, or any tax-deadline task. | orange |
| `fraud-dispute` | Fraud or dispute | Apply when reviewing a suspicious charge, disputing a transaction, freezing a card, or responding to a breach alert. | pink |
| `budget-review` | Budget review | Apply when reconciling accounts, categorizing spend, or checking whether spending is on track against the budget. | blue |
| `subscription-audit` | Subscription audit | Apply when a recurring subscription or membership is renewing, raising its price, or up for a cancel/keep decision. | sky |
| `debt-paydown` | Debt paydown | Apply when the task is paying down or refinancing a credit card, loan, or mortgage, or weighing a payoff strategy. | amber |
| `invest-rebalance` | Invest & rebalance | Apply when reviewing a portfolio, rebalancing allocations, deciding a buy/sell, or acting on a market-driven move. | violet |
| `retirement-contrib` | Retirement & savings | Apply when funding a 401k/IRA, hitting a contribution or match deadline, or moving money into savings. | teal |
| `big-purchase` | Big purchase | Apply when researching, saving for, or deciding on a major one-off purchase like a car, home, appliance, or trip. | indigo |
| `insurance-renewal` | Insurance & coverage | Apply when an insurance policy is renewing, a claim is in flight, or coverage needs to be compared or updated. | green |
| `money-admin` | Account admin | Apply for routine financial paperwork: opening/closing accounts, updating beneficiaries, statements, or KYC requests. | gray |

### Health & Wellness `life-health-wellness`

For anyone managing their own health, appointments, meds, fitness, and mental wellbeing across channels.

| id | label | when to apply | color |
|---|---|---|---|
| `appointment-booking` | Appointment | Apply when the item is scheduling, confirming, rescheduling, or preparing for a doctor, dentist, specialist, or therapy visit. | sky |
| `prescription-refill` | Prescription | Apply when the item involves refilling, picking up, renewing, or adjusting a medication or a pharmacy request. | blue |
| `test-results` | Test results | Apply when lab work, imaging, screenings, or other clinical results have arrived and need review or follow-up action. | violet |
| `symptom-concern` | Symptom / concern | Apply when a new or worsening symptom, injury, or acute health worry needs assessment or a same-week medical decision. | red |
| `preventive-checkup` | Preventive care | Apply when the item is a routine physical, dental cleaning, vaccination, or recommended screening that is due or overdue. | teal |
| `insurance-billing` | Insurance / billing | Apply when the item is a medical bill, claim, pre-authorization, EOB, or coverage question to pay or dispute. | amber |
| `fitness-training` | Fitness | Apply when the item is a workout plan, training session, class booking, or physical-activity goal to schedule or log. | green |
| `mental-health` | Mental health | Apply when the item relates to a therapy session, mood, stress, sleep, or a mindfulness or self-care practice to act on. | indigo |
| `nutrition-diet` | Nutrition | Apply when the item is about meal planning, dietary changes, supplements, or tracking food and hydration. | orange |
| `care-coordination` | Care coordination | Apply when the item involves managing care for a dependent or coordinating referrals, records, or providers across parties. | fuchsia |

### Family & Relationships `life-family-relationships`

For staying on top of family, partner, kids, parents, and friendships across daily life.

| id | label | when to apply | color |
|---|---|---|---|
| `kids-logistics` | Kids logistics | Apply when the demand involves a child's schedule, transport, pickups, activities, playdates, or daily care coordination. | sky |
| `school` | School | Apply when the item concerns school: forms, permission slips, teacher messages, meetings, tuition, homework, or enrollment. | blue |
| `partner` | Partner | Apply when the demand is about your spouse or partner: shared decisions, date plans, their asks, or relationship check-ins. | pink |
| `parents-elders` | Parents & elders | Apply when the item concerns aging parents or older relatives: their needs, requests, visits, or coordinating help. | violet |
| `caregiving` | Caregiving | Apply when the demand is hands-on care for a dependent: meds, appointments, doctor coordination, or arranging caregivers. | indigo |
| `health-appointment` | Health appointment | Apply when the item is booking, prepping for, or following up on a medical, dental, or wellness visit for a family member. | teal |
| `social-plans` | Social plans | Apply when the demand is organizing or responding to get-togethers with friends or family: dinners, trips, or hosting. | amber |
| `celebration` | Celebration | Apply when the item is a birthday, anniversary, holiday, gift, card, or party that needs planning or remembering. | fuchsia |
| `household` | Household | Apply when the demand is running the shared home: chores, repairs, groceries, bills, or coordinating contractors. | green |
| `stay-in-touch` | Stay in touch | Apply when someone deserves a reach-out you owe: a friend you've lost touch with, a thank-you, or an overdue reply. | orange |
| `family-tension` | Family tension | Apply when the item is a sensitive conflict, disagreement, or hard conversation with a family member or friend. | red |

### Home & Maintenance `life-home-maintenance`

For a homeowner or renter juggling repairs, contractors, chores, and household projects.

| id | label | when to apply | color |
|---|---|---|---|
| `urgent-repair` | Urgent repair | Apply when something is broken in a way that risks safety, damage, or livability and needs fixing now, like a leak or no heat. | red |
| `routine-repair` | Routine repair | Apply when a non-urgent fix-it task comes in for something worn, loose, or partly broken that can wait until convenient. | orange |
| `appliance` | Appliance | Apply when the demand concerns a household appliance or system like the fridge, washer, boiler, or HVAC needing service. | amber |
| `contractor` | Contractor & quotes | Apply when you need to find, vet, schedule, quote, or pay a tradesperson like a plumber, electrician, or handyman. | violet |
| `renovation` | Renovation project | Apply when the item is part of a larger multi-step home improvement effort like a kitchen redo, repaint, or new flooring. | indigo |
| `cleaning` | Cleaning & chores | Apply when the task is recurring upkeep or deep cleaning: decluttering, laundry, scrubbing, or booking a cleaner. | sky |
| `garden-outdoor` | Garden & outdoor | Apply when the demand involves the yard, garden, lawn, plants, or exterior like the patio, fence, gutters, or driveway. | green |
| `seasonal-maintenance` | Seasonal upkeep | Apply when it is preventive, calendar-driven maintenance like winterizing pipes, servicing the furnace, or swapping filters. | teal |
| `supplies-shopping` | Supplies & shopping | Apply when you need to buy, order, return, or restock materials, tools, parts, or furnishings for the home. | blue |
| `move-logistics` | Move & logistics | Apply when the task relates to moving, packing, storage, deliveries, or transferring utilities and home services. | fuchsia |
| `home-admin` | Home admin | Apply when it is paperwork or recurring obligations for the home: insurance, property tax, HOA dues, warranties, or permits. | gray |

### Errands & Shopping `life-errands-shopping`

For anyone running household errands, shopping, and pickups day to day.

| id | label | when to apply | color |
|---|---|---|---|
| `grocery-run` | Grocery run | Apply when the item is buying food, household staples, or restocking the pantry/fridge, in-store or via a delivery order. | green |
| `online-order` | Online order | Apply when something needs to be ordered, purchased, or placed in a cart online and is not yet shipped. | blue |
| `delivery-tracking` | Delivery tracking | Apply when a placed order is in transit and the task is to track, receive, or be home for a shipment or delivery. | sky |
| `pickup` | Pickup | Apply when something must be collected in person from a store, locker, pharmacy, dry cleaner, or curbside slot. | teal |
| `return-exchange` | Return / exchange | Apply when an item needs to be returned, exchanged, or refunded, including printing labels and meeting return windows. | red |
| `gift` | Gift | Apply when the task is choosing, buying, or wrapping a present for a birthday, holiday, or special occasion. | fuchsia |
| `in-person-errand` | In-person errand | Apply when the task requires physically going somewhere for non-shopping business like the post office, bank, or notary. | indigo |
| `deal-watch` | Deal watch | Apply when a purchase is on hold pending a sale, coupon, price drop, restock, or comparison-shopping decision. | amber |
| `household-restock` | Household restock | Apply when a consumable at home is running low and needs reordering, like cleaning products, toiletries, or pet food. | orange |
| `warranty-receipt` | Warranty / receipt | Apply when a purchase needs a receipt saved, warranty registered, or a claim or repair filed for an item already bought. | violet |

### Travel & Trips `life-travel`

For someone planning, booking, and managing personal trips end to end.

| id | label | when to apply | color |
|---|---|---|---|
| `flight-booking` | Flight booking | Apply when the demand is to search, choose, book, or change a flight: fares, seats, layovers, or award redemptions. | blue |
| `lodging` | Lodging | Apply when the demand is to find, book, modify, or cancel a place to stay like a hotel, Airbnb, or hostel. | sky |
| `ground-transport` | Ground transport | Apply when arranging on-the-ground travel: rental car, train, ferry, airport transfer, or rideshare. | teal |
| `itinerary` | Itinerary | Apply when building or adjusting the day-by-day plan: routes, daily schedule, reservations, and activity sequencing. | indigo |
| `visa-entry` | Visa & entry | Apply when the task involves a visa, ESTA/eTA, passport validity, vaccination proof, or any border-entry requirement. | red |
| `trip-deadline` | Trip deadline | Apply when an item is time-locked by departure or a booking window like check-in opening, a fare hold, or a refund cutoff. | orange |
| `packing` | Packing | Apply when the demand is to prepare what to bring: a packing list, gear, luggage limits, clothing, or chargers/adapters. | amber |
| `travel-docs` | Travel docs | Apply when gathering or storing confirmations, boarding passes, e-tickets, reservation numbers, and insurance details. | violet |
| `trip-budget` | Trip budget | Apply when the item concerns trip money: setting a budget, comparing prices, expense splitting, currency, or shared costs. | green |
| `destination-research` | Destination research | Apply when researching a place before committing: things to do, neighborhoods, dates/seasons, safety, or local logistics. | fuchsia |

### Learning & Growth `life-learning-growth`

For someone deliberately learning new skills, studying, and building habits outside work.

| id | label | when to apply | color |
|---|---|---|---|
| `course-coursework` | Course | Apply when the demand is enrolling in, watching lectures for, or completing assignments in a structured course or class. | blue |
| `reading-list` | Reading list | Apply when something is a book, article, or paper to read or finish, including a recommendation to add to the queue. | sky |
| `skill-practice` | Skill practice | Apply when the task is a repeatable practice session to drill a skill like an instrument, language, code kata, or drawing. | teal |
| `hobby-project` | Hobby project | Apply when working on a personal creative or maker project pursued for enjoyment like a side build, craft, or game. | green |
| `certification` | Certification | Apply when the item is preparing for, scheduling, or sitting an exam or credential, or renewing one that is expiring. | amber |
| `deadline-cohort` | Deadline / cohort | Apply when a learning item has a hard external date: an application window, assignment due date, or cohort start. | red |
| `mentor-coach` | Mentor / coach | Apply when scheduling or prepping for a session with a teacher, coach, mentor, or study partner, or acting on feedback. | violet |
| `notes-review` | Notes & review | Apply when the task is capturing notes, summarizing what you learned, or revisiting flashcards or material for retention. | indigo |
| `tools-resources` | Tools & resources | Apply when buying, renewing, or setting up the gear, software, subscription, or supplies needed to learn or practice. | orange |
| `goal-milestone` | Goal & milestone | Apply when setting, tracking, or reflecting on a learning goal, streak, or growth milestone rather than a single task. | fuchsia |

### Events & Celebrations `life-events-celebrations`

For someone juggling the social calendar — birthdays, holidays, parties, gifts and the planning behind them.

| id | label | when to apply | color |
|---|---|---|---|
| `rsvp-due` | RSVP due | Apply when an invitation needs a yes/no reply by a date: a wedding, party, dinner, or an invite awaiting your response. | red |
| `date-locked` | Date to hold | Apply when a fixed event date must be saved or blocked so it isn't double-booked, including save-the-dates and annual dates. | orange |
| `gift-to-buy` | Gift to buy | Apply when a present needs to be chosen, bought, wrapped, or shipped for an occasion or person. | fuchsia |
| `birthday` | Birthday | Apply when a birthday is coming up that needs a card, gift, call, or celebration arranged. | pink |
| `anniversary` | Anniversary | Apply when a wedding anniversary, milestone, or memorial date is approaching and needs marking or a plan. | violet |
| `host-prep` | Hosting prep | Apply when you are hosting and need to handle guest list, menu, supplies, cleaning, or setup before people arrive. | amber |
| `venue-vendor` | Venue & vendor | Apply when an event needs a booking or coordination with an outside provider like a venue, caterer, or photographer. | teal |
| `travel-logistics` | Event travel | Apply when attending an event requires travel, lodging, or transport like flights, a hotel, or a ride. | sky |
| `holiday-season` | Holiday | Apply when a holiday is approaching that needs cards, decorations, hosting, gifts, or family plans coordinated. | green |
| `guest-coordination` | Guest coord | Apply when you must collect head counts, dietary needs, plus-ones, carpools, or contributions from other attendees. | blue |
| `thank-you` | Thank-you note | Apply after an event when gifts, hosting, or help should be acknowledged with a note, message, or return gesture. | indigo |

### Digital Life & Subscriptions `life-digital-subscriptions`

For anyone managing their own digital footprint — subscriptions, accounts, devices, and privacy across services.

| id | label | when to apply | color |
|---|---|---|---|
| `renewal-charge` | Renewal coming up | Apply when a subscription or plan is about to auto-renew or just billed and you must decide to keep, downgrade, or cancel. | amber |
| `cancel-trial` | Cancel before trial | Apply when a free trial or promo is ending and you must cancel or opt out before it converts to a paid charge. | red |
| `price-increase` | Price change | Apply when a service announces a price rise or plan change so you can reassess whether it is still worth keeping. | orange |
| `account-security` | Account security | Apply when there is a suspicious login, breach notice, leaked-password alert, or a 2FA/MFA setup to lock down an account. | red |
| `password-credential` | Password & login fix | Apply when you need to reset, rotate, or store a password, recover account access, or clean up your password manager. | violet |
| `device-upgrade` | Device & hardware | Apply when a phone, laptop, or device needs setup, repair, replacement, an OS update, or a warranty/insurance action. | sky |
| `backup-sync` | Backup & storage | Apply when cloud storage is full, a backup failed or is overdue, or you must verify photos or files are safely synced. | teal |
| `privacy-data` | Privacy & data | Apply when adjusting privacy or tracking settings, handling a data-deletion or unsubscribe, or a consent/terms update. | indigo |
| `duplicate-unused` | Unused subscription | Apply when you spot a subscription you no longer use, a duplicate service, or overlapping plans worth consolidating. | fuchsia |
| `refund-billing` | Billing dispute | Apply when wrongly charged, owed a refund, hit by a failed payment, or needing to fix a card or billing error. | pink |

### Pet Care `life-pet-care`

For a pet owner managing vet visits, food, grooming, meds, and the daily care of an animal.

| id | label | when to apply | color |
|---|---|---|---|
| `vet-appointment` | Vet appointment | Apply when a vet visit, vaccination, or checkup must be booked, confirmed, prepped for, or followed up on. | sky |
| `medication` | Medication | Apply when a pet's medication, flea/tick or worming treatment, or supplement needs refilling or administering. | violet |
| `health-concern` | Health concern | Apply when a pet shows a new symptom, injury, or worrying behavior that needs assessment or an urgent vet decision. | red |
| `grooming` | Grooming | Apply when grooming, nail trims, bathing, or a groomer appointment needs scheduling or doing. | teal |
| `food-supplies` | Food & supplies | Apply when pet food, litter, treats, or supplies are running low and need restocking or reordering. | green |
| `walk-exercise` | Walk / exercise | Apply when the item is a walk, exercise, training session, or activity to schedule or arrange for the pet. | amber |
| `boarding-sitter` | Boarding / sitter | Apply when pet care must be arranged while you are away: boarding, a sitter, daycare, or a walker. | indigo |
| `pet-admin` | Pet admin | Apply for pet paperwork: insurance, licensing, microchip, registration, adoption, or vet-record tasks. | gray |

### Vehicle & Car `life-vehicle-care`

For a car or vehicle owner managing service, repairs, insurance, registration, and the costs of keeping it running.

| id | label | when to apply | color |
|---|---|---|---|
| `service-due` | Service due | Apply when routine maintenance is due or coming up: oil change, tires, MOT, inspection, or a scheduled service. | amber |
| `repair` | Repair | Apply when something on the vehicle is broken, making a noise, or has a warning light and needs diagnosis or fixing. | red |
| `insurance` | Insurance | Apply when an auto policy needs renewing, a claim is in progress, or coverage must be quoted or changed. | indigo |
| `registration-tax` | Registration / tax | Apply when registration, road tax, license plates, emissions, or a vehicle's legal paperwork is due. | violet |
| `fuel-charging` | Fuel / charging | Apply when the item is fueling, EV charging, range planning, or a fuel/charging cost or account to handle. | green |
| `parking-tolls` | Parking / tolls | Apply when parking permits, a ticket or fine, toll account, or congestion charge needs paying or sorting. | orange |
| `buy-sell` | Buy / sell | Apply when researching, buying, selling, leasing, or trading in a vehicle is the task. | sky |
| `breakdown` | Breakdown / roadside | Apply when the vehicle is stranded, undriveable, or needs roadside assistance or a tow right now. | teal |

### Job Search & Career `life-job-search`

For someone running a personal job hunt: applications, interviews, networking, and offers.

| id | label | when to apply | color |
|---|---|---|---|
| `application` | Application | Apply when a job needs a tailored application, resume, cover letter, or submission before its closing date. | blue |
| `lead-opportunity` | Lead / opening | Apply when a new role, posting, or opportunity is spotted and needs reviewing or saving to pursue. | sky |
| `interview-prep` | Interview | Apply when an interview must be scheduled, prepped for, attended, or followed up on with a thank-you. | violet |
| `networking` | Networking | Apply when a contact, referral, intro, or coffee chat could advance the search and needs a reach-out. | teal |
| `follow-up` | Follow-up | Apply when you are awaiting a reply from a recruiter or employer, or owe a nudge or status check on an application. | amber |
| `offer-decision` | Offer / decision | Apply when an offer arrives and needs evaluating, negotiating, comparing, or accepting or declining. | green |
| `materials` | Materials / profile | Apply when resume, portfolio, LinkedIn, or other application materials need creating, updating, or polishing. | indigo |
| `deadline` | Deadline | Apply when an application window, assessment, or response is time-locked and risks closing if missed. | red |

## Universal

### Universal / Cross-cutting `universal`

State-and-intent labels that apply to any demand, regardless of role or life context.

| id | label | when to apply | color |
|---|---|---|---|
| `waiting-on` | Waiting on someone | Apply when the next step is owned by another person and you are stalled until they reply, deliver, or decide. | amber |
| `blocked` | Blocked | Apply when work cannot proceed because of a missing dependency, access, decision, or unresolved problem. | red |
| `at-risk` | At risk | Apply when a deadline, commitment, or outcome is in jeopardy and will slip or fail without intervention. | red |
| `needs-decision` | Needs a decision | Apply when the demand is stuck pending a choice you must make before anything else can move forward. | violet |
| `deep-work` | Deep work | Apply when the task requires a long, uninterrupted focus block rather than a quick reactive reply. | indigo |
| `quick-win` | Quick win | Apply when the task can be fully finished in a few minutes with little effort or context. | green |
| `delegated` | Delegated | Apply when you have handed the work off to someone else and are only tracking it to completion. | teal |
| `follow-up` | Follow-up | Apply when this is a reminder to circle back, chase a reply, or check in on something already in motion. | sky |
| `scheduled` | Scheduled | Apply when the item is locked to a specific date or time, like a meeting, appointment, or hard-dated commitment. | blue |
| `snoozed` | Snoozed / deferred | Apply when the item is intentionally parked until a later date and should not resurface or be acted on before then. | orange |
| `reference` | Reference / saved | Apply when the item is kept for lookup or context rather than action, such as a doc, link, or saved detail. | gray |
