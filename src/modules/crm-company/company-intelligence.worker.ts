import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { attachCustomerResponse, processCompanyIntelligence, queueBlockedCompanies, queueLegacyCompanies } from './company-intelligence.service.js';

let started = false;

export function startCompanyIntelligenceWorker() {
  if (started) return;
  started = true;
  registerDomainEventHandler({
    name: 'crm.company-intelligence.v1',
    eventTypes: [
      DOMAIN_EVENT_TYPES.RECORD_CREATED,
      DOMAIN_EVENT_TYPES.RECORD_UPDATED,
      DOMAIN_EVENT_TYPES.API_FUNDS_FUNDED,
      DOMAIN_EVENT_TYPES.MESSAGE_RECEIVED,
    ],
    async handle(event) {
      if (!event.workspaceId) return { ignored: true };
      if (event.type === DOMAIN_EVENT_TYPES.API_FUNDS_FUNDED) {
        return { queued: await queueBlockedCompanies(event.workspaceId) };
      }
      if (event.type === DOMAIN_EVENT_TYPES.MESSAGE_RECEIVED) {
        const conversationId = typeof event.payload.conversationId === 'string' ? event.payload.conversationId : null;
        return conversationId ? attachCustomerResponse(event.workspaceId, conversationId) : { ignored: true };
      }
      if (event.payload.resourceType !== 'crm_companies') return { ignored: true };
      const recordId = typeof event.payload.recordId === 'string' ? event.payload.recordId : event.aggregateId;
      return recordId ? processCompanyIntelligence(event.workspaceId, recordId) : { ignored: true };
    },
  });
  logger.info('Autonomous CRM company intelligence consumer registered');
  void queueLegacyCompanies().then((queued) => {
    if (queued) logger.info({ queued }, 'Legacy CRM companies queued for autonomous enrichment');
  }).catch((error) => logger.warn({ error }, 'Legacy CRM companies could not be queued for enrichment'));
}
