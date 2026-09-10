#!/bin/sh
set -eu

backend_dir=/var/www/lulu-growth-os/backend
environment_file=/etc/lulu-growth-backend.env

# Deployments are pushed by GitHub Actions into a release directory without a
# .git checkout. Disable the obsolete minute-based git-poll timer so it cannot
# generate permanent failures or race the versioned deployment.
if /usr/bin/systemctl is-enabled --quiet lulu-backend-deploy.timer 2>/dev/null; then
  /usr/bin/systemctl disable --now lulu-backend-deploy.timer
fi
/usr/bin/systemctl reset-failed lulu-backend-deploy.service 2>/dev/null || true

systemd-run --quiet --wait --pipe --collect \
  --property=Type=oneshot \
  --property=WorkingDirectory="$backend_dir" \
  --property=EnvironmentFile="$environment_file" \
  /usr/bin/node "$backend_dir/dist/database/run.js"

/usr/bin/systemctl restart lulu-growth-backend
/usr/bin/systemctl is-active --quiet lulu-growth-backend
