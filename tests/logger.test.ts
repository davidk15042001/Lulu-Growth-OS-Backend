import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { serializeRequest, serializeResponse } from '../src/config/logger.js';

describe('HTTP log serializers', () => {
  it('never serializes authorization or cookie headers', () => {
    const serialized = serializeRequest({
      id: 'request-1',
      method: 'POST',
      url: '/oauth/callback?code=secret-oauth-code&state=secret-state',
      remoteAddress: '127.0.0.1',
      remotePort: 42_000,
      headers: {
        authorization: 'Bearer secret-access-token',
        cookie: 'refreshToken=secret-refresh-token',
      },
    });

    assert.deepEqual(serialized, {
      id: 'request-1',
      method: 'POST',
      url: '/oauth/callback',
      remoteAddress: '127.0.0.1',
      remotePort: 42_000,
    });
    assert.doesNotMatch(JSON.stringify(serialized), /secret-access-token|secret-refresh-token|secret-oauth-code|secret-state/);
  });

  it('serializes only the response status code', () => {
    assert.deepEqual(serializeResponse({ statusCode: 204, headers: { 'set-cookie': 'secret' } }), { statusCode: 204 });
  });
});
