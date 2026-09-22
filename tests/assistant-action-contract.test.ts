import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assistantActionTypeSchema } from '../src/modules/ai/assistant-action.types.js';
import { buildAssistantTools } from '../src/modules/ai/assistant.tools.js';
import { evaluateAgentActionPolicy } from '../src/modules/agents/agent.autonomy-policy.js';

describe('assistant action contract', () => {
  it('keeps the natural-language assistant aligned with the canonical execution surface', () => {
    const expected = [
      'crm.company.enrich', 'crm.company.sync', 'crm.transition_pipeline', 'sales.transition_pipeline',
      'finance.invoice.create_from_order', 'finance.invoice.issue', 'finance.invoice.send',
      'finance.payout.request', 'finance.payout.submit', 'email.send_draft', 'website.domain.verify',
      'commerce.category.create', 'commerce.category.update', 'commerce.inventory.adjust',
      'commerce.fulfillment.create', 'commerce.fulfillment.transition', 'social.content.publish',
      'social.publication.retry', 'social.publication.cancel',
    ] as const;
    for (const type of expected) assert.equal(assistantActionTypeSchema.safeParse(type).success, true, type);

    const actionTool = buildAssistantTools('00000000-0000-0000-0000-000000000000').find((tool) => tool.name === 'request_action');
    const actionEnum = (actionTool?.parameters.properties as { type?: { enum?: string[] } }).type?.enum ?? [];
    for (const type of expected) assert.equal(actionEnum.includes(type), true, `${type} missing from tool schema`);
    assert.equal(evaluateAgentActionPolicy('finance.payout.request', true).decision, 'allow');
    assert.equal(evaluateAgentActionPolicy('finance.payout.submit', true).decision, 'allow');
  });
});
