# Lulu Autonomous Company OS — architecture and capability audit

Status date: 2026-09-18

## Latest verified production release

The following evidence was checked after the latest combined deployment:

- Frontend commit: `420bf37391bf9309301f982d6dd5c2f335a9bfab`
- Backend commit: `f2cc4cda2a2a4a69e2eb849d4b6619ead0859ed0`
- `https://lulu-ai.cn/api/v1/health`: HTTP 200 (`status: ok`)
- `https://lulu-ai.cn/api/v1/ready`: HTTP 200 (`status: ready`)
- Frontend production root: HTTP 200
- Backend automated validation: typecheck, migration verification, 330 tests, build and smoke checks passed; the canonical UnifyPort outbound WhatsApp path and historical paid-top-up invoice reconciliation are covered by idempotency tests
- Office route parity: all 45 persisted Digital Employee roles from the canonical roster resolve to a registered Workspace route; the frontend audit also passes with no routing, API-contract, branding, i18n, feedback, error, or agentic-UI issues
- Read-only UnifyPort adapter check: the configured workspace and account endpoint returned `CONNECTED`/`HEALTHY`; workspace/account capabilities and WhatsApp send/receive capability were reported `AVAILABLE`. No message was sent by this check; outbound/inbound sender and webhook acceptance still require a dedicated provider E2E test.
- A repeatable opt-in `provider:live-readiness` gate now performs the same read-only verification, health, capability, and account-discovery checks and exits non-zero on any unavailable result; the configured UnifyPort check returned `READY` with one discovered account.
- The live-readiness gate now reports provider failures as structured, secret-safe `BLOCKED` results (including provider error codes) instead of leaking a diagnostic stack trace; the unreachable-provider path was verified locally.

This release evidence proves that the deployed application is healthy; it does not replace live third-party provider acceptance tests listed in the launch gates below.

This document is the source-driven baseline for Lulu's Office and Workspace architecture. It distinguishes persisted, executable capability from UI representation. A label, page, agent definition, or provider catalog entry is not treated as proof that an external side effect works.

## Classification

- **EXISTS** — canonical data and a usable backend path exist and are covered by automated tests.
- **PARTIAL** — a meaningful implementation exists, but at least one provider, workflow, UI, or production verification gap remains.
- **MISSING** — no canonical production implementation was found.
- **BROKEN** — an existing path violates a required invariant or fails its verified contract.
- **DUPLICATED** — more than one path represents the same business object or action without a canonical owner.
- **LEGACY** — retained for compatibility, but not the target architecture.
- **UNKNOWN** — the repository cannot prove an external account, approval, or production behavior.

## Non-negotiable target architecture

```text
Provider/webhook/user/schedule
  -> durable domain event
  -> idempotent workflow / agent run
  -> Digital Employee assignment
  -> registered command + server policy
  -> canonical domain service
  -> provider adapter or internal mutation
  -> verified outcome / retry / dead letter
  -> audit log + Office projection + Workspace view
```

Office and Workspace are views over the same services and records. Digital Employees are role-level projections over multiple agents, tools, workflows, and integrations; they are not one-to-one aliases for model prompts. An Office employee may only appear busy when a corresponding persisted work item, run step, or action packet is actually active.

## Repository inventory

- Backend: Express/TypeScript, PostgreSQL migrations, workspace-scoped services, durable domain-event runtime, workers, REST APIs, SSE, provider control plane, 145 registered specialist definitions, and canonical modules for several core domains.
- Google Business now runs through a real Provider Control Plane adapter: verification, health, capability probes, account/location discovery, and durable discovery snapshots all reuse the canonical OAuth/API service and are tenant-scoped. Provider connections also expose a durable, read-only contract-check record so a workspace can distinguish a real adapter result from catalog metadata.
- Frontend: React/TypeScript, a large generated Workspace page catalog, canonical replacement pages for critical domains, shared API clients, route contracts, authenticated navigation, and the new Office view.
- Persisted events support idempotency keys, attempts, delayed retry, locking, dead-letter state, causation/correlation metadata, and workspace scoping.
- Authorization is capability based. Workspace membership remains the tenant boundary; the database does not currently use PostgreSQL row-level security.

## Capability matrix

