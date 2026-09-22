import assert from 'node:assert/strict';
import { agentExecutionCommandTypeSchema } from '../src/modules/agents/agent.execution-command.js';
import { requiredCapabilityForAgentCommand } from '../src/modules/agents/agent.command-capabilities.js';
import { evaluateAgentActionPolicy } from '../src/modules/agents/agent.autonomy-policy.js';

type EvaluationCase = {
  name: string;
  run: () => void;
};

const cases: EvaluationCase[] = [
  {
    name: 'every registered execution command has a server capability',
    run: () => {
      for (const command of agentExecutionCommandTypeSchema.options) {
        assert.ok(requiredCapabilityForAgentCommand(command), `Missing capability for ${command}`);
      }
    },
  },
  {
    name: 'unknown actions fail closed',
    run: () => assert.equal(evaluateAgentActionPolicy('unknown.action', true).decision, 'forbidden'),
  },
  {
    name: 'customer-funded advertising cannot bypass budget authorization',
    run: () => assert.equal(
      evaluateAgentActionPolicy('advertising.create_optimization', true, { budgetProtected: true }).decision,
      'require_budget',
    ),
  },
  {
    name: 'unfunded advertising remains blocked even in autonomous mode',
    run: () => assert.equal(
      evaluateAgentActionPolicy('advertising.create_optimization', true, { budgetProtected: true }).autonomyClass,
      'USER_AUTHORIZATION_REQUIRED',
    ),
  },
];

const results = cases.map((evaluation) => {
  try {
    evaluation.run();
    return { name: evaluation.name, status: 'passed' as const };
  } catch (error) {
    return { name: evaluation.name, status: 'failed' as const, error: error instanceof Error ? error.message : String(error) };
  }
});

const failed = results.filter((result) => result.status === 'failed');
console.log(JSON.stringify({ suite: 'lulu-ai-governance', evaluatedAt: new Date().toISOString(), results }, null, 2));
if (failed.length > 0) process.exitCode = 1;
