import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessAgentReasoningQuality } from '../src/modules/quality/agent-quality-gate.js';

describe('agent quality gate', () => {
  it('rejects a verified reviewer result without evidence', () => {
    const result = assessAgentReasoningQuality({
      taskType: 'pre_execution_policy_gate',
      result: { verdict: 'verified', confidence: 'high', evidence: [], issues: [] },
    });
    assert.equal(result.passed, false);
    assert.ok(result.issues.includes('verified_without_evidence'));
  });

  it('accepts a high-confidence reviewer result with evidence and no open issues', () => {
    const result = assessAgentReasoningQuality({
      taskType: 'verify_execution_handoff',
      result: { verdict: 'verified', confidence: 'high', evidence: ['crm:company:123'], issues: [] },
    });
    assert.equal(result.passed, true);
  });

  it('fails closed when a command has no quality contract', () => {
    const result = assessAgentReasoningQuality({
      taskType: 'materialize_execution_commands',
      result: { commands: [{ type: 'email.send_draft' }] },
    });
    assert.equal(result.passed, false);
    assert.ok(result.issues.includes('command_1_missing_quality_metadata'));
  });

  it('requires evidence and resolved limitations for executable commands', () => {
    const result = assessAgentReasoningQuality({
      taskType: 'materialize_execution_commands',
      result: {
        commands: [{
          type: 'social.content.publish',
          quality: { confidence: 'high', evidenceRefs: ['draft:42'], limitations: ['provider audience is unclear'] },
        }],
      },
    });
    assert.equal(result.passed, false);
    assert.ok(result.issues.includes('command_1_has_unresolved_limitations'));
  });

  it('rejects evidence references that are not present in the live context', () => {
    const result = assessAgentReasoningQuality({
      taskType: 'materialize_execution_commands',
      availableEvidence: [{ recordId: 'company-123' }],
      result: {
        commands: [{
          type: 'crm.create_followup_task',
          quality: { confidence: 'high', evidenceRefs: ['company-999'], limitations: [] },
        }],
      },
    });
    assert.equal(result.passed, false);
    assert.ok(result.issues.includes('command_1_evidence_not_present_in_live_context'));
  });
});
