# Migration safety review

Before release:

1. Apply all migrations to an empty isolated database and run `npm run test:migrations` plus `npm run test:schema-contracts`.
2. Apply the migration to a recent scrubbed production snapshot and verify row counts, foreign keys, indexes, triggers, and representative read/write paths.
3. Classify every statement as expand, backfill, validate, contract, or destructive. Destructive statements require a separately approved change window.
4. Confirm old and new application versions can coexist during the rollout. New columns need safe defaults or nullable phases before a code cutover.
5. Measure lock duration and cancel unsafe statements before they block tenant traffic.
6. Record the migration identifier, release manifest, rollback plan, and post-deploy smoke-test results.

The migration runner uses an advisory lock so only one runner owns schema changes. That lock does not replace a restore rehearsal or a compatibility review.

