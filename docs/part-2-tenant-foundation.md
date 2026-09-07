# Part 2 tenant foundation

## Ownership contract

- **WORKSPACE_OWNED** is the default for operational records. Workspace ID is
  mandatory at repository and route boundaries.
- **ORGANIZATION_OWNED** is reserved for explicitly shared business identity
  data. It is not a replacement for the workspace isolation boundary.
- **LULU_PLATFORM_OWNED** covers global catalogs and platform configuration.
- **SHARED_PLATFORM_RESOURCE** covers managed identities/resources that may be
  used by multiple workspaces and must be mediated by a platform service.

## RLS status

`RLS_DEFERRED_WITH_CONTROLS`. The current `pg` pool does not establish a
transaction-scoped `app.workspace_id` for every request, worker, scheduler and
admin operation. Enabling RLS globally now would create fail-open/closed
ambiguity during background jobs. The staged plan is: establish a tenant-aware
transaction wrapper, set/reset a local tenant variable, add explicit system and
admin policies, enable RLS on `workspace_records` and billing ledgers first,
validate existing rows, then expand table by table. Application authorization
remains mandatory after RLS adoption.

## Database protections shipped

The Part 2 migration adds capability/entitlement registries, deterministic
Organization/Legal Entity/Factory mappings, and composite foreign keys for
workspace records, relationships, comments and attachments. Composite keys are
`NOT VALID` for legacy rows so deployment remains forward-safe; new writes must
match the parent workspace. Legacy data can be audited and validated in a later
maintenance window.

Owner membership changes are mediated by the workspace service and audited. A
database trigger blocks deletion of the last owner (including direct SQL); an
explicit transfer promotes the successor before demoting the current owner.
