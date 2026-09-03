import type { DomainEvent, DomainEventHandler } from './domain-event.types.js';

const handlers = new Map<string, DomainEventHandler>();

export function registerDomainEventHandler(handler: DomainEventHandler) {
  const name = handler.name.trim();
  if (!name) throw new Error('Domain event handler name is required');
  if (handler.eventTypes.length === 0) throw new Error(`Domain event handler ${name} must subscribe to at least one event type`);
  if (handlers.has(name)) return;
  handlers.set(name, { ...handler, name });
}

export function handlersForDomainEvent(event: DomainEvent) {
  return [...handlers.values()].filter((handler) => handler.eventTypes.includes(event.type));
}

export function registeredDomainEventHandlers() {
  return [...handlers.values()];
}
