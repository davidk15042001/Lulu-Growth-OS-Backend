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
      policyDecision: 'require_approval',
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

  it('keeps explicit commands when they are valid', () => {
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
    assert.equal(command.idempotencyKey, 'explicit-command-1');
  });

  it('requires explicit authorization for financial operations even in autonomous mode', () => {
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
    assert.equal(decision.overallDecision, 'require_approval');
    assert.match(decision.commands[0]?.policyReason ?? '', /human authorization is required/i);
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
});
