import { notFoundError } from '../../utils/app-error.js';
import * as repo from './conversation.repo.js';
import * as workspaceService from '../workspaces/workspace.service.js';
import * as onboardingRepo from '../onboarding/onboarding.repo.js';
import {
  generateAssistantResponse,
  generateAssistantResponseWithTools,
  isAiGenerationConfigured,
  type AssistantPendingAction,
} from './openai.service.js';
import { buildAssistantTools } from './assistant.tools.js';
import { executeAssistantAction } from './assistant-actions.service.js';
import { AppError } from '../../utils/app-error.js';
import type {
  CreateConversationInput,
  CreateMessageInput,
  ListConversationsQuery,
  ListMessagesQuery,
  UpdateConversationInput,
} from './conversation.validator.js';

export const listConversations = (
  workspaceId: string,
  userId: string,
  filters: ListConversationsQuery
) => repo.listConversations(workspaceId, userId, filters);

export async function getConversation(workspaceId: string, userId: string, conversationId: string) {
  const conversation = await repo.findConversation(workspaceId, userId, conversationId);
  if (!conversation) throw notFoundError('Conversation not found');
  return conversation;
}

export async function createConversation(
  workspaceId: string,
  userId: string,
  input: CreateConversationInput
) {
  const id = await repo.createConversation(workspaceId, userId, input);
  if (!id) throw new Error('Conversation insert did not return an id');
  return getConversation(workspaceId, userId, id);
}

export async function updateConversation(
  workspaceId: string,
  userId: string,
  conversationId: string,
  input: UpdateConversationInput
) {
  if (!(await repo.updateConversation(workspaceId, userId, conversationId, input))) {
    throw notFoundError('Conversation not found');
  }
  return getConversation(workspaceId, userId, conversationId);
}

export async function archiveConversation(workspaceId: string, userId: string, conversationId: string) {
  if (!(await repo.archiveConversation(workspaceId, userId, conversationId))) {
    throw notFoundError('Conversation not found');
  }
}

export const listMessages = (
  workspaceId: string,
  userId: string,
  conversationId: string,
  filters: ListMessagesQuery
) => repo.listMessages(workspaceId, userId, conversationId, filters);

export async function createUserMessage(
  workspaceId: string,
  userId: string,
  conversationId: string,
  input: CreateMessageInput
) {
  const message = await repo.createUserMessage(workspaceId, userId, conversationId, input);
  if (!message) throw notFoundError('Conversation not found');
  return message;
}

export async function respond(
  workspaceId: string,
  userId: string,
  conversationId: string,
  input: CreateMessageInput
) {
  if (!isAiGenerationConfigured()) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'The configured AI provider is not configured');
  }

  const conversation = await getConversation(workspaceId, userId, conversationId);
  const userMessage = await createUserMessage(workspaceId, userId, conversationId, input);
  const [workspace, preferences, turns] = await Promise.all([
    workspaceService.getWorkspace(workspaceId, userId),
    onboardingRepo.getAiPreferences(workspaceId),
    repo.conversationTurns(workspaceId, userId, conversationId),
  ]);

  const generated = await generateAssistantResponse({
    userId,
    workspaceId,
    model: conversation.model,
    turns,
    context: {
      company: {
        name: workspace.companyName,
        industry: workspace.industry,
        businessDescription: workspace.businessDescription,
        valueProposition: workspace.valueProposition,
        targetMarket: workspace.targetMarket,
      },
      preferences: preferences ? {
        priorities: preferences.businessPriorities,
        communicationStyle: preferences.communicationStyle,
        insightDetail: preferences.insightDetail,
        responseLanguage: preferences.responseLanguage,
        actionLevel: preferences.actionLevel,
      } : null,
    },
  });

  const assistantMessage = await repo.appendAssistantMessage(
    conversationId,
    generated.content,
    { providerResponseId: generated.responseId, model: generated.model },
    {
      ...(generated.usage.inputTokens === null ? {} : { inputTokens: generated.usage.inputTokens }),
      ...(generated.usage.outputTokens === null ? {} : { outputTokens: generated.usage.outputTokens }),
    }
  );

  return { userMessage, assistantMessage, model: generated.model };
}

export async function respondAgentic(
  workspaceId: string,
  userId: string,
  conversationId: string,
  input: CreateMessageInput
) {
  if (!isAiGenerationConfigured()) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'The configured AI provider is not configured');
  }

  const conversation = await getConversation(workspaceId, userId, conversationId);
  const userMessage = await createUserMessage(workspaceId, userId, conversationId, input);
  const [workspace, preferences, turns] = await Promise.all([
    workspaceService.getWorkspace(workspaceId, userId),
    onboardingRepo.getAiPreferences(workspaceId),
    repo.conversationTurns(workspaceId, userId, conversationId),
  ]);

  const generated = await generateAssistantResponseWithTools({
    userId,
    workspaceId,
    model: conversation.model,
    turns,
    context: {
      company: {
        name: workspace.companyName,
        industry: workspace.industry,
        businessDescription: workspace.businessDescription,
        valueProposition: workspace.valueProposition,
        targetMarket: workspace.targetMarket,
      },
      preferences: preferences ? {
        priorities: preferences.businessPriorities,
        communicationStyle: preferences.communicationStyle,
        insightDetail: preferences.insightDetail,
        responseLanguage: preferences.responseLanguage,
        actionLevel: preferences.actionLevel,
      } : null,
    },
    tools: buildAssistantTools(),
  });

  const assistantMessage = await repo.appendAssistantMessage(
    conversationId,
    generated.content,
    {
      providerResponseId: generated.responseId,
      model: generated.model,
      toolCalls: generated.toolCalls.map((call) => ({ name: call.name, args: call.args })),
      pendingActions: generated.pendingActions,
    },
    {
      ...(generated.usage.inputTokens === null ? {} : { inputTokens: generated.usage.inputTokens }),
      ...(generated.usage.outputTokens === null ? {} : { outputTokens: generated.usage.outputTokens }),
    }
  );

  return {
    userMessage,
    assistantMessage,
    model: generated.model,
    toolCalls: generated.toolCalls,
    pendingActions: generated.pendingActions,
  };
}

export async function executeAction(workspaceId: string, userId: string, action: AssistantPendingAction) {
  return executeAssistantAction(workspaceId, userId, action);
}
