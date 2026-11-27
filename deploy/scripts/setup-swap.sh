#!/bin/sh
# One-time host setup: a swap file so short memory spikes (the three apps
# starting together, a burst of publish activities) page out instead of
# OOM-killing.
# Usage: sudo ./setup-swap.sh [size, default 2G]
set -eu
SIZE="${1:-2G}"
if swapon --show | grep -q /swapfile; then
  echo "swap already active"; swapon --show; exit 0
fi
fallocate -l "$SIZE" /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
# Prefer RAM; only swap under real pressure.
sysctl -w vm.swappiness=10
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
swapon --show
