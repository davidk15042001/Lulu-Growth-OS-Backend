import type { AgentExecutionCommand } from '../agents/agent.execution-command.js';

export type AgentQualityAssessment = {
  passed: boolean;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  limitations: string[];
  issues: string[];
};

function strings(value: unknown, max = 20, length = 500) {
  return Array.isArray(value)
    ? value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim().slice(0, length))
      .slice(0, max)
    : [];
}

function confidence(value: unknown): AgentQualityAssessment['confidence'] {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'low';
}

/**
 * Shared, deterministic checks for model-produced reasoning. The model may
 * propose a verdict, but it cannot make an unsupported result "verified".
 * These checks intentionally do not call another model: they are the server
 * side safety boundary before an autonomous action packet is created.
 */
export function assessAgentReasoningQuality(input: {
  taskType: string | null;
  reviewer?: boolean;
  availableEvidence?: unknown;
  result: Record<string, unknown>;
}): AgentQualityAssessment {
  const result = input.result;
  const evidence = strings(result.evidence ?? result.evidenceRefs, 40);
  const limitations = strings(result.limitations ?? result.uncertainties, 20, 1_000);
  const issues = strings(result.issues ?? result.findings, 20, 1_000);
  const level = confidence(result.confidence);
  const isReviewer = input.reviewer === true
    || input.taskType?.includes('review')
    || input.taskType === 'pre_execution_policy_gate'
    || input.taskType?.startsWith('verify_');
  const isCommandBuilder = input.taskType === 'materialize_execution_commands';
  const evidenceCorpus = input.availableEvidence === undefined
    ? null
    : JSON.stringify(input.availableEvidence).toLowerCase();
  const blockers: string[] = [];

  if (isReviewer && result.verdict === 'verified') {
    if (evidence.length === 0) blockers.push('verified_without_evidence');
    if (level === 'low') blockers.push('verified_with_low_confidence');
    if (issues.length > 0) blockers.push('verified_with_open_issues');
  }

  if (isCommandBuilder) {
    const commands = Array.isArray(result.commands) ? result.commands : [];
    for (const [index, command] of commands.entries()) {
      if (!command || typeof command !== 'object') {
        blockers.push(`command_${index + 1}_is_not_an_object`);
        continue;
      }
      const quality = (command as Record<string, unknown>).quality;
      if (!quality || typeof quality !== 'object' || Array.isArray(quality)) {
        blockers.push(`command_${index + 1}_missing_quality_metadata`);
        continue;
      }
      const commandQuality = quality as Record<string, unknown>;
      const commandEvidence = strings(commandQuality.evidenceRefs, 40);
      const commandConfidence = confidence(commandQuality.confidence);
      const commandLimitations = strings(commandQuality.limitations, 20, 1_000);
      if (commandEvidence.length === 0) blockers.push(`command_${index + 1}_missing_evidence`);
      if (commandConfidence === 'low') blockers.push(`command_${index + 1}_low_confidence`);
      if (commandLimitations.length > 0) blockers.push(`command_${index + 1}_has_unresolved_limitations`);
      if (evidenceCorpus !== null && commandEvidence.some((reference) => !evidenceCorpus.includes(reference.toLowerCase()))) {
        blockers.push(`command_${index + 1}_evidence_not_present_in_live_context`);
      }
    }
  }

  return {
    passed: blockers.length === 0,
    confidence: level,
    evidence,
    limitations,
    issues: [...issues, ...blockers],
  };
}

/**
 * Keep the command contract explicit for downstream audit views and the
 * execution record. A missing contract is represented as low confidence so
 * callers can fail closed instead of treating omitted metadata as verified.
 */
export function commandQuality(command: AgentExecutionCommand) {
  return {
    confidence: command.quality?.confidence ?? 'low',
    evidenceRefs: command.quality?.evidenceRefs ?? [],
    limitations: command.quality?.limitations ?? [],
  } as const;
}
