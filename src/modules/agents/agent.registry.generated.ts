export type CanonicalAgentPageProfile = {
  pageId: string;
  pageLabel: string;
  sectionLabel: string;
  agentName: string;
  autonomy: string;
  objective: string;
  integrations: string[];
  jobs: string[];
  successMetrics: string[];
  approvalGates: string[];
};

export const canonicalAgentPageProfiles: readonly CanonicalAgentPageProfile[] = [
  {
    "sectionLabel": "Dashboard",
    "pageId": "fancily-leaf-1766",
    "pageLabel": "Executive Dashboard",
    "agentName": "CEO Agent",
    "autonomy": "A2",
    "objective": "Run the workspace from one command center.",
    "integrations": [
      "All connected systems"
    ],
    "jobs": [
      "roll up signals",
      "reprioritize work"
    ],
    "successMetrics": [
      "issue detection speed",
      "task throughput"
    ],
    "approvalGates": [
      "cross-domain execution"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "serene-cloud-7079",
    "pageLabel": "Intelligence Overview",
    "agentName": "Chief Intelligence Agent",
    "autonomy": "A2",
    "objective": "Merge business signals into one model.",
    "integrations": [
      "All domain data"
    ],
    "jobs": [
      "aggregate signals",
      "cluster themes"
    ],
    "successMetrics": [
      "insight quality",
      "duplicate reduction"
    ],
    "approvalGates": []
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "tender-water-4095",
    "pageLabel": "Executive Overview",
    "agentName": "Management Briefing Agent",
    "autonomy": "A2",
    "objective": "Prepare the operator briefing.",
    "integrations": [
      "All major KPIs",
      "risk and approval streams"
    ],
    "jobs": [
      "prepare daily brief",
      "summarize changes"
    ],
    "successMetrics": [
      "brief usefulness",
      "decision response time"
    ],
    "approvalGates": [
      "external sharing"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "swiftly-cliff-4166",
    "pageLabel": "Business Health",
    "agentName": "Business Health Agent",
    "autonomy": "A2",
    "objective": "Detect business health deterioration early.",
    "integrations": [
      "Revenue",
      "ops",
      "support",
      "traffic"
    ],
    "jobs": [
      "compute health score",
      "watch trend shifts"
    ],
    "successMetrics": [
      "time to detection",
      "alert precision"
    ],
    "approvalGates": [
      "auto-remediation"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "sharp-current-9677",
    "pageLabel": "Growth",
    "agentName": "Growth Agent",
    "autonomy": "A3",
    "objective": "Continuously find growth levers.",
    "integrations": [
      "Marketing",
      "sales",
      "product",
      "finance"
    ],
    "jobs": [
      "find bottlenecks",
      "score opportunities"
    ],
    "successMetrics": [
      "qualified opportunities",
      "revenue impact"
    ],
    "approvalGates": [
      "launching major growth actions"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "proudly-river-8017",
    "pageLabel": "Revenue",
    "agentName": "Revenue Agent",
    "autonomy": "A2",
    "objective": "Explain and improve revenue performance.",
    "integrations": [
      "Orders",
      "subscriptions",
      "invoices",
      "attribution"
    ],
    "jobs": [
      "detect leakage",
      "trace revenue drivers"
    ],
    "successMetrics": [
      "revenue retention",
      "leakage reduction"
    ],
    "approvalGates": [
      "pricing changes"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "dreamily-shade-6192",
    "pageLabel": "Customers",
    "agentName": "Customer Understanding Agent",
    "autonomy": "A2",
    "objective": "Explain who the best customers are.",
    "integrations": [
      "CRM",
      "commerce",
      "reviews",
      "support"
    ],
    "jobs": [
      "build segments",
      "score customer value"
    ],
    "successMetrics": [
      "LTV prediction quality",
      "churn-risk coverage"
    ],
    "approvalGates": [
      "outbound customer activation"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "nicely-hour-4035",
    "pageLabel": "Sales",
    "agentName": "Sales Oversight Agent",
    "autonomy": "A3",
    "objective": "Keep sales performance healthy.",
    "integrations": [
      "CRM",
      "pipeline",
      "activities"
    ],
    "jobs": [
      "inspect pipeline",
      "rank deals"
    ],
    "successMetrics": [
      "pipeline velocity",
      "win rate lift"
    ],
    "approvalGates": [
      "external sales communication"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "eagerly-winter-3152",
    "pageLabel": "Marketing",
    "agentName": "Marketing Oversight Agent",
    "autonomy": "A3",
    "objective": "Coordinate the marketing system.",
    "integrations": [
      "Campaign tools",
      "web analytics",
      "SEO"
    ],
    "jobs": [
      "rank priorities",
      "detect channel shifts"
    ],
    "successMetrics": [
      "traffic growth",
      "conversion lift"
    ],
    "approvalGates": [
      "campaign launches"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "sharply-wood-4560",
    "pageLabel": "Advertising Intelligence",
    "agentName": "Ads Intelligence Agent",
    "autonomy": "A3",
    "objective": "Explain paid media health.",
    "integrations": [
      "Ad platforms",
      "attribution",
      "spend"
    ],
    "jobs": [
      "detect waste",
      "monitor ROAS"
    ],
    "successMetrics": [
      "ROAS improvement",
      "wasted spend reduction"
    ],
    "approvalGates": [
      "budget reallocations"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "bold-ocean-5847",
    "pageLabel": "Ecommerce Intelligence",
    "agentName": "Commerce Intelligence Agent",
    "autonomy": "A3",
    "objective": "Explain store performance and buying behavior.",
    "integrations": [
      "Storefronts",
      "catalog",
      "orders",
      "carts"
    ],
    "jobs": [
      "detect conversion leaks",
      "identify product patterns"
    ],
    "successMetrics": [
      "conversion rate",
      "AOV"
    ],
    "approvalGates": [
      "live commerce changes"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "cozily-path-5612",
    "pageLabel": "Finance Intelligence",
    "agentName": "Finance Intelligence Agent",
    "autonomy": "A2",
    "objective": "Interpret the company's financial condition.",
    "integrations": [
      "Finance records",
      "billing",
      "cash data"
    ],
    "jobs": [
      "model trends",
      "summarize cash position"
    ],
    "successMetrics": [
      "forecast accuracy",
      "liquidity visibility"
    ],
    "approvalGates": [
      "money-moving actions"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "gently-light-6089",
    "pageLabel": "Operations Intelligence",
    "agentName": "Operations Agent",
    "autonomy": "A3",
    "objective": "Improve operational throughput.",
    "integrations": [
      "Tasks",
      "fulfillment",
      "incidents"
    ],
    "jobs": [
      "find bottlenecks",
      "suggest automations"
    ],
    "successMetrics": [
      "SLA compliance",
      "bottleneck resolution"
    ],
    "approvalGates": [
      "workflow changes with external effects"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "cool-town-1727",
    "pageLabel": "Products Intelligence",
    "agentName": "Product Intelligence Agent",
    "autonomy": "A3",
    "objective": "Connect product demand with performance.",
    "integrations": [
      "Catalog",
      "sales",
      "returns",
      "reviews"
    ],
    "jobs": [
      "rank product issues",
      "find winners and losers"
    ],
    "successMetrics": [
      "margin lift",
      "return reduction"
    ],
    "approvalGates": [
      "live catalog changes"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "swift-pool-5077",
    "pageLabel": "KPI Explorer",
    "agentName": "KPI Agent",
    "autonomy": "A2",
    "objective": "Explain KPI changes in plain language.",
    "integrations": [
      "Metrics",
      "dimensions",
      "benchmarks"
    ],
    "jobs": [
      "compute deltas",
      "generate driver trees"
    ],
    "successMetrics": [
      "diagnostic speed",
      "explanation usefulness"
    ],
    "approvalGates": []
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "friendly-ground-4157",
    "pageLabel": "Reports",
    "agentName": "Reporting Agent",
    "autonomy": "A3",
    "objective": "Generate recurring reports automatically.",
    "integrations": [
      "All reporting sources"
    ],
    "jobs": [
      "build scheduled reports",
      "refresh narratives"
    ],
    "successMetrics": [
      "report latency",
      "manual reporting reduction"
    ],
    "approvalGates": [
      "external delivery"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "sparkling-time-5280",
    "pageLabel": "Comparisons",
    "agentName": "Comparison Agent",
    "autonomy": "A2",
    "objective": "Compare periods, segments, and entities.",
    "integrations": [
      "Historical metrics",
      "cohorts",
      "targets"
    ],
    "jobs": [
      "compute deltas",
      "highlight drivers"
    ],
    "successMetrics": [
      "comparison clarity",
      "decision support value"
    ],
    "approvalGates": []
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "wispy-current-7490",
    "pageLabel": "Forecasts",
    "agentName": "Forecast Agent",
    "autonomy": "A2",
    "objective": "Predict future outcomes with uncertainty.",
    "integrations": [
      "Historical KPIs",
      "pipeline",
      "seasonality"
    ],
    "jobs": [
      "refresh forecasts",
      "run scenarios"
    ],
    "successMetrics": [
      "forecast accuracy",
      "scenario usefulness"
    ],
    "approvalGates": [
      "budget or commitment decisions"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "kindly-year-8981",
    "pageLabel": "Benchmarks",
    "agentName": "Benchmark Agent",
    "autonomy": "A2",
    "objective": "Measure performance against baselines.",
    "integrations": [
      "Targets",
      "history",
      "external references"
    ],
    "jobs": [
      "refresh benchmark sets",
      "compute gaps"
    ],
    "successMetrics": [
      "benchmark coverage",
      "target adherence"
    ],
    "approvalGates": []
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "serenely-creek-1765",
    "pageLabel": "Trends",
    "agentName": "Trend Agent",
    "autonomy": "A2",
    "objective": "Find sustained directional changes.",
    "integrations": [
      "Historical time series"
    ],
    "jobs": [
      "detect emerging trends",
      "label significance"
    ],
    "successMetrics": [
      "early trend detection",
      "trend coverage"
    ],
    "approvalGates": []
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "sparklingly-light-7230",
    "pageLabel": "Anomalies",
    "agentName": "Anomaly Agent",
    "autonomy": "A2",
    "objective": "Catch unusual behavior fast.",
    "integrations": [
      "Event streams",
      "KPI streams"
    ],
    "jobs": [
      "run anomaly checks",
      "score severity"
    ],
    "successMetrics": [
      "alert precision",
      "alert recall"
    ],
    "approvalGates": [
      "automatic intervention"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "clever-soil-5964",
    "pageLabel": "Attribution",
    "agentName": "Attribution Agent",
    "autonomy": "A2",
    "objective": "Map outcomes to the real source.",
    "integrations": [
      "Web analytics",
      "ads",
      "CRM",
      "commerce"
    ],
    "jobs": [
      "update contribution models",
      "reconcile paths"
    ],
    "successMetrics": [
      "attribution trust",
      "channel decision quality"
    ],
    "approvalGates": [
      "budget reallocation"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "serenely-week-1771",
    "pageLabel": "AI Insights",
    "agentName": "Insight Agent",
    "autonomy": "A2",
    "objective": "Turn raw signals into useful insights.",
    "integrations": [
      "Cross-domain events",
      "metrics"
    ],
    "jobs": [
      "cluster signals",
      "rank insights"
    ],
    "successMetrics": [
      "insight adoption rate",
      "signal compression"
    ],
    "approvalGates": []
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "daring-home-4179",
    "pageLabel": "AI Recommendations",
    "agentName": "Recommendation Agent",
    "autonomy": "A2",
    "objective": "Turn insights into next actions.",
    "integrations": [
      "Insights",
      "goals",
      "constraints"
    ],
    "jobs": [
      "generate recommendations",
      "estimate impact"
    ],
    "successMetrics": [
      "recommendation acceptance",
      "impact realized"
    ],
    "approvalGates": [
      "action execution"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "wispy-leaf-3778",
    "pageLabel": "AI Tasks",
    "agentName": "Task Orchestrator",
    "autonomy": "A3",
    "objective": "Convert strategy into executable tasks.",
    "integrations": [
      "Recommendations",
      "task systems"
    ],
    "jobs": [
      "create tasks",
      "sequence dependencies"
    ],
    "successMetrics": [
      "task completion rate",
      "handoff speed"
    ],
    "approvalGates": [
      "cross-system writes"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "happily-brook-7061",
    "pageLabel": "Opportunities",
    "agentName": "Opportunity Agent",
    "autonomy": "A2",
    "objective": "Maintain a ranked opportunity backlog.",
    "integrations": [
      "Growth",
      "sales",
      "product",
      "finance"
    ],
    "jobs": [
      "identify upside",
      "score value"
    ],
    "successMetrics": [
      "opportunity realization",
      "pipeline quality"
    ],
    "approvalGates": [
      "launching major opportunities"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "radiant-cave-9340",
    "pageLabel": "Decisions",
    "agentName": "Decision Agent",
    "autonomy": "A2",
    "objective": "Support structured decision making.",
    "integrations": [
      "Recommendations",
      "approvals",
      "historical outcomes"
    ],
    "jobs": [
      "draft decision memos",
      "record rationale"
    ],
    "successMetrics": [
      "decision cycle time",
      "decision traceability"
    ],
    "approvalGates": [
      "final decision sign-off"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "boldly-time-5189",
    "pageLabel": "Risk Center",
    "agentName": "Risk Agent",
    "autonomy": "A2",
    "objective": "Centralize risks and mitigation.",
    "integrations": [
      "Alerts",
      "finance",
      "compliance",
      "ops"
    ],
    "jobs": [
      "maintain risk register",
      "monitor mitigation"
    ],
    "successMetrics": [
      "prevented incidents",
      "mitigation coverage"
    ],
    "approvalGates": [
      "remediation steps"
    ]
  },
  {
    "sectionLabel": "Dashboard",
    "pageId": "proud-rain-4772",
    "pageLabel": "Activity Timeline",
    "agentName": "Activity Chronicle Agent",
    "autonomy": "A2",
    "objective": "Preserve an explainable history of action.",
    "integrations": [
      "Agent logs",
      "sync logs",
      "approvals"
    ],
    "jobs": [
      "append events",
      "correlate cause and effect"
    ],
    "successMetrics": [
      "audit completeness",
      "timeline coherence"
    ],
    "approvalGates": []
  },
  {
    "sectionLabel": "Finance",
    "pageId": "quietly-stone-4158",
    "pageLabel": "Finance Overview",
    "agentName": "CFO Agent",
    "autonomy": "A2",
    "objective": "Run the finance domain as a whole.",
    "integrations": [
      "Finance stack",
      "billing",
      "revenue systems"
    ],
    "jobs": [
      "summarize finance status",
      "rank issues"
    ],
    "successMetrics": [
      "finance issue resolution speed",
      "cash visibility"
    ],
    "approvalGates": [
      "financial execution"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "breezy-soil-2475",
    "pageLabel": "Finance Invoices",
    "agentName": "Invoice Agent",
    "autonomy": "A3",
    "objective": "Keep invoicing accurate and timely.",
    "integrations": [
      "Invoices",
      "CRM",
      "payments"
    ],
    "jobs": [
      "generate drafts",
      "chase overdue items"
    ],
    "successMetrics": [
      "DSO",
      "invoice error rate"
    ],
    "approvalGates": [
      "sending invoices"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "tender-creek-3139",
    "pageLabel": "Finance Offers & Quotes",
    "agentName": "Quote Agent",
    "autonomy": "A2",
    "objective": "Produce better quotes faster.",
    "integrations": [
      "Products",
      "pricing",
      "CRM"
    ],
    "jobs": [
      "assemble quote drafts",
      "check margin"
    ],
    "successMetrics": [
      "quote turnaround",
      "quote win rate"
    ],
    "approvalGates": [
      "sending quotes"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "cool-rain-6499",
    "pageLabel": "Finance Income",
    "agentName": "Income Agent",
    "autonomy": "A2",
    "objective": "Monitor and explain incoming revenue.",
    "integrations": [
      "Orders",
      "subscriptions",
      "invoices"
    ],
    "jobs": [
      "roll up income",
      "detect drops"
    ],
    "successMetrics": [
      "revenue visibility",
      "income anomaly coverage"
    ],
    "approvalGates": []
  },
  {
    "sectionLabel": "Finance",
    "pageId": "richly-land-8084",
    "pageLabel": "Finance Transactions",
    "agentName": "Transaction Agent",
    "autonomy": "A3",
    "objective": "Keep transaction data categorized and trustworthy.",
    "integrations": [
      "Payments",
      "cash feeds",
      "ledger"
    ],
    "jobs": [
      "classify transactions",
      "flag exceptions"
    ],
    "successMetrics": [
      "classification accuracy",
      "exception resolution time"
    ],
    "approvalGates": [
      "writing back corrections"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "calm-tide-3752",
    "pageLabel": "Finance Payments",
    "agentName": "Payment Agent",
    "autonomy": "A3",
    "objective": "Guard payment collection quality.",
    "integrations": [
      "Processors",
      "invoices",
      "subscriptions"
    ],
    "jobs": [
      "detect failures",
      "suggest retries"
    ],
    "successMetrics": [
      "payment success rate",
      "failed payment recovery"
    ],
    "approvalGates": [
      "retrying or changing payment actions"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "zesty-earth-3938",
    "pageLabel": "Finance Expenses",
    "agentName": "Expense Agent",
    "autonomy": "A2",
    "objective": "Control spend and waste.",
    "integrations": [
      "Expense tools",
      "cards",
      "vendors"
    ],
    "jobs": [
      "categorize spend",
      "find anomalies"
    ],
    "successMetrics": [
      "spend reduction",
      "anomaly detection"
    ],
    "approvalGates": [
      "approving spend"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "bravely-bay-4544",
    "pageLabel": "Finance Customers",
    "agentName": "Debtor Agent",
    "autonomy": "A3",
    "objective": "Manage receivables risk.",
    "integrations": [
      "AR",
      "invoices",
      "customer balances"
    ],
    "jobs": [
      "build aging views",
      "draft reminders"
    ],
    "successMetrics": [
      "overdue reduction",
      "collection speed"
    ],
    "approvalGates": [
      "dunning outreach"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "eager-minute-1586",
    "pageLabel": "Finance Vendors",
    "agentName": "Creditor Agent",
    "autonomy": "A2",
    "objective": "Manage vendor obligations cleanly.",
    "integrations": [
      "AP",
      "contracts",
      "payout schedules"
    ],
    "jobs": [
      "watch due dates",
      "detect overcharges"
    ],
    "successMetrics": [
      "missed payment reduction",
      "vendor issue detection"
    ],
    "approvalGates": [
      "paying vendors"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "fair-bridge-8618",
    "pageLabel": "Finance Accounts",
    "agentName": "Account Agent",
    "autonomy": "A2",
    "objective": "Keep account structure consistent.",
    "integrations": [
      "Accounts",
      "ledger",
      "mappings"
    ],
    "jobs": [
      "watch account health",
      "detect orphan mappings"
    ],
    "successMetrics": [
      "reconciliation readiness",
      "mapping correctness"
    ],
    "approvalGates": [
      "changing account structure"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "soft-town-3284",
    "pageLabel": "Finance Cash Flow",
    "agentName": "Cash Flow Agent",
    "autonomy": "A2",
    "objective": "Prevent cash crunches.",
    "integrations": [
      "Balances",
      "AR",
      "AP",
      "forecast"
    ],
    "jobs": [
      "project runway",
      "flag shortfalls"
    ],
    "successMetrics": [
      "runway visibility",
      "surprise reduction"
    ],
    "approvalGates": [
      "emergency cash actions"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "wisely-gate-3183",
    "pageLabel": "Finance Budgets",
    "agentName": "Budget Agent",
    "autonomy": "A3",
    "objective": "Plan and control budget allocation.",
    "integrations": [
      "Actuals",
      "plans",
      "team budgets"
    ],
    "jobs": [
      "compare plan vs actual",
      "propose shifts"
    ],
    "successMetrics": [
      "budget adherence",
      "spend efficiency"
    ],
    "approvalGates": [
      "budget changes"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "sharp-morning-7310",
    "pageLabel": "Finance Financial Planning",
    "agentName": "Planning Agent",
    "autonomy": "A2",
    "objective": "Model future financial scenarios.",
    "integrations": [
      "Forecasts",
      "budgets",
      "assumptions"
    ],
    "jobs": [
      "run scenarios",
      "update assumptions"
    ],
    "successMetrics": [
      "scenario usefulness",
      "planning speed"
    ],
    "approvalGates": [
      "strategic commitment"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "sparklingly-city-3338",
    "pageLabel": "Finance Reconciliation",
    "agentName": "Reconciliation Agent",
    "autonomy": "A3",
    "objective": "Match records across finance systems.",
    "integrations": [
      "Orders",
      "invoices",
      "payouts",
      "ledger"
    ],
    "jobs": [
      "detect mismatches",
      "suggest fixes"
    ],
    "successMetrics": [
      "reconciliation completion",
      "mismatch resolution time"
    ],
    "approvalGates": [
      "auto-fixes"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "radiant-hour-5376",
    "pageLabel": "Finance Recurring Revenue",
    "agentName": "Recurring Revenue Agent",
    "autonomy": "A2",
    "objective": "Protect recurring revenue quality.",
    "integrations": [
      "Subscriptions",
      "churn",
      "upgrades"
    ],
    "jobs": [
      "compute movement",
      "detect churn patterns"
    ],
    "successMetrics": [
      "net revenue retention",
      "churn visibility"
    ],
    "approvalGates": [
      "pricing changes"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "lucky-park-8649",
    "pageLabel": "Finance Payouts",
    "agentName": "Payout Agent",
    "autonomy": "A2",
    "objective": "Keep payouts visible and correct.",
    "integrations": [
      "Processor payouts",
      "bank arrivals"
    ],
    "jobs": [
      "detect missing payouts",
      "track timing"
    ],
    "successMetrics": [
      "payout accuracy",
      "payout latency"
    ],
    "approvalGates": [
      "payout configuration changes"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "vibrantly-second-9428",
    "pageLabel": "Finance Financial Automation",
    "agentName": "Finance Automation Agent",
    "autonomy": "A4",
    "objective": "Automate repetitive finance work.",
    "integrations": [
      "Finance workflows",
      "triggers",
      "approvals"
    ],
    "jobs": [
      "run automations",
      "route exceptions"
    ],
    "successMetrics": [
      "manual finance work reduction",
      "automation success rate"
    ],
    "approvalGates": [
      "enabling new automation rules"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "sturdy-week-3372",
    "pageLabel": "Finance Taxes",
    "agentName": "Tax Agent",
    "autonomy": "A2",
    "objective": "Reduce tax mistakes.",
    "integrations": [
      "Tax settings",
      "invoices",
      "orders"
    ],
    "jobs": [
      "detect mismatches",
      "flag filing risk"
    ],
    "successMetrics": [
      "tax error reduction",
      "tax issue detection"
    ],
    "approvalGates": [
      "filing or tax submission"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "fine-park-8079",
    "pageLabel": "Sales Overview",
    "agentName": "CSO Agent",
    "autonomy": "A2",
    "objective": "Run the sales domain from one overview.",
    "integrations": [
      "CRM",
      "finance",
      "pipeline"
    ],
    "jobs": [
      "summarize sales health",
      "rank gaps"
    ],
    "successMetrics": [
      "sales visibility",
      "pipeline health"
    ],
    "approvalGates": [
      "external sales action"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "softly-autumn-9038",
    "pageLabel": "Sales Leads",
    "agentName": "Lead Agent",
    "autonomy": "A3",
    "objective": "Qualify sales leads effectively.",
    "integrations": [
      "CRM",
      "lead sources",
      "enrichment"
    ],
    "jobs": [
      "score leads",
      "route leads"
    ],
    "successMetrics": [
      "lead-to-opportunity rate",
      "lead response time"
    ],
    "approvalGates": [
      "external outreach"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "wildly-sun-6424",
    "pageLabel": "Sales Opportunities",
    "agentName": "Opportunity Agent",
    "autonomy": "A3",
    "objective": "Develop qualified opportunities.",
    "integrations": [
      "CRM",
      "meeting notes",
      "fit signals"
    ],
    "jobs": [
      "update opportunity briefs",
      "flag blockers"
    ],
    "successMetrics": [
      "opportunity conversion",
      "opportunity cycle time"
    ],
    "approvalGates": [
      "offer changes"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "deeply-month-1392",
    "pageLabel": "Sales Deals",
    "agentName": "Deal Agent",
    "autonomy": "A3",
    "objective": "Improve deal progression.",
    "integrations": [
      "CRM",
      "pricing",
      "notes"
    ],
    "jobs": [
      "create deal plans",
      "surface objections"
    ],
    "successMetrics": [
      "close rate",
      "deal velocity"
    ],
    "approvalGates": [
      "buyer commitments"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "sweet-evening-7753",
    "pageLabel": "Sales Pipeline",
    "agentName": "Pipeline Agent",
    "autonomy": "A2",
    "objective": "Keep pipeline flowing.",
    "integrations": [
      "Stages",
      "activities",
      "rep data"
    ],
    "jobs": [
      "detect stuck stages",
      "rebalance focus"
    ],
    "successMetrics": [
      "pipeline velocity",
      "stalled-deal reduction"
    ],
    "approvalGates": [
      "bulk pipeline edits"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "warmly-road-3804",
    "pageLabel": "Sales Activities",
    "agentName": "Sales Activity Agent",
    "autonomy": "A2",
    "objective": "Measure sales activity quality.",
    "integrations": [
      "Emails",
      "calls",
      "meetings"
    ],
    "jobs": [
      "score activity quality",
      "suggest cadence changes"
    ],
    "successMetrics": [
      "activity effectiveness",
      "follow-up quality"
    ],
    "approvalGates": [
      "auto-outreach"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "wondrously-gate-2200",
    "pageLabel": "Sales Tasks",
    "agentName": "Sales Task Agent",
    "autonomy": "A3",
    "objective": "Enforce disciplined follow-up.",
    "integrations": [
      "CRM",
      "tasks",
      "history"
    ],
    "jobs": [
      "create follow-ups",
      "remind owners"
    ],
    "successMetrics": [
      "task SLA compliance",
      "follow-up completion"
    ],
    "approvalGates": [
      "external communication"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "sharp-cliff-6925",
    "pageLabel": "Sales Customer Segments",
    "agentName": "Sales Segmentation Agent",
    "autonomy": "A2",
    "objective": "Build actionable sales segments.",
    "integrations": [
      "CRM",
      "revenue",
      "product fit"
    ],
    "jobs": [
      "generate segments",
      "refresh labels"
    ],
    "successMetrics": [
      "segment usefulness",
      "segment adoption"
    ],
    "approvalGates": [
      "activating segments externally"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "lovingly-shore-4782",
    "pageLabel": "Sales Forecast",
    "agentName": "Sales Forecast Agent",
    "autonomy": "A2",
    "objective": "Predict bookings.",
    "integrations": [
      "Pipeline",
      "stage history",
      "seasonality"
    ],
    "jobs": [
      "refresh forecast",
      "compare to actual"
    ],
    "successMetrics": [
      "forecast accuracy",
      "forecast confidence"
    ],
    "approvalGates": [
      "plan changes"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "rich-moon-9195",
    "pageLabel": "Sales Reports",
    "agentName": "Sales Reporting Agent",
    "autonomy": "A3",
    "objective": "Generate sales reporting automatically.",
    "integrations": [
      "CRM",
      "rep activity",
      "deal data"
    ],
    "jobs": [
      "produce reports",
      "summarize changes"
    ],
    "successMetrics": [
      "reporting latency",
      "report consumption"
    ],
    "approvalGates": [
      "external delivery"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "lively-house-6788",
    "pageLabel": "Sales Commissions",
    "agentName": "Commission Agent",
    "autonomy": "A2",
    "objective": "Keep commission logic trusted.",
    "integrations": [
      "Deals",
      "payout logic",
      "rep plans"
    ],
    "jobs": [
      "compute commissions",
      "flag discrepancies"
    ],
    "successMetrics": [
      "commission dispute reduction",
      "statement accuracy"
    ],
    "approvalGates": [
      "commission payout"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "gentle-cliff-7133",
    "pageLabel": "Sales Goals",
    "agentName": "Goal Agent",
    "autonomy": "A2",
    "objective": "Track goal progress clearly.",
    "integrations": [
      "Targets",
      "actuals",
      "teams"
    ],
    "jobs": [
      "watch attainment",
      "suggest interventions"
    ],
    "successMetrics": [
      "quota attainment visibility",
      "intervention timeliness"
    ],
    "approvalGates": [
      "changing goals"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "kindly-morning-7115",
    "pageLabel": "Sales Territories",
    "agentName": "Territory Agent",
    "autonomy": "A2",
    "objective": "Optimize territory design.",
    "integrations": [
      "Accounts",
      "geo",
      "firmographics"
    ],
    "jobs": [
      "detect imbalance",
      "suggest territory changes"
    ],
    "successMetrics": [
      "coverage quality",
      "territory balance"
    ],
    "approvalGates": [
      "reassignment"
    ]
  },
  {
    "sectionLabel": "Finance",
    "pageId": "friendly-tower-1528",
    "pageLabel": "Sales Lead Assignment",
    "agentName": "Lead Routing Agent",
    "autonomy": "A4",
    "objective": "Route leads to the best owner.",
    "integrations": [
      "Lead data",
      "territories",
      "rep capacity"
    ],
    "jobs": [
      "auto-assign leads",
      "rebalance rules"
    ],
    "successMetrics": [
      "routing speed",
      "lead response time"
    ],
    "approvalGates": [
      "rule changes"
    ]
  },
  {
    "sectionLabel": "AI",
    "pageId": "fresh-moon-5374",
    "pageLabel": "Assistant",
    "agentName": "Universal Assistant Agent",
    "autonomy": "A3",
    "objective": "Let the user command the business in natural language.",
    "integrations": [
      "All accessible tools",
      "workspace memory"
    ],
    "jobs": [
      "answer",
      "orchestrate work"
    ],
    "successMetrics": [
      "user task completion time",
      "assistant adoption"
    ],
    "approvalGates": [
      "sensitive execution"
    ]
  },
  {
    "sectionLabel": "AI",
    "pageId": "radiant-dusk-9079",
    "pageLabel": "Agents",
    "agentName": "Agent Manager",
    "autonomy": "A2",
    "objective": "Show and manage the active Lulu workforce.",
    "integrations": [
      "Agent registry",
      "permissions",
      "logs"
    ],
    "jobs": [
      "run health checks",
      "summarize workload"
    ],
    "successMetrics": [
      "agent uptime",
      "ownership clarity"
    ],
    "approvalGates": [
      "permission changes"
    ]
  },
  {
    "sectionLabel": "AI",
    "pageId": "calmly-park-3313",
    "pageLabel": "Agent Marketplace",
    "agentName": "Capability Agent",
    "autonomy": "A2",
    "objective": "Expand available agent capabilities.",
    "integrations": [
      "Template catalog",
      "installed modules"
    ],
    "jobs": [
      "match gaps",
      "recommend additions"
    ],
    "successMetrics": [
      "capability coverage",
      "feature adoption"
    ],
    "approvalGates": [
      "installation"
    ]
  },
  {
    "sectionLabel": "AI",
    "pageId": "rich-field-1880",
    "pageLabel": "Knowledge",
    "agentName": "Knowledge Agent",
    "autonomy": "A3",
    "objective": "Store reusable business memory.",
    "integrations": [
      "Docs",
      "notes",
      "synced data",
      "chat history"
    ],
    "jobs": [
      "ingest knowledge",
      "link entities"
    ],
    "successMetrics": [
      "retrieval quality",
      "knowledge freshness"
    ],
    "approvalGates": [
      "deletion or sharing"
    ]
  },
  {
    "sectionLabel": "AI",
    "pageId": "wondrously-second-5656",
    "pageLabel": "Actions",
    "agentName": "Action Agent",
    "autonomy": "A4",
    "objective": "Execute approved tasks across systems.",
    "integrations": [
      "Integrations",
      "workflows",
      "task definitions"
    ],
    "jobs": [
      "perform actions",
      "log runs"
    ],
    "successMetrics": [
      "successful action rate",
      "rollback readiness"
    ],
    "approvalGates": [
      "irreversible actions"
    ]
  },
  {
    "sectionLabel": "AI",
    "pageId": "sunny-moon-6307",
    "pageLabel": "Conversations",
    "agentName": "Conversation Agent",
    "autonomy": "A2",
    "objective": "Preserve thread continuity across agents.",
    "integrations": [
      "Chats",
      "artifacts",
      "memory"
    ],
    "jobs": [
      "summarize threads",
      "route context"
    ],
    "successMetrics": [
      "context retention quality",
      "handoff quality"
    ],
    "approvalGates": [
      "external sending"
    ]
  },
  {
    "sectionLabel": "AI",
    "pageId": "sparkling-cave-8456",
    "pageLabel": "Activity",
    "agentName": "AI Audit Agent",
    "autonomy": "A2",
    "objective": "Make agent work inspectable.",
    "integrations": [
      "Logs",
      "run history",
      "approvals"
    ],
    "jobs": [
      "render activity feed",
      "explain actions"
    ],
    "successMetrics": [
      "audit completeness",
      "traceability"
    ],
    "approvalGates": []
  },
  {
    "sectionLabel": "CRM",
    "pageId": "sturdy-month-1562",
    "pageLabel": "Contacts",
    "agentName": "Contact Agent",
    "autonomy": "A3",
    "objective": "Maintain reliable person records.",
    "integrations": [
      "CRM",
      "enrichment",
      "communications"
    ],
    "jobs": [
      "enrich contacts",
      "dedupe records"
    ],
    "successMetrics": [
      "contact completeness",
      "duplicate reduction"
    ],
    "approvalGates": [
      "external outreach or deletion"
    ]
  },
  {
    "sectionLabel": "CRM",
    "pageId": "kindly-pool-8785",
    "pageLabel": "Companies",
    "agentName": "Company Agent",
    "autonomy": "A3",
    "objective": "Maintain reliable company records.",
    "integrations": [
      "CRM",
      "enrichment",
      "deal data"
    ],
    "jobs": [
      "enrich companies",
      "detect duplicates"
    ],
    "successMetrics": [
      "account completeness",
      "duplicate reduction"
    ],
    "approvalGates": [
      "merge or delete operations"
    ]
  },
  {
    "sectionLabel": "CRM",
    "pageId": "cosmic-pool-1616",
    "pageLabel": "Activities",
    "agentName": "CRM Activity Agent",
    "autonomy": "A2",
    "objective": "Keep relationship activity complete.",
    "integrations": [
      "Email",
      "meetings",
      "calls"
    ],
    "jobs": [
      "summarize activity",
      "create follow-ups"
    ],
    "successMetrics": [
      "activity completeness",
      "follow-up creation rate"
    ],
    "approvalGates": [
      "auto-sending"
    ]
  },
  {
    "sectionLabel": "CRM",
    "pageId": "deeply-noon-9539",
    "pageLabel": "Tasks",
    "agentName": "CRM Task Agent",
    "autonomy": "A3",
    "objective": "Ensure follow-up discipline.",
    "integrations": [
      "CRM tasks",
      "SLAs",
      "records"
    ],
    "jobs": [
      "create reminders",
      "sequence tasks"
    ],
    "successMetrics": [
      "follow-up compliance",
      "task closure rate"
    ],
    "approvalGates": [
      "external writes"
    ]
  },
  {
    "sectionLabel": "CRM",
    "pageId": "gracefully-storm-2649",
    "pageLabel": "Customer Intelligence",
    "agentName": "Customer Intelligence Agent",
    "autonomy": "A2",
    "objective": "Explain account and customer behavior deeply.",
    "integrations": [
      "CRM",
      "sales",
      "commerce",
      "support"
    ],
    "jobs": [
      "produce account briefs",
      "score risk and value"
    ],
    "successMetrics": [
      "account insight quality",
      "risk detection"
    ],
    "approvalGates": [
      "customer-facing action"
    ]
  },
  {
    "sectionLabel": "Email",
    "pageId": "email-inbox",
    "pageLabel": "Inbox",
    "agentName": "Inbox Agent",
    "autonomy": "A3",
    "objective": "Triage and draft responses for inbound mail.",
    "integrations": [
      "Connected inboxes",
      "CRM",
      "calendar"
    ],
    "jobs": [
      "summarize threads",
      "classify urgency"
    ],
    "successMetrics": [
      "inbox zero speed",
      "first-response time"
    ],
    "approvalGates": [
      "sending replies"
    ]
  },
  {
    "sectionLabel": "Email",
    "pageId": "email-starred",
    "pageLabel": "Starred",
    "agentName": "Priority Mail Agent",
    "autonomy": "A2",
    "objective": "Protect the highest-priority threads.",
    "integrations": [
      "Mail provider",
      "starred labels"
    ],
    "jobs": [
      "maintain VIP queue",
      "detect overdue responses"
    ],
    "successMetrics": [
      "VIP response time",
      "priority SLA adherence"
    ],
    "approvalGates": [
      "sending replies"
    ]
  },
  {
    "sectionLabel": "Email",
    "pageId": "email-sent",
    "pageLabel": "Sent",
    "agentName": "Sent Mail Agent",
    "autonomy": "A2",
    "objective": "Review outbound quality and response patterns.",
    "integrations": [
      "Sent mail",
      "reply data"
    ],
    "jobs": [
      "detect follow-up needs",
      "summarize performance"
    ],
    "successMetrics": [
      "reply rate visibility",
      "outbound quality"
    ],
    "approvalGates": []
  },
  {
    "sectionLabel": "Email",
    "pageId": "email-drafts",
    "pageLabel": "Drafts",
    "agentName": "Drafting Agent",
    "autonomy": "A3",
    "objective": "Produce high-quality drafts quickly.",
    "integrations": [
      "Mail context",
      "templates",
      "CRM"
    ],
    "jobs": [
      "generate drafts",
      "personalize content"
    ],
    "successMetrics": [
      "draft acceptance rate",
      "drafting speed"
    ],
    "approvalGates": [
      "sending drafts"
    ]
  },
  {
    "sectionLabel": "Email",
    "pageId": "email-automations",
    "pageLabel": "Automations",
    "agentName": "Email Automation Agent",
    "autonomy": "A4",
    "objective": "Run recurring email programs.",
    "integrations": [
      "Mail provider",
      "workflow engine",
      "CRM"
    ],
    "jobs": [
      "execute sequences",
      "stop on replies"
    ],
    "successMetrics": [
      "automation performance",
      "manual send reduction"
    ],
    "approvalGates": [
      "activating new automations"
    ]
  },
  {
    "sectionLabel": "Email",
    "pageId": "email-settings",
    "pageLabel": "Email Settings",
    "agentName": "Email Config Agent",
    "autonomy": "A2",
    "objective": "Manage email account rules.",
    "integrations": [
      "Sender config",
      "signatures",
      "routing rules"
    ],
    "jobs": [
      "validate settings",
      "surface errors"
    ],
    "successMetrics": [
      "config health",
      "mail reliability"
    ],
    "approvalGates": [
      "settings changes"
    ]
  },
  {
    "sectionLabel": "Calendar",
    "pageId": "calendar-overview",
    "pageLabel": "Overview",
    "agentName": "Calendar Agent",
    "autonomy": "A3",
    "objective": "Coordinate time and scheduling intelligently.",
    "integrations": [
      "Connected calendars",
      "tasks",
      "email"
    ],
    "jobs": [
      "detect conflicts",
      "propose slots"
    ],
    "successMetrics": [
      "conflict reduction",
      "scheduling speed"
    ],
    "approvalGates": [
      "sending invites or rescheduling"
    ]
  },
  {
    "sectionLabel": "Calendar",
    "pageId": "calendar-settings",
    "pageLabel": "Calendar Settings",
    "agentName": "Calendar Config Agent",
    "autonomy": "A2",
    "objective": "Hold calendar operating rules.",
    "integrations": [
      "Calendar providers",
      "booking preferences"
    ],
    "jobs": [
      "validate sync state",
      "recommend defaults"
    ],
    "successMetrics": [
      "sync reliability",
      "config quality"
    ],
    "approvalGates": [
      "settings changes"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "dreamily-soil-9290",
    "pageLabel": "Campaigns",
    "agentName": "Campaign Agent",
    "autonomy": "A3",
    "objective": "Design and run marketing campaigns.",
    "integrations": [
      "Campaign tools",
      "analytics",
      "content systems"
    ],
    "jobs": [
      "generate campaign plans",
      "monitor execution"
    ],
    "successMetrics": [
      "campaign ROI",
      "launch speed"
    ],
    "approvalGates": [
      "launching campaigns"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "wondrous-cloud-1355",
    "pageLabel": "Content",
    "agentName": "Content Agent",
    "autonomy": "A3",
    "objective": "Produce and improve marketing content.",
    "integrations": [
      "CMS",
      "brand assets",
      "SEO data"
    ],
    "jobs": [
      "create drafts",
      "refresh old content"
    ],
    "successMetrics": [
      "content velocity",
      "content impact"
    ],
    "approvalGates": [
      "publishing"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "sparklingly-home-7386",
    "pageLabel": "Strategy",
    "agentName": "Strategy Agent",
    "autonomy": "A2",
    "objective": "Convert goals into a marketing plan.",
    "integrations": [
      "Business goals",
      "channel data",
      "competition"
    ],
    "jobs": [
      "define priorities",
      "update roadmap"
    ],
    "successMetrics": [
      "strategy adoption",
      "goal alignment"
    ],
    "approvalGates": [
      "strategic approval"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "gently-shade-2476",
    "pageLabel": "Campaign Tracker",
    "agentName": "Campaign Tracking Agent",
    "autonomy": "A2",
    "objective": "Monitor campaign execution health.",
    "integrations": [
      "Campaign systems",
      "analytics",
      "spend"
    ],
    "jobs": [
      "check pacing",
      "track milestones"
    ],
    "successMetrics": [
      "campaign visibility",
      "pacing accuracy"
    ],
    "approvalGates": []
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "kind-time-4492",
    "pageLabel": "Keywords",
    "agentName": "Keyword Agent",
    "autonomy": "A2",
    "objective": "Maintain a prioritized keyword map.",
    "integrations": [
      "Search data",
      "rankings",
      "competitor signals"
    ],
    "jobs": [
      "cluster keywords",
      "detect opportunities"
    ],
    "successMetrics": [
      "keyword opportunity capture",
      "keyword coverage"
    ],
    "approvalGates": [
      "publishing content"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "smartly-shore-1468",
    "pageLabel": "Competitors",
    "agentName": "Competitor Agent",
    "autonomy": "A2",
    "objective": "Track competitors continuously.",
    "integrations": [
      "Websites",
      "SERPs",
      "ads",
      "offers"
    ],
    "jobs": [
      "refresh competitor dossiers",
      "detect changes"
    ],
    "successMetrics": [
      "competitor coverage",
      "reaction speed"
    ],
    "approvalGates": []
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "breezily-wood-5980",
    "pageLabel": "Audiences",
    "agentName": "Audience Agent",
    "autonomy": "A4",
    "objective": "Build living target audiences for the business.",
    "integrations": [
      "Onboarding",
      "CRM",
      "website",
      "SEO/GEO/AEO",
      "commerce"
    ],
    "jobs": [
      "enrich segments",
      "score fit"
    ],
    "successMetrics": [
      "audience quality",
      "segment lift"
    ],
    "approvalGates": [
      "activating in ad or email systems"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "breezy-shore-6734",
    "pageLabel": "Analytics",
    "agentName": "Marketing Analytics Agent",
    "autonomy": "A2",
    "objective": "Explain marketing performance.",
    "integrations": [
      "Web analytics",
      "attribution",
      "campaign data"
    ],
    "jobs": [
      "run funnel diagnostics",
      "publish weekly summaries"
    ],
    "successMetrics": [
      "insight-to-action rate",
      "channel clarity"
    ],
    "approvalGates": [
      "budget reallocation"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "finely-garden-9221",
    "pageLabel": "Overview",
    "agentName": "CMO Agent",
    "autonomy": "A2",
    "objective": "Operate the whole marketing function.",
    "integrations": [
      "All marketing systems"
    ],
    "jobs": [
      "summarize domain status",
      "prioritize work"
    ],
    "successMetrics": [
      "channel coordination quality",
      "marketing responsiveness"
    ],
    "approvalGates": [
      "major channel changes"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "friendly-path-8200",
    "pageLabel": "Advertising Analytics",
    "agentName": "Ads Analytics Agent",
    "autonomy": "A3",
    "objective": "Explain ad performance clearly.",
    "integrations": [
      "Ad platforms",
      "spend",
      "attribution"
    ],
    "jobs": [
      "detect fatigue",
      "track efficiency"
    ],
    "successMetrics": [
      "cost efficiency",
      "ads visibility"
    ],
    "approvalGates": [
      "budget changes"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "wise-brook-1762",
    "pageLabel": "Advertising Campaigns",
    "agentName": "Ads Campaign Agent",
    "autonomy": "A3",
    "objective": "Operate paid campaigns.",
    "integrations": [
      "Ad accounts",
      "campaign data",
      "conversions"
    ],
    "jobs": [
      "adjust campaigns",
      "scale winners"
    ],
    "successMetrics": [
      "campaign performance lift",
      "campaign stability"
    ],
    "approvalGates": [
      "publishing changes"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "happily-storm-2690",
    "pageLabel": "Creatives",
    "agentName": "Creative Agent",
    "autonomy": "A3",
    "objective": "Generate and test better ad creatives.",
    "integrations": [
      "Brand assets",
      "products",
      "performance"
    ],
    "jobs": [
      "draft creatives",
      "rotate angles"
    ],
    "successMetrics": [
      "creative refresh performance",
      "creative throughput"
    ],
    "approvalGates": [
      "publishing creatives"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "sunny-minute-1092",
    "pageLabel": "Budgets",
    "agentName": "Media Budget Agent",
    "autonomy": "A3",
    "objective": "Allocate paid media budget intelligently.",
    "integrations": [
      "Spend",
      "ROAS",
      "CAC",
      "constraints"
    ],
    "jobs": [
      "rebalance spend",
      "hold caps"
    ],
    "successMetrics": [
      "spend efficiency",
      "overspend prevention"
    ],
    "approvalGates": [
      "changing budgets"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "zesty-grass-9196",
    "pageLabel": "AI Optimization",
    "agentName": "Ads Optimization Agent",
    "autonomy": "A4",
    "objective": "Continuously optimize ads under constraints.",
    "integrations": [
      "Campaign metrics",
      "bids",
      "budgets"
    ],
    "jobs": [
      "apply optimizations",
      "learn from outcomes"
    ],
    "successMetrics": [
      "incremental ROAS gain",
      "optimization win rate"
    ],
    "approvalGates": [
      "major scaling or pausing"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "nicely-shade-2637",
    "pageLabel": "Tracking & Attribution",
    "agentName": "Measurement Agent",
    "autonomy": "A3",
    "objective": "Maintain measurement integrity.",
    "integrations": [
      "Pixels",
      "events",
      "UTM rules",
      "analytics"
    ],
    "jobs": [
      "check tracking health",
      "detect missing events"
    ],
    "successMetrics": [
      "measurement completeness",
      "tracking accuracy"
    ],
    "approvalGates": [
      "altering live tracking"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "nice-moon-2056",
    "pageLabel": "AI Campaign & Ad Builder",
    "agentName": "Ad Builder Agent",
    "autonomy": "A3",
    "objective": "Generate ready-to-launch ad structures.",
    "integrations": [
      "Offer context",
      "audiences",
      "products"
    ],
    "jobs": [
      "build campaigns",
      "build ad sets"
    ],
    "successMetrics": [
      "launch preparation speed",
      "builder adoption"
    ],
    "approvalGates": [
      "publishing"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "sunnily-peak-7188",
    "pageLabel": "Publishing & Approval Center",
    "agentName": "Approval Agent",
    "autonomy": "A3",
    "objective": "Manage final launch control.",
    "integrations": [
      "Draft assets",
      "approval queue",
      "policy rules"
    ],
    "jobs": [
      "validate readiness",
      "present approval queue"
    ],
    "successMetrics": [
      "publishing error reduction",
      "approval turnaround"
    ],
    "approvalGates": [
      "final publish"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "solid-sand-5563",
    "pageLabel": "AI Experiments & A/B Testing",
    "agentName": "Experiment Agent",
    "autonomy": "A4",
    "objective": "Systematically run experiments.",
    "integrations": [
      "Campaign performance",
      "hypotheses",
      "variants"
    ],
    "jobs": [
      "design tests",
      "evaluate winners"
    ],
    "successMetrics": [
      "experiment velocity",
      "test win rate"
    ],
    "approvalGates": [
      "launching tests"
    ]
  },
  {
    "sectionLabel": "Marketing",
    "pageId": "sunny-summer-2293",
    "pageLabel": "Ad Accounts & Platform Management",
    "agentName": "Ad Platform Agent",
    "autonomy": "A2",
    "objective": "Keep ad platform connectivity stable.",
    "integrations": [
      "OAuth",
      "ad account configs",
      "permissions"
    ],
    "jobs": [
      "monitor connection health",
      "sync accounts"
    ],
    "successMetrics": [
      "integration uptime",
      "account sync success"
    ],
    "approvalGates": [
      "permission or account changes"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "lulu-website-portal-9012",
    "pageLabel": "Website",
    "agentName": "Website Manager Agent",
    "autonomy": "A3",
    "objective": "Operate the web presence as one managed system.",
    "integrations": [
      "CMS platforms",
      "website generation",
      "analytics"
    ],
    "jobs": [
      "monitor generation jobs",
      "plan changes"
    ],
    "successMetrics": [
      "site health",
      "delivery speed"
    ],
    "approvalGates": [
      "publishing site structure"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "website-wordpress-jetpack-9013",
    "pageLabel": "WordPress / Jetpack",
    "agentName": "WordPress Agent",
    "autonomy": "A3",
    "objective": "Manage WordPress operations.",
    "integrations": [
      "WordPress",
      "Jetpack",
      "analytics"
    ],
    "jobs": [
      "sync content",
      "inspect publishing health"
    ],
    "successMetrics": [
      "WordPress sync success",
      "publishing reliability"
    ],
    "approvalGates": [
      "publishing"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "website-webflow-9014",
    "pageLabel": "Webflow",
    "agentName": "Webflow Agent",
    "autonomy": "A3",
    "objective": "Manage Webflow operations.",
    "integrations": [
      "Webflow CMS",
      "publishing",
      "analytics"
    ],
    "jobs": [
      "sync collections",
      "inspect publish state"
    ],
    "successMetrics": [
      "Webflow publish reliability",
      "Webflow sync success"
    ],
    "approvalGates": [
      "publishing"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "website-pages-cms-9015",
    "pageLabel": "Pages & CMS",
    "agentName": "CMS Agent",
    "autonomy": "A3",
    "objective": "Maintain site structure and page content.",
    "integrations": [
      "CMS",
      "page tree",
      "templates"
    ],
    "jobs": [
      "create page drafts",
      "detect stale pages"
    ],
    "successMetrics": [
      "content freshness",
      "page quality"
    ],
    "approvalGates": [
      "publishing or deleting pages"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "website-posts-9016",
    "pageLabel": "Posts",
    "agentName": "Publishing Agent",
    "autonomy": "A3",
    "objective": "Run editorial publishing.",
    "integrations": [
      "CMS",
      "content calendar",
      "SEO data"
    ],
    "jobs": [
      "generate posts",
      "schedule posts"
    ],
    "successMetrics": [
      "content cadence",
      "editorial throughput"
    ],
    "approvalGates": [
      "publishing posts"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "website-media-assets-9017",
    "pageLabel": "Media & Assets",
    "agentName": "Asset Agent",
    "autonomy": "A2",
    "objective": "Keep assets organized and useful.",
    "integrations": [
      "Media library",
      "CDN",
      "CMS"
    ],
    "jobs": [
      "tag assets",
      "detect duplicates"
    ],
    "successMetrics": [
      "asset reuse rate",
      "duplicate reduction"
    ],
    "approvalGates": [
      "deleting assets"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "website-domains-9018",
    "pageLabel": "Domains",
    "agentName": "Domain Agent",
    "autonomy": "A2",
    "objective": "Guard domain and SSL health.",
    "integrations": [
      "DNS",
      "registrar",
      "SSL",
      "routing"
    ],
    "jobs": [
      "detect expiry",
      "check SSL issues"
    ],
    "successMetrics": [
      "domain uptime",
      "domain issue resolution"
    ],
    "approvalGates": [
      "DNS or domain changes"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "sparklingly-moon-5114",
    "pageLabel": "SEO",
    "agentName": "SEO Agent",
    "autonomy": "A4",
    "objective": "Improve classic search visibility.",
    "integrations": [
      "Search data",
      "page content",
      "technical site data"
    ],
    "jobs": [
      "prioritize fixes",
      "monitor rankings"
    ],
    "successMetrics": [
      "organic traffic growth",
      "rank improvement"
    ],
    "approvalGates": [
      "publishing technical or content changes"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "zealously-path-4224",
    "pageLabel": "GEO",
    "agentName": "GEO Agent",
    "autonomy": "A3",
    "objective": "Improve generative search visibility.",
    "integrations": [
      "Brand knowledge",
      "citations",
      "site structure"
    ],
    "jobs": [
      "generate citation tasks",
      "improve entity clarity"
    ],
    "successMetrics": [
      "generative visibility growth",
      "citation coverage"
    ],
    "approvalGates": [
      "publishing source changes"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "sunny-house-9595",
    "pageLabel": "AEO",
    "agentName": "AEO Agent",
    "autonomy": "A3",
    "objective": "Improve answer-engine readiness.",
    "integrations": [
      "FAQs",
      "structured content",
      "page content"
    ],
    "jobs": [
      "generate answer blocks",
      "identify snippet opportunities"
    ],
    "successMetrics": [
      "answer capture rate",
      "snippet coverage"
    ],
    "approvalGates": [
      "publishing answer content"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "smart-ocean-3898",
    "pageLabel": "Overview",
    "agentName": "Commerce Overview Agent",
    "autonomy": "A2",
    "objective": "Oversee website and commerce together.",
    "integrations": [
      "Web analytics",
      "store data",
      "review data"
    ],
    "jobs": [
      "summarize status",
      "rank blockers"
    ],
    "successMetrics": [
      "web commerce health",
      "blocker resolution"
    ],
    "approvalGates": [
      "major cross-domain changes"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "nice-year-6253",
    "pageLabel": "Stores",
    "agentName": "Store Agent",
    "autonomy": "A2",
    "objective": "Manage connected storefronts.",
    "integrations": [
      "Store platforms",
      "configs",
      "catalogs"
    ],
    "jobs": [
      "audit store health",
      "detect missing syncs"
    ],
    "successMetrics": [
      "store uptime",
      "sync coverage"
    ],
    "approvalGates": [
      "store config changes"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "nicely-ocean-1051",
    "pageLabel": "Products",
    "agentName": "Product Agent",
    "autonomy": "A3",
    "objective": "Keep product data and performance strong.",
    "integrations": [
      "Catalog",
      "pricing",
      "inventory",
      "reviews"
    ],
    "jobs": [
      "update product drafts",
      "detect underperformers"
    ],
    "successMetrics": [
      "product conversion rate",
      "product freshness"
    ],
    "approvalGates": [
      "publishing product changes"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "richly-forest-5832",
    "pageLabel": "Categories",
    "agentName": "Category Agent",
    "autonomy": "A3",
    "objective": "Maintain useful catalog structure.",
    "integrations": [
      "Catalog hierarchy",
      "SEO",
      "conversion data"
    ],
    "jobs": [
      "detect taxonomy issues",
      "suggest reorganizations"
    ],
    "successMetrics": [
      "category discoverability",
      "navigation clarity"
    ],
    "approvalGates": [
      "changing categories live"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "mightily-shore-7108",
    "pageLabel": "Orders",
    "agentName": "Order Agent",
    "autonomy": "A3",
    "objective": "Watch order processing health.",
    "integrations": [
      "Orders",
      "shipping",
      "payments",
      "support"
    ],
    "jobs": [
      "flag delays",
      "detect exceptions"
    ],
    "successMetrics": [
      "order resolution speed",
      "order SLA performance"
    ],
    "approvalGates": [
      "customer-facing intervention"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "fancy-ground-8040",
    "pageLabel": "Customers",
    "agentName": "Commerce Customer Agent",
    "autonomy": "A2",
    "objective": "Understand buyers in the store context.",
    "integrations": [
      "Orders",
      "CRM",
      "sessions",
      "support"
    ],
    "jobs": [
      "segment buyers",
      "score loyalty"
    ],
    "successMetrics": [
      "repeat purchase rate",
      "buyer insight quality"
    ],
    "approvalGates": [
      "outbound lifecycle actions"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "serenely-sand-9226",
    "pageLabel": "Carts",
    "agentName": "Cart Agent",
    "autonomy": "A3",
    "objective": "Monitor cart creation and drop-off.",
    "integrations": [
      "Cart events",
      "site analytics",
      "products"
    ],
    "jobs": [
      "detect friction",
      "rank blockers"
    ],
    "successMetrics": [
      "cart recovery rate",
      "cart leak detection"
    ],
    "approvalGates": [
      "starting recovery actions"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "smart-village-1099",
    "pageLabel": "Inventory",
    "agentName": "Inventory Agent",
    "autonomy": "A3",
    "objective": "Keep stock aligned with demand.",
    "integrations": [
      "Inventory",
      "sales velocity",
      "supplier timing"
    ],
    "jobs": [
      "detect stockouts",
      "detect overstock"
    ],
    "successMetrics": [
      "stockout reduction",
      "inventory efficiency"
    ],
    "approvalGates": [
      "stock or PO changes"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "dreamy-shade-5445",
    "pageLabel": "Returns & Refunds",
    "agentName": "Returns Agent",
    "autonomy": "A3",
    "objective": "Reduce costly returns and refund pain.",
    "integrations": [
      "Returns",
      "refunds",
      "orders",
      "product data"
    ],
    "jobs": [
      "classify return reasons",
      "detect bad SKUs"
    ],
    "successMetrics": [
      "return rate reduction",
      "refund issue detection"
    ],
    "approvalGates": [
      "issuing refunds automatically"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "sharply-sky-4161",
    "pageLabel": "Discounts & Promotions",
    "agentName": "Promotion Agent",
    "autonomy": "A3",
    "objective": "Run profitable promotions.",
    "integrations": [
      "Discount rules",
      "margin",
      "campaigns",
      "inventory"
    ],
    "jobs": [
      "propose promos",
      "measure results"
    ],
    "successMetrics": [
      "promo margin quality",
      "promo conversion"
    ],
    "approvalGates": [
      "launching promos"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "wildly-time-4260",
    "pageLabel": "Carts & Abandoned Carts",
    "agentName": "Recovery Agent",
    "autonomy": "A4",
    "objective": "Recover lost checkout intent.",
    "integrations": [
      "Cart abandonment events",
      "CRM",
      "email"
    ],
    "jobs": [
      "trigger recovery flows",
      "personalize saves"
    ],
    "successMetrics": [
      "recovered revenue",
      "recovery conversion"
    ],
    "approvalGates": [
      "sending recovery messages"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "quietly-moon-4186",
    "pageLabel": "Shipping",
    "agentName": "Shipping Agent",
    "autonomy": "A3",
    "objective": "Maintain delivery reliability.",
    "integrations": [
      "Carriers",
      "shipments",
      "order events"
    ],
    "jobs": [
      "flag late shipments",
      "detect address issues"
    ],
    "successMetrics": [
      "on-time delivery rate",
      "shipping issue response"
    ],
    "approvalGates": [
      "customer-facing changes"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "merry-castle-3260",
    "pageLabel": "Payments",
    "agentName": "Commerce Payment Agent",
    "autonomy": "A3",
    "objective": "Protect checkout payment quality.",
    "integrations": [
      "Checkout",
      "processor events",
      "failure codes"
    ],
    "jobs": [
      "detect failure spikes",
      "trace payment drops"
    ],
    "successMetrics": [
      "checkout success rate",
      "payment reliability"
    ],
    "approvalGates": [
      "payment config changes"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "merry-cliff-8846",
    "pageLabel": "Coupons",
    "agentName": "Coupon Agent",
    "autonomy": "A3",
    "objective": "Keep coupon strategy effective and clean.",
    "integrations": [
      "Coupon rules",
      "order data",
      "campaigns"
    ],
    "jobs": [
      "detect abuse",
      "score usage"
    ],
    "successMetrics": [
      "coupon profitability",
      "abuse prevention"
    ],
    "approvalGates": [
      "issuing or changing coupons"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "safely-dawn-7731",
    "pageLabel": "Subscriptions",
    "agentName": "Subscription Agent",
    "autonomy": "A4",
    "objective": "Maintain recurring commerce health.",
    "integrations": [
      "Subscription platform",
      "billing",
      "churn signals"
    ],
    "jobs": [
      "detect churn risk",
      "trigger save flows"
    ],
    "successMetrics": [
      "subscription retention",
      "retry recovery"
    ],
    "approvalGates": [
      "billing changes or messages"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "purely-dusk-2409",
    "pageLabel": "Shipping & Fulfillment",
    "agentName": "Fulfillment Agent",
    "autonomy": "A3",
    "objective": "Keep post-purchase operations healthy.",
    "integrations": [
      "Warehouse",
      "shipping",
      "OMS"
    ],
    "jobs": [
      "detect bottlenecks",
      "watch SLAs"
    ],
    "successMetrics": [
      "fulfillment SLA performance",
      "throughput"
    ],
    "approvalGates": [
      "workflow changes"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "soft-hill-4757",
    "pageLabel": "Taxes",
    "agentName": "Commerce Tax Agent",
    "autonomy": "A2",
    "objective": "Maintain correct commerce tax setup.",
    "integrations": [
      "Tax config",
      "checkout",
      "orders"
    ],
    "jobs": [
      "detect tax mismatches",
      "validate setup"
    ],
    "successMetrics": [
      "tax correctness",
      "tax issue resolution"
    ],
    "approvalGates": [
      "changing tax config"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "safely-air-9334",
    "pageLabel": "Collections",
    "agentName": "Merchandising Agent",
    "autonomy": "A3",
    "objective": "Curate high-performing groupings.",
    "integrations": [
      "Catalog",
      "inventory",
      "seasonality",
      "demand"
    ],
    "jobs": [
      "build collections",
      "rotate merchandising"
    ],
    "successMetrics": [
      "collection conversion",
      "collection freshness"
    ],
    "approvalGates": [
      "publishing collections"
    ]
  },
  {
    "sectionLabel": "Website & Commerce",
    "pageId": "merry-land-6169",
    "pageLabel": "Store Performance",
    "agentName": "Store Performance Agent",
    "autonomy": "A4",
    "objective": "Improve end-to-end store output.",
    "integrations": [
      "Web analytics",
      "checkout",
      "orders",
      "margin"
    ],
    "jobs": [
      "identify bottlenecks",
      "propose experiments"
    ],
    "successMetrics": [
      "store conversion lift",
      "margin lift"
    ],
    "approvalGates": [
      "launching live tests"
    ]
  },
  {
    "sectionLabel": "Google Business",
    "pageId": "daring-brook-9034",
    "pageLabel": "Reviews",
    "agentName": "Google Reputation Agent",
    "autonomy": "A4",
    "objective": "Operate Google review management.",
    "integrations": [
      "Google Business Profile APIs",
      "sentiment",
      "workspace context"
    ],
    "jobs": [
      "sync reviews",
      "draft replies"
    ],
    "successMetrics": [
      "response time",
      "review sentiment"
    ],
    "approvalGates": [
      "posting public replies"
    ]
  },
  {
    "sectionLabel": "Google Business",
    "pageId": "fresh-tide-9404",
    "pageLabel": "Connection Setup",
    "agentName": "Google OAuth Agent",
    "autonomy": "A2",
    "objective": "Connect the account safely via OAuth.",
    "integrations": [
      "OAuth",
      "Google account and location selection"
    ],
    "jobs": [
      "start auth",
      "validate scopes"
    ],
    "successMetrics": [
      "successful connection rate",
      "setup completion rate"
    ],
    "approvalGates": [
      "final connect"
    ]
  },
  {
    "sectionLabel": "Google Business",
    "pageId": "glad-coast-1428",
    "pageLabel": "Integrations",
    "agentName": "Google Integration Agent",
    "autonomy": "A3",
    "objective": "Keep Google sync healthy.",
    "integrations": [
      "OAuth credentials",
      "sync jobs",
      "API status"
    ],
    "jobs": [
      "monitor token health",
      "retry syncs"
    ],
    "successMetrics": [
      "sync uptime",
      "integration health"
    ],
    "approvalGates": [
      "remapping or reconnecting"
    ]
  },
  {
    "sectionLabel": "Settings",
    "pageId": "nicely-land-1864",
    "pageLabel": "Settings",
    "agentName": "Workspace Admin Agent",
    "autonomy": "A2",
    "objective": "Hold workspace-wide defaults and operating rules.",
    "integrations": [
      "Workspace profile",
      "permissions",
      "automation settings"
    ],
    "jobs": [
      "audit config",
      "suggest defaults"
    ],
    "successMetrics": [
      "config quality",
      "policy consistency"
    ],
    "approvalGates": [
      "changing settings"
    ]
  },
  {
    "sectionLabel": "Settings",
    "pageId": "pure-minute-5446",
    "pageLabel": "Billing",
    "agentName": "Billing Agent",
    "autonomy": "A2",
    "objective": "Keep the Lulu account commercially healthy.",
    "integrations": [
      "Subscription",
      "invoices",
      "payment method",
      "usage"
    ],
    "jobs": [
      "summarize billing state",
      "detect payment issues"
    ],
    "successMetrics": [
      "billing issue resolution",
      "billing clarity"
    ],
    "approvalGates": [
      "plan or payment changes"
    ]
  }
] as const;

export const canonicalAgentPageProfileById: Readonly<Record<string, CanonicalAgentPageProfile>> = Object.freeze(
  Object.fromEntries(canonicalAgentPageProfiles.map((profile) => [profile.pageId, profile])) as Record<string, CanonicalAgentPageProfile>,
);
