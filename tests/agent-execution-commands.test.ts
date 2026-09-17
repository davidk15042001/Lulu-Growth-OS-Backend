import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyExecutionCommandPolicies,
  normalizeAgentExecutionCommands,
} from '../src/modules/agents/agent.execution-command.js';
import { normalizedCommandsForRecord } from '../src/modules/agents/agent-execution.worker.js';
import { providerRequirementForAgentCommand } from '../src/modules/agents/agent.provider-requirements.js';

describe('agent execution commands', () => {
  it('registers CRM company synchronization as a provider-gated autonomous command', () => {
    const [command] = normalizeAgentExecutionCommands([], {
      module: 'crm', targetSystem: 'crm', actionResourceType: 'crm_companies',
      pageId: 'company-1', pageLabel: 'Company', goal: 'Keep the CRM company record synchronized',
      jobs: ['sync company'], policyDecision: 'allow', executionMode: 'autonomous',
      companyId: 'company-1', provider: 'hubspot', providerConnectionId: 'connection-1',
    });
    assert.ok(command);
    assert.equal(command.type, 'crm.company.sync');
    assert.equal(command.provider, 'hubspot');
    assert.deepEqual(command.payload, { companyId: 'company-1', provider: 'hubspot', providerConnectionId: 'connection-1' });
    assert.deepEqual(providerRequirementForAgentCommand(command), {
      required: true,
      providerKey: 'hubspot',
      reason: 'The command explicitly targets an external provider.',
    });
  });

  it('requires a verified provider for external side effects but not canonical internal writes', () => {
    assert.deepEqual(providerRequirementForAgentCommand({ type: 'crm.create_followup_task', provider: null, payload: {} }), {
      required: false,
      providerKey: null,
      reason: 'This command operates on canonical Lulu data and has no external provider target.',
    });
    assert.deepEqual(providerRequirementForAgentCommand({ type: 'omnichannel.send_message', provider: null, payload: {} }), {
      required: true,
      providerKey: null,
      reason: 'This external action requires a connected provider selected for the target.',
    });
    assert.deepEqual(providerRequirementForAgentCommand({ type: 'google_reviews.reply', provider: null, payload: {} }), {
      required: true,
      providerKey: 'google_business',
      reason: 'Google review replies require a verified Google Business provider.',
    });
  });
  it('registers company intelligence enrichment as an autonomous CRM command', () => {
    const [command] = normalizeAgentExecutionCommands([{
      type: 'crm.company.enrich',
      summary: 'Enrich the verified company profile',
      targetSystem: 'unknown',
      provider: null,
      riskLevel: 'high',
      approvalPolicy: 'require_approval',
      targetEntityType: 'crm_companies',
      targetEntityId: 'company-123',
      payload: { companyId: 'company-123' },
      idempotencyKey: 'model-company-enrich',
    }], {
      module: 'crm',
      targetSystem: 'crm',
      actionResourceType: 'crm_tasks',
      pageId: 'companies-page',
      pageLabel: 'Companies',
      goal: 'Enrich the verified company profile',
      jobs: ['enrich company information'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.ok(command);
    assert.equal(command.type, 'crm.company.enrich');
    assert.equal(command.targetSystem, 'crm');
    assert.equal(command.riskLevel, 'medium');
    assert.equal(command.approvalPolicy, 'allow');
    assert.equal(command.budgetAuthority, 'none');
  });

  it('infers company intelligence enrichment when a company action has a canonical record id', () => {
    const [command] = normalizeAgentExecutionCommands([], {
      module: 'crm',
      targetSystem: 'crm',
      actionResourceType: 'crm_companies',
      pageId: 'companies-page',
      pageLabel: 'Companies',
      goal: 'Keep the company profile complete',
      jobs: ['enrich company information'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
      companyId: 'company-123',
    });

    assert.ok(command);
    assert.equal(command.type, 'crm.company.enrich');
    assert.equal(command.targetEntityType, 'crm_companies');
    assert.equal(command.targetEntityId, 'company-123');
    assert.equal(command.payload.companyId, 'company-123');
  });

  it('infers a CRM follow-up task when no explicit CRM command exists', () => {
    const [command] = normalizeAgentExecutionCommands(undefined, {
      module: 'crm',
      targetSystem: 'crm',
      actionResourceType: 'crm_tasks',
      pageId: 'test-page',
      pageLabel: 'CRM Tasks',
      goal: 'Prepare the next CRM move',
      jobs: ['Assign lead follow-up'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.ok(command);
    assert.equal(command.type, 'crm.create_followup_task');
    assert.equal(command.targetSystem, 'crm');
    assert.equal(command.approvalPolicy, 'allow');
    assert.equal(command.targetEntityType, 'crm_task');
  });

  it('infers a Google review reply command from review metadata', () => {
    const [command] = normalizeAgentExecutionCommands(undefined, {
      module: 'reputation',
      targetSystem: 'reputation',
      actionResourceType: 'ai_actions',
      pageId: 'reviews-page',
      pageLabel: 'Google Reviews',
      goal: 'Answer priority negative review',
      jobs: ['Reply to priority review'],
      policyDecision: 'require_budget',
      executionMode: 'autonomous',
      accountId: 'account-1',
      locationId: 'location-1',
      reviewId: 'review-1',
      comment: 'Thanks for the feedback. We will contact you today.',
    });

    assert.ok(command);
    assert.equal(command.type, 'google_reviews.reply');
    assert.equal(command.provider, 'google_business');
    assert.equal(command.targetEntityId, 'review-1');
  });

  it('keeps valid explicit command intent but derives security policy and idempotency server-side', () => {
    const [command] = normalizeAgentExecutionCommands([
      {
        type: 'email.create_ai_draft',
        summary: 'Prepare a customer reply draft',
        targetSystem: 'communication',
        provider: 'email',
        riskLevel: 'medium',
        approvalPolicy: 'allow',
        targetEntityType: 'email_thread',
        targetEntityId: 'thread-1',
        payload: {
          accountId: 'account-1',
          threadId: 'thread-1',
          tone: 'professional',
          language: 'de',
        },
        idempotencyKey: 'explicit-command-1',
      },
    ], {
      module: 'email',
      targetSystem: 'communication',
      actionResourceType: 'ai_tasks',
      pageId: 'email-page',
      pageLabel: 'Email',
      goal: 'Reply to customer',
      jobs: ['Draft reply'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.ok(command);
    assert.equal(command.type, 'email.create_ai_draft');
    assert.equal(command.targetEntityId, 'thread-1');
    assert.notEqual(command.idempotencyKey, 'explicit-command-1');
    assert.match(command.idempotencyKey, /^[a-f0-9]{40}$/);
  });

  it('allows an agent to send only an explicitly generated email draft', () => {
    const [command] = normalizeAgentExecutionCommands([{
      type: 'email.send_draft',
      summary: 'Send the verified customer reply',
      targetSystem: 'unknown',
      provider: 'email',
      riskLevel: 'low',
      approvalPolicy: 'require_approval',
      targetEntityType: 'email_draft',
      targetEntityId: 'draft-1',
      payload: { draftId: 'draft-1' },
      idempotencyKey: 'model-send-key',
    }], {
      module: 'email',
      targetSystem: 'communication',
      actionResourceType: 'ai_tasks',
      pageId: 'email-page',
      pageLabel: 'Email',
      goal: 'Send a verified reply',
      jobs: ['Deliver reply'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.ok(command);
    assert.equal(command.type, 'email.send_draft');
    assert.equal(command.targetSystem, 'communication');
    assert.equal(command.riskLevel, 'high');
    assert.equal(command.approvalPolicy, 'allow');
    assert.equal(applyExecutionCommandPolicies([command], 'autonomous').overallDecision, 'allow');
  });

  it('cannot be tricked into removing the customer budget boundary from advertising', () => {
    const [command] = normalizeAgentExecutionCommands([{
      type: 'advertising.create_optimization',
      summary: 'Launch an authorized campaign',
      targetSystem: 'crm',
      provider: 'google-ads',
      riskLevel: 'low',
      approvalPolicy: 'allow',
      budgetAuthority: 'none',
      targetEntityType: 'campaign',
      targetEntityId: 'campaign-1',
      payload: { authorizationId: 'authorization-1', budgetAmountCny: 100 },
      idempotencyKey: 'model-controlled-key',
    }], {
      module: 'ads',
      targetSystem: 'advertising',
      actionResourceType: 'ad_optimizations',
      pageId: 'ads-page',
      pageLabel: 'Advertising',
      goal: 'Launch campaign',
      jobs: ['Launch campaign'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.ok(command);
    assert.equal(command.targetSystem, 'advertising');
    assert.equal(command.riskLevel, 'medium');
    assert.equal(command.budgetAuthority, 'customer_authorization_required');
    assert.equal(command.approvalPolicy, 'budget_required');
    assert.equal(applyExecutionCommandPolicies([command], 'autonomous').overallDecision, 'require_budget');
    assert.equal(applyExecutionCommandPolicies([command], 'autonomous', { verifiedCustomerBudget: true }).overallDecision, 'allow');
  });

  it('executes financial workflows autonomously when they do not request new customer funds', () => {
    const [command] = normalizeAgentExecutionCommands(undefined, {
      module: 'finance',
      targetSystem: 'finance',
      actionResourceType: 'finance_automations',
      pageId: 'finance-page',
      pageLabel: 'Finance',
      goal: 'Prepare overdue reconciliation automation',
      jobs: ['Create reconciliation automation'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.ok(command);
    const decision = applyExecutionCommandPolicies([command], 'autonomous');
    assert.equal(decision.overallDecision, 'allow');
    assert.match(decision.commands[0]?.policyReason ?? '', /permitted/i);
  });

  it('allows internal sales follow-up task creation in autonomous mode', () => {
    const [command] = normalizeAgentExecutionCommands(undefined, {
      module: 'sales',
      targetSystem: 'sales',
      actionResourceType: 'sales_tasks',
      pageId: 'sales-page',
      pageLabel: 'Sales',
      goal: 'Create the next sales follow-up',
      jobs: ['Assign priority follow-up'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.ok(command);
    const decision = applyExecutionCommandPolicies([command], 'autonomous');
    assert.equal(command.type, 'sales.create_followup_task');
    assert.equal(decision.overallDecision, 'allow');
  });

  it('keeps CRM pipeline transitions autonomous while the server owns the target and version', () => {
    const [command] = normalizeAgentExecutionCommands([{
      type: 'crm.transition_pipeline',
      summary: 'Qualify the verified lead',
      targetSystem: 'unknown',
      provider: null,
      riskLevel: 'high',
      approvalPolicy: 'require_approval',
      targetEntityType: 'crm_leads',
      targetEntityId: '00000000-0000-4000-8000-000000000321',
      payload: {
        resourceType: 'crm_leads',
        recordId: '00000000-0000-4000-8000-000000000321',
        targetState: 'qualified',
        expectedVersion: 4,
      },
      idempotencyKey: 'model-pipeline-transition',
    }], {
      module: 'crm',
      targetSystem: 'crm',
      actionResourceType: 'crm_leads',
      pageId: 'crm-page',
      pageLabel: 'CRM Leads',
      goal: 'Qualify the verified lead',
      jobs: ['Qualify lead'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.ok(command);
    assert.equal(command.type, 'crm.transition_pipeline');
    assert.equal(command.targetSystem, 'crm');
    assert.equal(command.riskLevel, 'low');
    assert.equal(command.approvalPolicy, 'allow');
    assert.equal(command.budgetAuthority, 'none');
    assert.match(command.idempotencyKey, /^[a-f0-9]{40}$/);
    assert.equal(applyExecutionCommandPolicies([command], 'autonomous').overallDecision, 'allow');
  });

  it('keeps autonomous quote creation server-owned and policy-bound', () => {
    const [command] = normalizeAgentExecutionCommands([{
      type: 'sales.quote.create',
      summary: 'Prepare the verified customer offer',
      targetSystem: 'unknown',
      provider: null,
      riskLevel: 'high',
      approvalPolicy: 'require_approval',
      targetEntityType: 'finance_quotes',
      targetEntityId: null,
      payload: {
        customerRecordId: '00000000-0000-4000-8000-000000000111',
        currency: 'cny',
        lines: [{ productName: 'Verified service', quantity: 1, unitPrice: 100 }],
      },
      idempotencyKey: 'model-quote-create',
    }], {
      module: 'sales',
      targetSystem: 'sales',
      actionResourceType: 'finance_quotes',
      pageId: 'quotes-page',
      pageLabel: 'Quotes',
      goal: 'Prepare the verified customer offer',
      jobs: ['Create offer'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.ok(command);
    assert.equal(command.type, 'sales.quote.create');
    assert.equal(command.targetSystem, 'sales');
    assert.equal(command.riskLevel, 'medium');
    assert.equal(command.approvalPolicy, 'allow');
    assert.equal(command.budgetAuthority, 'none');
    assert.match(command.idempotencyKey, /^[a-f0-9]{40}$/);
    assert.equal(applyExecutionCommandPolicies([command], 'autonomous').overallDecision, 'allow');
  });

  it('registers calendar event creation as an autonomous, non-budget command', () => {
    const [command] = normalizeAgentExecutionCommands([{
      type: 'calendar.event.create',
      summary: 'Schedule the verified customer follow-up',
      targetSystem: 'unknown',
      provider: null,
      riskLevel: 'high',
      approvalPolicy: 'require_approval',
      targetEntityType: 'calendar_native_event',
      targetEntityId: null,
      payload: {
        title: 'Customer follow-up',
        startAt: '2026-09-20T10:00:00+00:00',
        endAt: '2026-09-20T10:30:00+00:00',
        timezone: 'UTC',
      },
      idempotencyKey: 'model-calendar-event',
    }], {
      module: 'calendar',
      targetSystem: 'communication',
      actionResourceType: 'ai_tasks',
      pageId: 'calendar-page',
      pageLabel: 'Calendar',
      goal: 'Schedule the verified follow-up',
      jobs: ['Create calendar event'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.ok(command);
    assert.equal(command.type, 'calendar.event.create');
    assert.equal(command.targetSystem, 'communication');
    assert.equal(command.riskLevel, 'medium');
    assert.equal(command.approvalPolicy, 'allow');
    assert.equal(applyExecutionCommandPolicies([command], 'autonomous').overallDecision, 'allow');
  });

  it('infers a calendar event command from a calendar page action', () => {
    const [command] = normalizeAgentExecutionCommands([], {
      module: 'calendar',
      targetSystem: 'communication',
      actionResourceType: 'ai_tasks',
      pageId: 'calendar-page',
      pageLabel: 'Calendar',
      goal: 'Schedule the verified customer follow-up',
      jobs: ['Create calendar event'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
      eventTitle: 'Customer follow-up',
      startAt: '2026-09-20T10:00:00+00:00',
      endAt: '2026-09-20T10:30:00+00:00',
      timezone: 'UTC',
    });

    assert.ok(command);
    assert.equal(command.type, 'calendar.event.create');
    assert.equal(command.targetSystem, 'communication');
    assert.equal(command.payload.title, 'Customer follow-up');
    assert.equal(command.payload.startAt, '2026-09-20T10:00:00+00:00');
    assert.equal(command.approvalPolicy, 'allow');
  });

  it('infers an autonomous Omnichannel send from a real conversation context', () => {
    const [command] = normalizeAgentExecutionCommands([], {
      module: 'omnichannel',
      targetSystem: 'communication',
      actionResourceType: 'ai_tasks',
      pageId: 'omnichannel-page',
      pageLabel: 'Omnichannel',
      goal: 'Reply to the customer in the connected channel',
      jobs: ['Reply to the customer'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
      conversationId: 'conversation-123',
      messageText: 'Thanks for reaching out. We will send the details shortly.',
      messageType: 'TEXT',
      accountId: 'channel-account-123',
      recipientId: 'customer-456',
      recipientType: 'group',
      provider: 'unifyport',
    });

    assert.ok(command);
    assert.equal(command.type, 'omnichannel.send_message');
    assert.equal(command.targetSystem, 'communication');
    assert.equal(command.provider, 'unifyport');
    assert.equal(command.targetEntityType, 'omni_conversations');
    assert.equal(command.targetEntityId, 'conversation-123');
    assert.equal(command.payload.conversationId, 'conversation-123');
    assert.equal(command.payload.text, 'Thanks for reaching out. We will send the details shortly.');
    assert.equal(command.payload.recipientType, 'group');
    assert.equal(command.approvalPolicy, 'allow');
    assert.equal(applyExecutionCommandPolicies([command], 'autonomous').overallDecision, 'allow');
  });

  it('infers a grounded social publication from a real account and content brief', () => {
    const [command] = normalizeAgentExecutionCommands([], {
      module: 'marketing',
      targetSystem: 'marketing',
      actionResourceType: 'marketing_publications',
      pageId: 'marketing-page',
      pageLabel: 'Marketing',
      goal: 'Publish the verified campaign announcement',
      jobs: ['Publish campaign announcement'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
      socialAccountId: 'social-account-123',
      contentType: 'TEXT',
      contentMessage: 'Our verified launch announcement is now live.',
      provider: 'facebook',
      maxAttempts: 3,
    });

    assert.ok(command);
    assert.equal(command.type, 'social.content.publish');
    assert.equal(command.targetSystem, 'marketing');
    assert.equal(command.provider, 'facebook');
    assert.equal(command.targetEntityId, 'social-account-123');
    assert.equal(command.payload.socialAccountId, 'social-account-123');
    assert.equal(command.payload.contentType, 'TEXT');
    assert.equal(command.payload.message, 'Our verified launch announcement is now live.');
    assert.equal(command.payload.maxAttempts, 3);
    assert.equal(command.quality?.confidence, 'high');
    assert.equal(command.approvalPolicy, 'allow');
    assert.equal(applyExecutionCommandPolicies([command], 'autonomous').overallDecision, 'allow');
  });

  it('preserves persisted social publication fields for the real worker normalizer', () => {
    const [command] = normalizedCommandsForRecord({
      id: '00000000-0000-0000-0000-000000000456',
      workspaceId: '00000000-0000-0000-0000-000000000457',
      resourceType: 'marketing_publications',
      name: 'Social publication',
      data: {
        targetModule: 'marketing',
        targetSystem: 'marketing',
        pageId: 'marketing-page',
        pageLabel: 'Marketing',
        goal: 'Publish the approved campaign brief',
        jobs: ['Publish campaign announcement'],
        executionMode: 'autonomous',
        socialAccountId: 'social-account-456',
        contentType: 'IMAGE',
        contentMessage: 'A grounded image announcement.',
        contentMediaUrl: 'https://cdn.example.test/launch.png',
        contentAltText: 'Launch image',
        maxAttempts: 5,
      },
    } as never);
    assert.equal(command?.type, 'social.content.publish');
    assert.equal(command?.payload.socialAccountId, 'social-account-456');
    assert.equal(command?.payload.contentType, 'IMAGE');
    assert.equal(command?.payload.mediaUrl, 'https://cdn.example.test/launch.png');
    assert.equal(command?.payload.maxAttempts, 5);
  });

  it('infers website domain verification from a site and domain context', () => {
    const [command] = normalizeAgentExecutionCommands([], {
      module: 'website',
      targetSystem: 'website',
      actionResourceType: 'marketing_publications',
      pageId: 'website-page',
      pageLabel: 'Domains',
      goal: 'Verify the customer domain before publishing',
      jobs: ['verify DNS ownership'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
      siteId: 'site-123',
      domainId: 'domain-123',
    });

    assert.ok(command);
    assert.equal(command.type, 'website.domain.verify');
    assert.equal(command.targetSystem, 'website');
    assert.equal(command.targetEntityId, 'domain-123');
    assert.equal(command.payload.siteId, 'site-123');
    assert.equal(command.approvalPolicy, 'allow');
  });

  it('registers canonical product create and update commands with product capabilities', () => {
    const [command] = normalizeAgentExecutionCommands([{
      type: 'commerce.product.create',
      summary: 'Create the verified product',
      targetSystem: 'unknown',
      provider: null,
      riskLevel: 'high',
      approvalPolicy: 'require_approval',
      targetEntityType: 'product',
      targetEntityId: null,
      payload: { name: 'Verified product', productType: 'PHYSICAL_PRODUCT' },
      idempotencyKey: 'model-product-create',
    }], {
      module: 'commerce',
      targetSystem: 'ecommerce',
      actionResourceType: 'ai_actions',
      pageId: 'products-page',
      pageLabel: 'Products',
      goal: 'Create the verified product',
      jobs: ['Create product'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.ok(command);
    assert.equal(command.type, 'commerce.product.create');
    assert.equal(command.targetSystem, 'ecommerce');
    assert.equal(command.riskLevel, 'medium');
    assert.equal(command.approvalPolicy, 'allow');
    assert.equal(applyExecutionCommandPolicies([command], 'autonomous').overallDecision, 'allow');
  });

  it('keeps autonomous quote delivery server-owned and scoped to quote sending', () => {
    const [command] = normalizeAgentExecutionCommands([{
      type: 'sales.quote.send',
      summary: 'Send the verified customer offer',
      targetSystem: 'unknown',
      provider: null,
      riskLevel: 'low',
      approvalPolicy: 'require_approval',
      targetEntityType: 'finance_quotes',
      targetEntityId: '00000000-0000-4000-8000-000000000112',
      payload: {
        quoteId: '00000000-0000-4000-8000-000000000112',
        channel: 'secure_link',
      },
      idempotencyKey: 'model-quote-send',
    }], {
      module: 'sales',
      targetSystem: 'sales',
      actionResourceType: 'finance_quotes',
      pageId: 'quotes-page',
      pageLabel: 'Quotes',
      goal: 'Send the verified customer offer',
      jobs: ['Send offer'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.ok(command);
    assert.equal(command.type, 'sales.quote.send');
    assert.equal(command.targetSystem, 'sales');
    assert.equal(command.riskLevel, 'high');
    assert.equal(command.approvalPolicy, 'allow');
    assert.equal(command.budgetAuthority, 'none');
    assert.equal(applyExecutionCommandPolicies([command], 'autonomous').overallDecision, 'allow');
  });

  it('keeps invoice issue and delivery commands on finance capabilities', () => {
    const commands = normalizeAgentExecutionCommands([
      {
        type: 'finance.invoice.issue',
        summary: 'Issue the verified invoice',
        targetSystem: 'unknown', provider: null, riskLevel: 'low', approvalPolicy: 'require_approval',
        targetEntityType: 'finance_invoices', targetEntityId: '00000000-0000-4000-8000-000000000113',
        payload: { invoiceId: '00000000-0000-4000-8000-000000000113' }, idempotencyKey: 'model-invoice-issue',
      },
      {
        type: 'finance.invoice.send',
        summary: 'Send the verified invoice',
        targetSystem: 'unknown', provider: null, riskLevel: 'low', approvalPolicy: 'require_approval',
        targetEntityType: 'finance_invoices', targetEntityId: '00000000-0000-4000-8000-000000000114',
        payload: { invoiceId: '00000000-0000-4000-8000-000000000114', channel: 'secure_link' }, idempotencyKey: 'model-invoice-send',
      },
    ], {
      module: 'finance', targetSystem: 'finance', actionResourceType: 'finance_invoices', pageId: 'finance-page',
      pageLabel: 'Finance', goal: 'Complete verified billing', jobs: ['Issue invoice', 'Send invoice'],
      policyDecision: 'allow', executionMode: 'autonomous',
    });

    assert.deepEqual(commands.map((command) => command.type), ['finance.invoice.issue', 'finance.invoice.send']);
    assert.deepEqual(commands.map((command) => command.riskLevel), ['medium', 'high']);
    assert.deepEqual(commands.map((command) => command.approvalPolicy), ['allow', 'allow']);
    assert.equal(applyExecutionCommandPolicies(commands, 'autonomous').overallDecision, 'allow');
  });

  it('keeps canonical commerce and social commands autonomous but server-owned', () => {
    const commands = normalizeAgentExecutionCommands([
      {
        type: 'commerce.order.transition',
        summary: 'Confirm the verified order',
        targetSystem: 'unknown',
        provider: null,
        riskLevel: 'low',
        approvalPolicy: 'budget_required',
        targetEntityType: 'commerce_order',
        targetEntityId: '00000000-0000-4000-8000-000000000001',
        payload: { expectedVersion: 1, targetStatus: 'CONFIRMED' },
        idempotencyKey: 'model-key-commerce',
      },
      {
        type: 'social.content.publish',
        summary: 'Publish verified brand content',
        targetSystem: 'unknown',
        provider: 'facebook',
        riskLevel: 'low',
        approvalPolicy: 'budget_required',
        targetEntityType: 'social_publication',
        targetEntityId: null,
        payload: { socialAccountId: '00000000-0000-4000-8000-000000000002', contentType: 'TEXT', message: 'Hello' },
        idempotencyKey: 'model-key-social',
      },
    ], {
      module: 'commerce',
      targetSystem: 'ecommerce',
      actionResourceType: 'ecommerce_orders',
      pageId: 'orders-page',
      pageLabel: 'Orders',
      goal: 'Continue verified operations',
      jobs: ['Process order'],
      policyDecision: 'allow',
      executionMode: 'autonomous',
    });

    assert.deepEqual(commands.map((command) => command.targetSystem), ['ecommerce', 'marketing']);
    assert.deepEqual(commands.map((command) => command.riskLevel), ['medium', 'high']);
    assert.equal(applyExecutionCommandPolicies(commands, 'autonomous').overallDecision, 'allow');
    assert.ok(commands.every((command) => command.approvalPolicy === 'allow'));
    assert.ok(commands.every((command) => /^[a-f0-9]{40}$/.test(command.idempotencyKey)));
  });
});
