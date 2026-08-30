import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';
import { dbRateLimit } from '../src/middlewares/rateLimit.middleware.js';

describe('weighted rate limiting', () => {
  it('enforces request cost without a database in local and test environments', async () => {
    const app = express();
    app.use(express.json());
    app.post('/limited', dbRateLimit({
      keyPrefix: `weighted-test-${Date.now()}`,
      windowMs: 60_000,
      limit: 10,
      cost(req) {
        return Number((req.body as { cost?: unknown }).cost ?? 1);
      },
    }), (_req, res) => res.json({ success: true }));

    assert.equal((await request(app).post('/limited').send({ cost: 4 })).status, 200);
    assert.equal((await request(app).post('/limited').send({ cost: 6 })).status, 200);
    const blocked = await request(app).post('/limited').send({ cost: 1 });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.success, false);
  });
});
