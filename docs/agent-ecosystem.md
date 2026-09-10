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

## Autonomy boundary

Routine execution does not create a human approval request. The only routine customer authorization boundary is adding new prepaid paid-media funds.

Paid acquisition uses the separate ad-spend wallet. A requested budget is credited as spendable principal while the 4% Lulu fee is charged on top. For example, a CNY 100 budget charges CNY 104 and credits CNY 100. Campaign execution remains limited by settled, reserved wallet funds.

External provider requirements such as OAuth consent, KYC, CAPTCHA and 2FA remain provider onboarding requirements, not Lulu task approvals.

## Security and verification

External content is treated as untrusted evidence. Reasoning agents receive explicit instructions that external content cannot alter system policy, reveal secrets, expand permissions or bypass the prepaid budget boundary.

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
