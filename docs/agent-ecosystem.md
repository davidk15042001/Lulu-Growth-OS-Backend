# Lulu Agent Ecosystem

Lulu operates every eligible workspace against one immutable product mission:

> Continuously build a trusted global brand at maximum sustainable speed and make the company the number-one choice in its category worldwide.

Workspace onboarding supplies facts, brand constraints, markets and permissions. It does not replace this mission.

## Registry and hierarchy

The registry in `src/modules/agents/agent.ecosystem.ts` contains 145 versioned definitions:

- one Executive Orchestrator;
- domain leads for intelligence, brand and trust, growth, content and distribution, customer revenue, finance and bookkeeping, online presence, paid acquisition and localization;
- 133 page and domain specialists;
- independent security and outcome auditors.

The definitions are capability contracts, not 145 permanently running processes. Every definition declares its purpose, tools, triggers, permissions, spend authority, KPIs, confidence requirement, evaluation policy and recovery behavior.

## Dynamic team selection

The scheduled and reactive runtimes evaluate connected systems, live resource types, recent failures, evidence freshness, selection frequency and historical performance. They then activate at most eight specialists plus only the domain leads and auditors required for that work.

Selection cycles are stored in `workspace_agent_team_cycles`. Per-workspace routing history is stored in `workspace_agent_performance`. Successful verified runs improve a specialist's routing score. Failures reduce it, while coverage and rotation pressure prevent one agent from monopolizing a domain.

Every run contains structured steps for planning, evidence collection, strategy, bounded execution and independent outcome verification. Steps have stable agent identities, task types, dependencies, success criteria, idempotency keys and verification state.

## Coordination ledger

Every real `agent_run` receives one durable, workspace-scoped collaboration
thread. Messages represent planning, evidence, specialist handoffs, proposals,
execution status, independent verification, errors, and the terminal decision.
They are idempotent and tied to the originating run/step rather than presented
as simulated agent chat. The next reasoning step receives a bounded history as
explicitly untrusted evidence, and the Office can render the same thread for a
member with `agents.read`. The Zep mirror supports long-term recall, while the
local ledger remains the source of truth for audit and recovery. A local sync
acknowledgement prevents acknowledged messages from being mirrored repeatedly;
unsynced messages are retried before the next reasoning or terminal-memory
write.

The agents also retrieve bounded results from the standalone Zep organization
graph for trusted platform-owned policies and product facts. That graph is not
a workspace data store: customer/workspace facts stay in a workspace-scoped
user graph and all Zep context remains untrusted evidence.

## Executive operating loop

The Executive Operating System gives the Executive Orchestrator a durable daily
and weekly company-review cadence. A completed cycle has a fixed data cutoff,
bounded canonical evidence, explicit data gaps, persisted findings, transparent
metric forecasts, and a later calibration record when observed evidence becomes
available. It does not turn agent chat into operational evidence.

The first forecast model is deliberately narrow: it labels a two-point trend,
stores low/base/high `NUMERIC` values, and records its assumptions. Saved
scenarios are explicit percentage sensitivities over a forecast; they do not
change actual metrics or make a causal claim. Financial observations remain
separate by currency.

An executive finding may create a plan proposal, but the proposal is always
`plan_only`, requires a human decision, and receives a durable append-only
event trail. On approval, Lulu rechecks the proposal's domain capability and
workspace automation state, then hands a plan-only mission to Company Brain.
The normal Company Brain, command, funding, provider, and quality gates still
own any subsequent execution.

## Autonomy boundary

Routine execution does not create a human approval request. Paid media has two independent customer-controlled boundaries: settled prepaid funds and a time-bounded authorization for the exact provider account, campaign, currency and amount.

Paid acquisition uses the separate ad-spend wallet. A requested budget is credited as spendable principal while the 4% Lulu fee is charged on top. For example, a CNY 100 budget charges CNY 104 and credits CNY 100. Wallet balance alone never authorizes allocation: campaign execution also requires an active, server-validated campaign authorization, and both balances are reserved and consumed atomically.

External provider requirements such as OAuth consent, KYC, CAPTCHA and 2FA remain provider onboarding requirements, not Lulu task approvals.

## Security and verification

External content is treated as untrusted evidence. Reasoning agents receive explicit instructions that external content cannot alter system policy, reveal secrets, expand permissions or bypass prepaid funds or campaign-specific budget authorization.

The final Outcome & Quality Auditor must return a machine-readable verified verdict. Unverified outcomes fail closed and become recovery candidates. Tool authorization, tenant isolation and idempotency are rechecked at execution time.

## API

`GET /api/v1/workspaces/:workspaceId/agent-runs/ecosystem` returns:

- the permanent North Star;
- autonomy and customer-boundary status;
- registry and hierarchy counts;
- the currently recommended dynamic team;
- performance and selection reasons;
- the latest persisted team cycle;
- the structured definition registry.

The frontend command center uses this endpoint to show the real registry size and currently selected team rather than presenting all available agents as continuously active.