| Capability | State | UI | Backend / data | Agent / event | Permission | Integration / remaining gap |
|---|---|---|---|---|---|---|
| Authentication and sessions | EXISTS | Login, profile, active sessions | Users, sessions, password/security flows | Security events and audit paths | Auth middleware | External identity availability still depends on configured OAuth providers |
| Workspace tenancy | EXISTS | Workspace selection and settings | Workspaces, members, composite tenant constraints | `workspace.*` events | Capability/RBAC registry | Add database RLS only as a separate defence-in-depth project |
| Activation gate | EXISTS | Company information, billing, profile, knowledge | Persisted activation state and route gate | Post-payment/knowledge automation | Owner/admin onboarding rules | AI processing still requires funded AI wallet and configured model provider |
| Admin billing skip | EXISTS | Admin control and gated customer flow | Audited entitlement override separated from payment rights | Workspace activation event | Admin-only | Skip replaces only the subscription gate: customer AI/ad wallets remain prepaid, are still charged normally and receive no synthetic funds |
| AI prepaid wallet | EXISTS | Fixed RMB top-up choices plus available, reserved, spent and reversal-debt state | Upper-bound funds are atomically reserved before customer-funded AI dispatch, settled to exact usage and released debt-first; ambiguous provider outcomes retain their hold | A usable funded event resumes eligible work only after debt is cleared | Workspace admin | Card-invoice top-ups require exact provider-processed Billing Transaction proof; a paid label or out-of-band mark never mints balance; Airwallex billing now has a read-only Provider Control Plane contract |
| Advertising wallet | EXISTS | Fixed RMB top-ups and available/reserved/spent/reversal-debt state | Wallet, ledger, preserved reservations, debt-first release and provider-observed spend settlement | Funding and verified spend events | `advertising.budget_authorize` | Wallet balance alone is deliberately insufficient authority; chargebacks block new spend without corrupting unrelated reservations |
| Campaign budget authorization | EXISTS | Exact provider/account/campaign/amount/period control | Time-bounded authorization, atomic reserve/consume/release | Budget authorization events | `advertising.budget_authorize` | Google Ads execution is fail-closed to verified CNY accounts until FX is implemented |
| Agent registry and team selection | EXISTS | Agent activity surfaces | 145 capability contracts and performance-based selection; verified quality feedback now calibrates the producing employee once per source event | Scheduled/reactive run events and quality-feedback learning | `agents.read/execute/manage` | Definitions are not 145 permanent processes, by design |
| Multi-agent collaboration | EXISTS | Office contributors and involved agents | Parent plan delegates to persisted selected specialists; results are handed back to the parent | Run steps and action packets | Agent permissions + command policy | Conflict resolution is deterministic policy/reviewer based, not unrestricted agent debate |
| Registered execution commands | PARTIAL | Workspace action outcomes | Server-owned allowlist, risk and budget policy; concrete command materialization | Command packet lifecycle | Canonical service permissions | CRM company enrichment, CRM/Sales pipeline transitions, autonomous quote creation/delivery, guarded invoice issue/delivery, native calendar event creation, website domain verification, and canonical product create/update execute through domain services; command vocabulary still does not cover every generated Workspace page |
| Autonomous scheduler | EXISTS | Observed status and cadence control | Automatic cycles with durable per-workspace cadence (15 minutes–24 hours), dedupe, and funded-workspace checks | Durable scheduled events | Entitlement + AI funds | Provider-specific schedules remain integration-dependent |
| Reactive autonomy | EXISTS | Timeline reflects resulting work | Source-event identity is persisted on idempotent employee runs; record, integration, funding, message, commerce, finance, media, website and social events are routed to responsible employees | Durable event consumers with exact event dedupe; Company Brain task updates wake dependency dispatch immediately | Same policies as manual paths | Agent-originated outputs are excluded from reactive re-entry; new domains extend the explicit event map |
| Human control | EXISTS | Pause, resume, retry, cancel, take over | Optimistically locked Office commands and canonical work item state | Audited control events | `agents.manage` | Human control changes ownership of the same work item; it creates no duplicate business object |
| Office projection | EXISTS | CEO KPIs, departments, employees, timeline, work panel | Digital employees, complete role capabilities, work items, assignments, dependencies, attempts, events | Projects real runs/steps/action packets | `agents.read/manage` | Unavailable capabilities remain visible but never appear falsely active; execution identities now receive the complete role capability set for canonical workspace actions |
| Office to Workspace deep links | EXISTS | Record-aware “Open in Workspace” | Shared typed capability/route registry | Preserves object context | Destination page permission | Only canonical Workspace pages can guarantee full embedded parity today |
| CRM companies | PARTIAL | Canonical companies-only CRM workspace | Workspace records plus company-intelligence enrichment and immutable per-attempt research snapshots; Salesforce, HubSpot and Pipedrive now have tenant-scoped probes and a guarded, idempotent `crm.company.sync` write command with provider object mappings; ambiguous provider responses are durably marked `UNCERTAIN` and are never replayed automatically | Record events, research worker, autonomous `crm.company.enrich`/`crm.company.sync` commands | `crm.read/manage` | Live tenant E2E, OAuth re-consent with write scopes and provider-specific field validation remain launch gates; a separate company schema is not required because canonical records remain authoritative |
| CRM contacts | LEGACY | Hidden from primary CRM navigation by product decision | Generic record type remains for compatibility | Available to internal workflows | CRM permissions | Not a primary customer-facing entity under the current product model |
| Company intelligence | PARTIAL | Company fields, generated descriptions and research-history endpoint | Research/enrichment service, worker and append-only evidence snapshots | Company record events | CRM permissions | Internet coverage and result quality depend on DataForSEO/provider configuration; human review of uncertain facts is still required for high-stakes use |
| Sales leads/opportunities/tasks | PARTIAL | Consolidated Workspace routes plus `/sales-pipeline` state API | Tenant-scoped `workspace_records`; canonical quotes are separate | Durable record events, follow-up commands, guarded pipeline transitions and CRM company sync | Leads/opportunities/quotes capabilities | Lead/opportunity/task state machines now enforce allowed transitions and optimistic locking; provider lead/opportunity sync and full UI adoption remain |
| Quotes | EXISTS | Canonical commercial-document page | Versioned quotes, lines, policy, public link and delivery state | Quote lifecycle events | Quote capabilities | Provider delivery remains dependent on configured communication channels |
| Invoices | EXISTS | Canonical commercial-document page | Invoices, lines, lifecycle, public link and delivery state | Invoice lifecycle events | Invoice capabilities | Operational accounting journal/payment reconciliation is a separate layer |
| Bookkeeping ledger | EXISTS | Canonical journals, invoice payments, account balance and trial balance | Immutable balanced minor-unit journals with idempotent payment application | Invoice issue/payment projections | `finance.read/manage` | Operational subledger only; statutory accounting, bank feeds and jurisdiction-specific tax compliance require separate certification |
| Products | EXISTS | Canonical product workspace | Product master, variants, media, certificates, translations and markets | Product lifecycle events | Product capabilities | External commerce export/import remains provider dependent |
| Premium product media | EXISTS | Product media controls/status | Kie.ai jobs, quality checks, retryable worker and per-candidate prepaid reservations against a server-owned maximum-credit catalog | Product/media events | Product permissions + AI wallet | Unknown models fail closed; live quality and model availability still require Kie credentials and provider capacity |
| Orders, inventory, fulfillment | EXISTS | Canonical Orders and Inventory workspaces | Canonical orders/lines, locations/levels, append-only movements and fulfillments with optimistic locking and idempotency | Full commerce lifecycle events and agent command adapters | `orders.read/manage` | External store synchronization remains provider-specific; generic legacy records are non-authoritative |
| Website generation | EXISTS | Website workspace | Persisted generation jobs and worker | Website generation events, autonomous domain verification and publish commands | `website.read/manage` | Lulu-managed sites now have a real Provider Control Plane adapter; external provider publish support varies |
| WordPress publishing | PARTIAL | Website/CMS pages | Provider Control Plane now performs a real tenant-scoped read/health/discovery/sync check through the canonical WordPress service; publish/media mutations remain guarded by provider response verification | Website job events | `website.publish` | Capability depends on endpoint credentials, WordPress configuration and provider write confirmation |
| Webflow CMS | PARTIAL | Website/CMS pages | Provider Control Plane now performs a real tenant-scoped site/collection/domain read and sync check through the canonical Webflow service; CMS writes remain guarded by provider response verification | Website jobs | `website.publish` | Not every CMS mutation has end-to-end tests against a live tenant |
| Shopify | PARTIAL | Connection setup and commerce pages | Provider Control Plane now verifies the canonical shop API, discovers the shop and a read-only products asset, and reports scope-aware product/order capabilities; mutation/sync evidence remains guarded | Provider events | Provider/commerce permissions | Full product/order synchronization and live tenant E2E remain to be proven; UI must not claim mutation success without provider evidence |
| Email | EXISTS | Canonical email workspace | Gmail, Microsoft, IMAP/SMTP providers; sync and drafts | Sync events and agent draft commands | Email/workspace permissions | Autonomous draft creation is safe; actual sending is a distinct canonical action |
| Calendar | EXISTS | Canonical calendar workspace | Google/Microsoft calendar services and sync | Calendar sync events | Workspace/calendar permissions | Some listed calendar providers are catalog-only/partial |
| OmniChannel | EXISTS | Canonical conversations, manual send/note/takeover | Conversations/messages/routing, SSE, provider identities | Message lifecycle + AI reply worker; conversation context can be normalized into an idempotent autonomous send command | `omnichannel.read/reply/manage` | Channel availability must follow provider capability state |
| Twilio messaging | EXISTS | Admin/provider setup | Adapter, webhook verification, send/status handling | Provider and message events | Provider permissions | Production WhatsApp sender approval remains external to Lulu |
| UnifyPort WhatsApp | PARTIAL | Admin/provider setup | Adapter and API client | Provider events | Provider permissions | Beta/provider authorization and supported-channel behavior must be verified live |
| Provider contract checks | EXISTS | Workspace Integrations panel: readiness check and history | Persisted tenant-scoped verification, health, capability and discovery phases with redacted failure evidence | Provider action audit event | `providers.manage` to run, `providers.read` to inspect | The check proves only the registered adapter and current credentials; external approval, billing and provider-side policy gates remain explicit launch gates |
| Autonomous provider launch gate | EXISTS | Provider readiness evidence is visible before work is enabled | Agent action packets and assistant actions re-check the provider gate immediately before execution; missing, unverified, unhealthy or unsynchronized connections fail closed with a persisted specific error | Same gate runs at registration and execution, with tenant-scoped readiness evidence | Existing command capability plus provider contract state | Provider-specific live E2E and external approval remain launch gates; canonical Lulu-only mutations do not require a third-party connection |
| Facebook/Instagram Messenger | PARTIAL | Twilio Messenger provider-control adapter, OmniChannel sender/inbound/outbound paths | Facebook Messenger now has real sender verification, capability discovery and sync; live sender/webhook/provider approval remain environment-dependent | Provider webhook + OmniChannel | Provider permissions + registered sender | Do not present as live until a workspace sender and verified Twilio webhook pass provider E2E |
| Social publishing | PARTIAL | Canonical accounts, content and publication jobs in Marketing | Facebook and Instagram now use the canonical social-account and Meta Graph identity check in the Provider Control Plane; tenant-scoped content/jobs/attempts retain optimistic locking, retries and dead-letter handling | Social lifecycle events and autonomous publish/retry/cancel commands | Workspace editor + provider scopes | Real Facebook Page and Instagram Business single-image publishing exists; live Meta review, credentials and reauthorization remain external launch gates |
| Google Ads | PARTIAL | Budget/optimization pages | Provider Control Plane account read/health/capability/discovery checks now reuse the canonical read-only Google Ads API path; hard authorization and full-cap reservation, immutable payer mapping, real campaign mutation, observed-cost settlement and final invoice-coverage release remain in the ad-spend service | Ad events/action packets plus critical reconciliation worker | Advertising capabilities | Backend is fail-closed to verified CNY custom-period campaigns; live Google approval, credentials, managed-payer setup and sandbox/production evidence remain external gates |
| Meta/TikTok/LinkedIn Ads | PARTIAL | Integration and analytics pages | Meta, LinkedIn and TikTok now have real read-only account/reporting probes in the Provider Control Plane | Provider discovery/sync for Meta, LinkedIn and TikTok | Advertising capabilities | All three providers remain mutation-gated until prepaid payer, budget authorization, observed-cost settlement and provider approvals are verified |
| Google Business reviews | EXISTS | Review workspace | Location/review read and reply service | Review command | Workspace/provider permission | Live use requires valid Business Profile OAuth scopes |
| Analytics/metrics | PARTIAL | Consolidated analytics/statistics views | Google Analytics now discovers tenant-accessible GA4 properties through the Admin API and reads a bounded 28-day Data API report during sync; Company Brain exposes an evidence-backed Market Leadership Scorecard grouped by customer, product, intelligence, growth, economics, trust and innovation; canonical metrics plus many generic report resources remain | Metric events | Read/reporting capabilities | The scorecard reports measured/defined/unavailable evidence and never invents an aggregate score. Several generated dashboards, attribution models and write-side analytics workflows still need dedicated provider coverage |
| Notifications/audit | EXISTS | Notifications and Office timeline | Persisted notifications, audits and domain events | Notification event | Read/audit permissions | Timeline labels are summaries; raw evidence stays inspectable |
| Runtime readiness | EXISTS | Operational status surfaces | Database, migration, AI, billing/email and per-worker progress checks | Every customer-facing autonomous loop is readiness-critical; housekeeping remains observable | Admin/operations | Readiness proves configuration and real worker progress, not every external provider mutation |
| Background reliability | EXISTS | Errors/status surface through work items | Retry, delayed availability, stale-lock recovery, dead-letter state and graceful active-cycle drain | Worker runtime | Service policy | Provider-specific retryability remains adapter-defined |

