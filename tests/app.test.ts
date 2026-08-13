import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { RESOURCE_CATALOG } from '../src/domain/resource-catalog.js';

describe('HTTP application', () => {
  it('reports process health without requiring a database', async () => {
    const response = await request(createApp()).get('/health');

    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.data.status, 'ok');
  });

  it('reports not ready when DATABASE_URL is not configured', async () => {
    const response = await request(createApp()).get('/ready');

    assert.equal(response.status, 503);
    assert.equal(response.body.success, false);
    assert.equal(response.body.data.database.configured, false);
  });

  it('exposes the API descriptor and complete resource catalog', async () => {
    const api = await request(createApp()).get('/api/v1');
    const catalog = await request(createApp()).get('/api/v1/resource-types');

    assert.equal(api.status, 200);
    assert.equal(api.body.data.version, 'v1');
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.data.items.length, RESOURCE_CATALOG.length);
  });

  it('returns structured validation errors', async () => {
    const response = await request(createApp())
      .post('/api/v1/auth/register')
      .send({ email: 'not-an-email', password: 'short' });

    assert.equal(response.status, 422);
    assert.equal(response.body.success, false);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(response.body.error.details));
  });

  it('returns 404 for unknown routes', async () => {
    const response = await request(createApp()).get('/does-not-exist');
    assert.equal(response.status, 404);
  });
});
