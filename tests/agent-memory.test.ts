import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ZEP_ORG_KNOWLEDGE_GRAPH_ID,
  addAgentMemoryMessages,
  addOrganizationKnowledgeToMemory,
  addUserBusinessDataToMemory,
  createAgentMemoryThread,
  ensureAgentMemoryUser,
  getAgentMemoryContext,
  getOrganizationKnowledgeContext,
  setAgentMemoryClientForTests,
  workspaceScopedZepUserId,
} from '../src/modules/agent-memory/agent-memory.service.js';

function fakeClient(options?: { fail?: boolean }) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const maybeFail = async () => {
    if (options?.fail) throw new Error('zep unavailable');
  };
  const client = {
    user: {
      async add(...args: unknown[]) {
        calls.push({ name: 'user.add', args });
        await maybeFail();
        return {};
      },
    },
    thread: {
      async create(...args: unknown[]) {
        calls.push({ name: 'thread.create', args });
        await maybeFail();
        return {};
      },
      async addMessages(...args: unknown[]) {
        calls.push({ name: 'thread.addMessages', args });
        await maybeFail();
        return {};
      },
      async getUserContext(...args: unknown[]) {
        calls.push({ name: 'thread.getUserContext', args });
        await maybeFail();
        return { context: 'Customer prefers concise German updates.' };
      },
    },
    graph: {
      async add(...args: unknown[]) {
        calls.push({ name: 'graph.add', args });
        await maybeFail();
        return {};
      },
      async search(...args: unknown[]) {
        calls.push({ name: 'graph.search', args });
        await maybeFail();
        return { context: 'Lulu policy requires verified settlement evidence.' };
      },
    },
  };
  return { client, calls };
}

afterEach(() => {
  setAgentMemoryClientForTests(undefined);
});

describe('agent memory Zep adapter', () => {
  it('creates users, workspace-scoped threads, and chat messages', async () => {
    const { client, calls } = fakeClient();
    setAgentMemoryClientForTests(client);

    assert.equal(workspaceScopedZepUserId('workspace-1', 'user-1'), 'workspace:workspace-1:user:user-1');
    assert.deepEqual(await ensureAgentMemoryUser({ userId: 'user-1', email: 'a@example.test', firstName: 'Ada', lastName: 'Lovelace' }), { configured: true, ok: true });

    const thread = await createAgentMemoryThread({ workspaceId: 'workspace-1', userId: 'user-1', conversationId: 'conversation-1' });
    assert.equal(thread.threadId, 'conversation:conversation-1');

    await addAgentMemoryMessages({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      threadId: thread.threadId,
      conversationId: 'conversation-1',
      messages: [{
        id: 'message-1',
        role: 'user',
        content: 'Hallo',
        createdAt: '2026-09-20T00:00:00.000Z',
        metadata: { workspace_id: 'foreign-workspace', source: 'untrusted', api_key: 'must-not-leave-lulu', label: 'customer-chat' },
      }],
    });

    const addMessages = calls.find((call) => call.name === 'thread.addMessages');
    assert.ok(addMessages);
    assert.equal(addMessages.args[0], 'conversation:conversation-1');
    assert.deepEqual((addMessages.args[1] as any).messages[0].metadata, {
      workspace_id: 'workspace-1',
      user_id: 'user-1',
      conversation_id: 'conversation-1',
      source: 'lulu.ai_conversation',
      label: 'customer-chat',
    });
  });

  it('retrieves memory context and degrades when Zep fails', async () => {
    const ok = fakeClient();
    setAgentMemoryClientForTests(ok.client);
    assert.equal(await getAgentMemoryContext({ workspaceId: 'workspace-1', userId: 'user-1', threadId: 'thread-1', conversationId: 'conversation-1' }), 'Customer prefers concise German updates.');
    assert.equal(await getOrganizationKnowledgeContext({ query: 'What evidence is required for a settlement?' }), 'Lulu policy requires verified settlement evidence.');
    const search = ok.calls.find((call) => call.name === 'graph.search');
    assert.equal((search?.args[0] as { graphId?: string }).graphId, ZEP_ORG_KNOWLEDGE_GRAPH_ID);

    const failing = fakeClient({ fail: true });
    setAgentMemoryClientForTests(failing.client);
    assert.equal(await getAgentMemoryContext({ workspaceId: 'workspace-1', userId: 'user-1', threadId: 'thread-1', conversationId: 'conversation-1' }), null);
    assert.equal(await getOrganizationKnowledgeContext({ query: 'What evidence is required for a settlement?' }), null);
    assert.deepEqual(await createAgentMemoryThread({ workspaceId: 'workspace-1', userId: 'user-1', conversationId: 'conversation-1' }), { configured: true, threadId: null });
  });

  it('adds user business data and shared organization knowledge to the correct graph targets', async () => {
    const { client, calls } = fakeClient();
    setAgentMemoryClientForTests(client);

    await addUserBusinessDataToMemory({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      source: 'orders',
      sourceId: 'order-1',
      data: { status: 'paid' },
    });
    await addOrganizationKnowledgeToMemory({
      source: 'policy',
      sourceId: 'policy-1',
      data: 'Refunds require verified payment evidence.',
    });

    const graphCalls = calls.filter((call) => call.name === 'graph.add');
    assert.equal((graphCalls[0]!.args[0] as any).userId, 'workspace:workspace-1:user:user-1');
    assert.equal((graphCalls[0]!.args[0] as any).graphId, undefined);
    assert.equal((graphCalls[1]!.args[0] as any).graphId, ZEP_ORG_KNOWLEDGE_GRAPH_ID);
    assert.equal((graphCalls[1]!.args[0] as any).userId, undefined);
  });
});