## Digital employee map

| Department | Digital employee | Canonical responsibilities | Internal capabilities |
|---|---|---|---|
| Executive | Executive Orchestrator | Select objectives, coordinate departments, continue the operating loop | Team selection, run planning, dependencies, business events |
| Executive | Security & Policy Auditor | Enforce tenant, permission, provider and budget boundaries | RBAC, execution-command policy, credential boundary, audits |
| Executive | Outcome & Quality Auditor | Verify evidence and outcomes without inventing success | Reviewer steps, provider result state, retries/dead letters |
| CRM & Sales | Company Intelligence Specialist | Research and enrich company accounts | CRM records, search intelligence, customer questions |
| CRM & Sales | CRM Manager | Maintain the canonical customer/company context | CRM records, activities, related objects |
| CRM & Sales | Customer Manager | Maintain complete customer and company context | CRM records, enrichment, related objects |
| CRM & Sales | Lead Generation Specialist | Find qualified opportunities from verified signals | Leads, company intelligence, event signals |
| CRM & Sales | Lead Qualification Specialist | Qualify leads using persisted evidence | Leads, CRM context, policy-bound transitions |
| CRM & Sales | Opportunity Manager | Maintain opportunity stages and next actions | Opportunities, follow-ups, quotes |
| CRM & Sales | Sales Representative | Coordinate evidence-backed sales handoffs | Leads, opportunities, quotes, communication |
| CRM & Sales | Follow-up Specialist | Create and complete next actions | CRM/sales tasks, calendar, OmniChannel/email |
| CRM & Sales | Quote Specialist | Build, version, send and track quotes | Commercial documents and delivery |
| Communications | OmniChannel Manager | Route and manage conversations across enabled identities | Conversation/message service, channel adapters, SSE |
| Communications | Customer Communication Specialist | Understand intent and compose/send policy-compliant responses | Knowledge, CRM context, message commands |
| Communications | Customer Support Specialist | Handle persisted support conversations | OmniChannel, knowledge, customer context |
| Communications | Email Specialist | Synchronize threads and manage drafts/messages | Email providers and sync events |
| Operations | Calendar Coordinator | Schedule and synchronize follow-ups | Calendar providers and events |
| Marketing | Brand & Content Strategist | Plan evidence-based content aligned to the permanent brand mission | Knowledge, content jobs, website/social destinations |
| Marketing | Marketing Manager | Coordinate brand, content, distribution, and measured growth | Website, social, advertising, analytics |
| Marketing | Content Specialist | Create and distribute evidence-backed content | Content jobs, website, social destinations |
| Marketing | Paid Acquisition Specialist | Analyze and optimize authorized campaigns | Advertising evidence, campaign authorization, provider adapter |
| Online Presence | Website Manager | Generate, maintain and publish sites | Website jobs, WordPress/Webflow adapters |
| Online Presence | Pages & CMS Manager | Manage pages, posts, CMS collections and assets | Reused Workspace website components |
| Online Presence | Media & Assets Manager | Maintain the canonical media library | Website media, product media, storage |
| Online Presence | Domain Manager | Verify domains and coordinate safe publication | Website domains, DNS ownership proof |
| Online Presence | Reviews & Reputation Manager | Monitor and answer verified reviews | Google Business and review records |
| Online Presence | Search Visibility Manager | Coordinate SEO/GEO/AEO work | Search intelligence, content/publications |
| Commerce | Product Manager | Own canonical products and variants | Product master and provider mappings |
| Commerce | Premium Media Producer | Produce and quality-check product images/video | Kie media jobs and product media |
| Commerce | Category Manager | Organize catalog taxonomy | Commerce category records |
| Commerce | Store Manager | Coordinate managed storefront operations | Products, orders, inventory, website |
| Commerce | Order Manager | Process canonical orders | Orders, order lines, lifecycle events |
| Commerce | Inventory Manager | Maintain stock and reservations | Inventory levels, movements, reservations |
| Commerce | Fulfillment Manager | Coordinate verified fulfillment handoffs | Fulfillments, orders, provider evidence |
| Commerce | Order & Fulfillment Manager | Process orders, inventory and fulfillment | Canonical commerce service, inventory reservations, lifecycle events and provider sync |
| Finance | Invoice Manager | Create, issue, deliver and track invoices | Commercial documents |
| Finance | Bookkeeping Specialist | Post balanced operational journals and reconcile payments | Immutable ledger and finance engine |
| Finance | Finance Operations Manager | Coordinate billing, usage, receivables, and finance controls | Billing, usage ledgers, invoices, journals |
| Finance | Billing & Usage Manager | Manage subscription, AI, storage and advertising funding | Billing, wallets and usage ledgers |
| Operations | Integration Manager | Connect, verify, monitor and recover providers | Provider control plane |
| Operations | Automation Manager | Monitor schedules, event delivery, and safe recovery | Agent runtime, provider sync, readiness |
| Operations | Operations Manager | Coordinate cross-system operational reliability | Providers, workspace operations, audits |
| Analytics | Business Intelligence Analyst | Explain real KPIs, anomalies and funnel impact | Metrics, domain events, reports |
| Analytics | Analytics Manager | Coordinate verified metrics and reporting | Metrics, provider reports, quality evidence |
| Analytics | Commerce Analytics Manager | Measure catalog, order, inventory, and fulfillment performance | Commerce records, metrics, event history |

