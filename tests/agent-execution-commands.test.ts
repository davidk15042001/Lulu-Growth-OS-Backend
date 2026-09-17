import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyExecutionCommandPolicies,
  normalizeAgentExecutionCommands,
} from '../src/modules/agents/agent.execution-command.js';

describe('agent execution commands', () => {
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
