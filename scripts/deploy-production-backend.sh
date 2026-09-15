#!/bin/sh
set -eu

backend_dir=/var/www/lulu-growth-os/backend
environment_file=/etc/lulu-growth-backend.env
migration_unit="lulu-growth-backend-migration-$$"
reset_unit="lulu-growth-backend-test-reset-$$"
reset_marker="$backend_dir/.run-test-data-reset"

# A migration must never leave the production process stopped if the database
# is locked or the release runner disappears. The trap restores the service
# with the last complete code (or the new code if migration succeeded).
restore_backend() {
  if ! /usr/bin/systemctl is-active --quiet lulu-growth-backend 2>/dev/null; then
    /usr/bin/systemctl start lulu-growth-backend 2>/dev/null || true
  fi
}

# Keep a failed/disconnected deploy from leaving a named transient migration
# service behind. A completed systemd-run unit may already be collected; the
# stop is intentionally best-effort in that case.
cleanup_migration() {
  /usr/bin/systemctl stop "$migration_unit" 2>/dev/null || true
}
trap 'cleanup_migration; restore_backend' EXIT

# Deployments are pushed by GitHub Actions into a release directory without a
# .git checkout. Disable the obsolete minute-based git-poll timer so it cannot
# generate permanent failures or race the versioned deployment.
if /usr/bin/systemctl is-enabled --quiet lulu-backend-deploy.timer 2>/dev/null; then
  /usr/bin/systemctl disable --now lulu-backend-deploy.timer
fi
/usr/bin/systemctl reset-failed lulu-backend-deploy.service 2>/dev/null || true

# Wallet and ledger migrations include reconciliation backfills. Quiesce the
# old writer first so no payment/usage update can race the financial snapshot.
# The service's graceful shutdown drains in-flight provider work before exit.
/usr/bin/systemctl stop lulu-growth-backend

systemd-run --quiet --wait --pipe --collect \
  --unit="$migration_unit" \
  --property=Type=oneshot \
  --property=TimeoutStartSec=4h \
  --property=RuntimeMaxSec=4h \
  --property=WorkingDirectory="$backend_dir" \
  --property=EnvironmentFile="$environment_file" \
  /usr/bin/node "$backend_dir/dist/database/run.js"

# A one-time, explicitly authorized test-data reset can be requested by the
# deployment workflow through a marker file. It runs while the API is stopped,
# inside its own long-lived systemd unit, and the marker is removed only after
# the transaction commits successfully. Normal deployments never execute this.
if [ -f "$reset_marker" ]; then
  systemd-run --quiet --wait --pipe --collect \
    --unit="$reset_unit" \
    --property=Type=oneshot \
    --property=TimeoutStartSec=8h \
    --property=RuntimeMaxSec=8h \
    --property=WorkingDirectory="$backend_dir" \
    --property=EnvironmentFile="$environment_file" \
    /usr/bin/node "$backend_dir/scripts/lulu-fast-reset.mjs"
  rm -f "$reset_marker"
fi

/usr/bin/systemctl start lulu-growth-backend
/usr/bin/systemctl is-active --quiet lulu-growth-backend

# Keep verified Lulu domains routed to their canonical managed storefront and
# let ACME certificates be issued without granting the API process root access.
if [ -f "$backend_dir/deploy/lulu-managed-domain-reconcile.service" ] && [ -f "$backend_dir/deploy/lulu-managed-domain-reconcile.timer" ]; then
  /usr/bin/install -m 0644 "$backend_dir/deploy/lulu-managed-domain-reconcile.service" /etc/systemd/system/lulu-managed-domain-reconcile.service
  /usr/bin/install -m 0644 "$backend_dir/deploy/lulu-managed-domain-reconcile.timer" /etc/systemd/system/lulu-managed-domain-reconcile.timer
  /usr/bin/systemctl daemon-reload
  /usr/bin/systemctl enable --now lulu-managed-domain-reconcile.timer
  /usr/bin/systemctl start lulu-managed-domain-reconcile.service
fi
trap - EXIT