## Decisions and known boundaries

1. The permanent mission is fixed by product policy: continuously build a trusted global brand at the maximum sustainable speed and become the number-one choice in the customer's category. Customers provide facts, constraints, connections, and budget authority; they do not need to invent agent goals.
2. Routine work is autonomous. Customer authorization is required only for a new or increased paid-media budget. The rule is enforced by the backend at both command registration and provider reservation.
3. A prepaid advertising wallet is funding, not authorization. Provider, account, campaign, currency, period, and maximum amount must match an active authorization.
4. “Queued” is not “completed.” Provider side effects remain pending until their worker/provider result reaches a terminal verified state.
5. Unsupported providers fail closed and surface an unavailable/limited state. Catalog presence never creates a fake connected state.
6. Manual and autonomous actions must call the same domain service. The actor type, causation, and source differ; the business object does not.
7. Lulu's ledger is an operational subledger unless jurisdiction-specific accounting configuration and compliance verification are explicitly supplied. It must not claim statutory books by default.

## Release gates

- Migrations apply cleanly from zero and from the previous production migration.
- Backend typecheck, unit/integration tests, build, and built-server smoke test pass.
- Frontend typecheck, route/API/brand/i18n/feedback/error/agentic audits, and build pass.
- No generated UI contains static example KPIs presented as live information.
- Every Office active state is traceable to a persisted work item and underlying event/run/action packet.
- Verified quality feedback must be replay-safe and must influence future employee routing without creating a second business action.
- Every mutation enforces workspace identity and capability server-side.
- Advertising launch/increase fails without exact active customer authorization and sufficient wallet funds.
- Customer-funded AI and premium-media calls reserve a conservative maximum before dispatch; unknown outcomes keep funds held and only verified usage settles the hold.
- Airwallex invoice top-ups credit wallets only after exact, in-band, provider-processed Billing Transactions prove the expected net CNY payment.
- Google Ads keeps the full authorized cap reserved until provider cost observations settle actual spend and final matching billing coverage permits release of the remainder.
- Provider sandboxes/live test accounts verify webhooks, send/publish mutations, retries, idempotency, and status callbacks before that provider is marketed as production-ready.
- Security, privacy, retention, backup/restore, incident response, and jurisdictional compliance receive a separate launch review.
