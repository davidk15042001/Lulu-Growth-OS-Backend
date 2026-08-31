-- 0030_workspace_content_assets_expand_modules.sql
-- Allow newer generated modules to be stored in workspace_content_assets.

ALTER TABLE workspace_content_assets
  DROP CONSTRAINT IF EXISTS workspace_content_assets_module_check;

ALTER TABLE workspace_content_assets
  ADD CONSTRAINT workspace_content_assets_module_check
  CHECK (module IN ('website','seo','marketing','advertisement','email','analytics','competitors','knowledge'));
