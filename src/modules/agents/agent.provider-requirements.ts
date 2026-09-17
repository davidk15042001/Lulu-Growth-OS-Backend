import type { AgentExecutionCommand, AgentExecutionCommandType } from './agent.execution-command.js';

export type AgentProviderRequirement = {
  required: boolean;
  providerKey: string | null;
  reason: string;
};

function text(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 80) : null;
}

/**
 * Maps executable commands to the provider contract they depend on.
 *
 * Canonical Lulu mutations (for example creating a CRM task or an invoice)
 * do not require a third-party connection. External side effects do. Keeping
 * this decision server-owned prevents model output or a UI label from making
 * an unconfigured provider look executable.
 */
export function providerRequirementForAgentCommand(command: Pick<AgentExecutionCommand, 'type' | 'provider' | 'payload'>): AgentProviderRequirement {
  const explicit = text(command.provider ?? command.payload.provider);
  const externalWithoutOptionalProvider = new Set<AgentExecutionCommandType>([
    'omnichannel.send_message',
    'email.send_draft',
    'social.content.publish',
    'social.publication.retry',
    'social.publication.cancel',
  ]);

  if (command.type === 'google_reviews.reply') {
    return { required: true, providerKey: explicit ?? 'google_business', reason: 'Google review replies require a verified Google Business provider.' };
  }
  if (command.type === 'website.publish_job' || command.type === 'website.domain.verify') {
    return { required: true, providerKey: explicit ?? 'lulu_managed_website', reason: 'Managed website operations require a verified Lulu website provider.' };
  }
  if (externalWithoutOptionalProvider.has(command.type)) {
    return { required: true, providerKey: explicit, reason: 'This external action requires a connected provider selected for the target.' };
  }
  if (explicit) return { required: true, providerKey: explicit, reason: 'The command explicitly targets an external provider.' };
  return { required: false, providerKey: null, reason: 'This command operates on canonical Lulu data and has no external provider target.' };
}

