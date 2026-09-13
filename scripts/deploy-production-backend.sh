#!/bin/sh
set -eu

backend_dir=/var/www/lulu-growth-os/backend
environment_file=/etc/lulu-growth-backend.env

# A migration must never leave the production process stopped if the database
# is locked or the release runner disappears. The trap restores the service
# with the last complete code (or the new code if migration succeeded).
restore_backend() {
  if ! /usr/bin/systemctl is-active --quiet lulu-growth-backend 2>/dev/null; then
    /usr/bin/systemctl start lulu-growth-backend 2>/dev/null || true
  fi
}
trap restore_backend EXIT

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
  --property=Type=oneshot \
  --property=TimeoutStartSec=15min \
  --property=WorkingDirectory="$backend_dir" \
  --property=EnvironmentFile="$environment_file" \
  /usr/bin/node "$backend_dir/dist/database/run.js"

/usr/bin/systemctl start lulu-growth-backend
/usr/bin/systemctl is-active --quiet lulu-growth-backend
trap - EXIT
