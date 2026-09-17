import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/utils/app-error.js';
import { classifyAgentFailure, isAgentPrerequisiteFailure } from '../src/modules/agents/agent-prerequisite.js';

describe('agent prerequisite blocking', () => {
  it('classifies missing provider setup as a durable block', () => {
    const error = new AppError(409, 'GOOGLE_ADS_NOT_CONNECTED', 'Connect a Google Ads account before launching paid campaigns.');
    const result = classifyAgentFailure(error);
    assert.equal(result.blocked, true);
    assert.equal(result.code, 'AGENT_PREREQUISITE_REQUIRED');
    assert.equal(result.originalCode, 'GOOGLE_ADS_NOT_CONNECTED');
    assert.match(result.message, /will not retry/i);
    assert.match(result.message, /Google Ads account/i);
  });

  it('does not misclassify transient provider failures as missing setup', () => {
    const error = new AppError(502, 'GOOGLE_ADS_PROVIDER_REQUEST_FAILED', 'Google Ads timed out while reading campaign data.');
    assert.equal(isAgentPrerequisiteFailure(error), false);
    assert.equal(classifyAgentFailure(error).code, 'GOOGLE_ADS_PROVIDER_REQUEST_FAILED');
  });

  it('recognizes missing business context from an untyped tool error', () => {
    const result = classifyAgentFailure(new Error('A customer record is required before creating a quote.'));
    assert.equal(result.blocked, true);
    assert.equal(result.code, 'AGENT_PREREQUISITE_REQUIRED');
  });

  it('pauses provider delivery failures that require a corrected channel context', () => {
    for (const code of ['OMNICHANNEL_PROVIDER_UNSUPPORTED', 'UNIFYPORT_RECIPIENT_INVALID', 'TWILIO_WORKSPACE_TEMPLATE_REQUIRED']) {
      const result = classifyAgentFailure(new AppError(409, code, 'The connected channel cannot deliver this message yet.'));
      assert.equal(result.blocked, true, code);
      assert.equal(result.code, 'AGENT_PREREQUISITE_REQUIRED', code);
    }
  });
});

