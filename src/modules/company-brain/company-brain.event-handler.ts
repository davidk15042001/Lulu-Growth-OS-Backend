import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import type { DomainEvent } from '../../events/domain-event.types.js';
import * as service from './company-brain.service.js';

const eventTypes = Object.values(DOMAIN_EVENT_TYPES).filter((value) => !value.startsWith('brain.'));

export function registerCompanyBrainEventHandler() {
  registerDomainEventHandler({
    name: 'company-brain-observer.v1',
    eventTypes,
    async handle(event: DomainEvent) {
      const result = await service.observeDomainEvent(event);
      return result ? { observationId: result.observation.id, signalId: result.signal.id } : undefined;
    },
  });
}
