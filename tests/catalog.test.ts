import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getResourceDefinition,
  isResourceType,
  RESOURCE_CATALOG,
  RESOURCE_DOMAINS,
} from '../src/domain/resource-catalog.js';

describe('resource catalog', () => {
  it('contains unique, valid keys', () => {
    const keys = RESOURCE_CATALOG.map((resource) => resource.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const key of keys) {
      assert.match(key, /^[a-z][a-z0-9_]*$/);
      assert.equal(isResourceType(key), true);
    }
  });

  it('uses only registered domains', () => {
    const domains = new Set<string>(RESOURCE_DOMAINS);
    for (const resource of RESOURCE_CATALOG) {
      assert.equal(domains.has(resource.domain), true);
      assert.ok(resource.label.length > 0);
      assert.ok(resource.description.length > 0);
    }
  });

  it('rejects unknown resource types', () => {
    assert.equal(isResourceType('unknown_resource'), false);
    assert.equal(getResourceDefinition('unknown_resource'), undefined);
  });
});
