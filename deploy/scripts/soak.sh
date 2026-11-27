#!/bin/sh
# Memory soak test. Samples container memory every minute for HOURS hours, then writes a
# summary (date, tier, peak memory per service, OOM-kill count, restarts) to deploy/soak/ and fails if
# any container was OOM-killed or restarted, or a pm2 process inside the app container was restarted.
# A counter that cannot be read is shown as n/a and the run is UNKNOWN (exit 2), never PASS: PASS means
# zero OOM kills were observed, not that none could be read. The kernel log is one of those counters:
# it is checked before the first sample, and the run does not start (exit 2) when dmesg cannot be read
# (it is root-only where kernel.dmesg_restrict=1) or already holds an out-of-memory message.
# Container OOM kills are read from the cgroup counter, because the kernel killing a node process
# inside the app container does not restart the container: pm2 restarts the process and docker shows nothing.
# Usage: ./soak.sh [hours, default 72] [tier, default 2gb]
set -eu
HOURS="${1:-72}"
TIER="${2:-2gb}"
SOAK_DIR="$(cd "$(dirname "$0")/.." && pwd)/soak"
STAMP=$(date +%Y-%m-%d)
CSV="$SOAK_DIR/soak-$STAMP-$TIER.csv"
SUMMARY="$SOAK_DIR/soak-$STAMP-$TIER.md"
CONTAINERS="app postgres redis temporal caddy"
SAMPLE_SECONDS="${SOAK_SAMPLE_SECONDS:-60}"
# SOAK_DURATION_SECONDS shortens the run for a dry run of this script; the real soak uses the hours.
START=$(date +%s)
END=$(( START + ${SOAK_DURATION_SECONDS:-$(( HOURS * 3600 ))} ))
mkdir -p "$SOAK_DIR"

# Prints the value of a cgroup file inside a container ("-" when the host does not expose it).
cgroup() {
  docker exec "$1" cat "/sys/fs/cgroup/$2" 2>/dev/null || echo "-"
}

# Prints $1 when it is a whole number and "-" otherwise, so an unreadable counter never reads as a measurement.
count_or_dash() {
  case "$1" in ''|*[!0-9]*) echo "-" ;; *) echo "$1" ;; esac
}

# Prints the oom_kill counter of a container's cgroup ("-" when memory.events cannot be read or has no such line).
oom_kills() {
  count_or_dash "$(docker exec "$1" cat /sys/fs/cgroup/memory.events 2>/dev/null | awk '$1 == "oom_kill" { print $2 }')"
}

# Prints "yes" when the kernel log holds an out-of-memory message, "no" when it holds none and "-" when
# the log cannot be read.
kernel_oom() {
  KLOG=$(dmesg 2>/dev/null) || { echo "-"; return; }
  if printf '%s\n' "$KLOG" | grep -qi 'out of memory'; then echo "yes"; else echo "no"; fi
}

# Prints the total restart count of the pm2 processes in the app container ("-" when pm2 cannot be read or lists none).
pm2_restarts() {
  count_or_dash "$(docker exec app sh -c 'pm2 jlist | node -e "
    let s = \"\";
    process.stdin.on(\"data\", (d) => (s += d)).on(\"end\", () => {
      const list = JSON.parse(s.slice(s.indexOf(\"[\")));
      if (!list.length) process.exit(1);
      console.log(list.reduce((n, p) => n + p.pm2_env.restart_time, 0));
    });"' 2>/dev/null || true)"
}

# Prints counter $2 minus counter $1, or "n/a" when either could not be read.
counter_delta() {
  case "$1$2" in *-*) echo "n/a" ;; *) echo $(( $2 - $1 )) ;; esac
}

# Prints the largest memory usage sampled for container $1 in bytes ("-" when a sample has a unit it cannot convert).
sampled_peak() {
  awk -F, -v c="$1" '
    # Converts a docker memory figure with its unit (such as 1.2GiB) to bytes, or -1 for a unit it does not know.
    function bytes(s,   n, u) {
      n = s + 0; u = s; sub(/^[0-9.]+/, "", u)
      if (u == "B") return n
      if (u == "kB" || u == "KB") return n * 1000
      if (u == "KiB") return n * 1024
      if (u == "MB") return n * 1000000
      if (u == "MiB") return n * 1048576
      if (u == "GB") return n * 1000000000
      if (u == "GiB") return n * 1073741824
      return -1
    }
    $2 == c { seen = 1; b = bytes($3); if (b < 0) bad = 1; else if (b > m) m = b }
    END { if (bad || !seen) print "-"; else printf "%d", m }' "$CSV"
}

# Prints a byte count as whole megabytes, or "n/a" when it is "-".
MB() {
  [ "$1" = "-" ] && echo "n/a" || echo "$(( $1 / 1048576 )) MB"
}

case "$(kernel_oom)" in
  -)
    echo "NOT STARTED: the kernel log cannot be read (dmesg failed), so a kernel OOM kill could not be seen."
    echo "Run as root, or: sudo sysctl kernel.dmesg_restrict=0. No sample was taken."
    exit 2 ;;
  yes)
    echo "NOT STARTED: the kernel log already holds an out-of-memory message from before this run, which would"
    echo "fail it after the full soak. Reboot the host, or clear it with: sudo dmesg -C. No sample was taken."
    exit 2 ;;
esac

BASE_PM2=$(pm2_restarts)
for c in $CONTAINERS; do eval "BASE_OOM_$c=$(oom_kills "$c")"; done

echo "time,container,mem_usage,mem_limit,mem_pct,restarts,oom_killed,oom_kill_events" > "$CSV"
while [ "$(date +%s)" -lt "$END" ]; do
  NOW=$(date -Iseconds)
  for c in $CONTAINERS; do
    STATS=$(docker stats --no-stream --format '{{.MemUsage}},{{.MemPerc}}' "$c" | sed 's| / |,|')
    STATE=$(docker inspect --format '{{.RestartCount}},{{.State.OOMKilled}}' "$c")
    echo "$NOW,$c,$STATS,$STATE,$(oom_kills "$c")" >> "$CSV"
  done
  sleep "$SAMPLE_SECONDS"
done

FAIL=0
UNKNOWN=0
{
  echo "# Soak record"
  echo
  echo "- date: $STAMP"
  echo "- tier: $TIER"
  echo "- duration: $(( ($(date +%s) - START) / 60 )) minutes, sampled every ${SAMPLE_SECONDS}s"
  echo "- host: $(uname -srm), $(awk '/MemTotal/ { printf "%d MB RAM", $2 / 1024 }' /proc/meminfo)"
  echo
  echo "| container | limit | peak (cgroup) | peak swap | OOM kills | restarts |"
  echo "|---|---|---|---|---|---|"
} > "$SUMMARY"
for c in $CONTAINERS; do
  STATE=$(docker inspect --format '{{.RestartCount}} {{.State.OOMKilled}} {{.HostConfig.Memory}}' "$c")
  RESTARTS=${STATE%% *}; REST=${STATE#* }; OOMFLAG=${REST%% *}; LIMIT=${REST#* }
  EVENTS=$(counter_delta "$(eval "echo \$BASE_OOM_$c")" "$(oom_kills "$c")")
  PEAK=$(cgroup "$c" memory.peak); SWAP=$(cgroup "$c" memory.swap.peak)
  # peak (cgroup) is "-" on hosts without memory.peak; the sampled maximum is then the best figure
  [ "$PEAK" != "-" ] || PEAK=$(sampled_peak "$c")
  echo "| $c | $(MB "$LIMIT") | $(MB "$PEAK") | $(MB "$SWAP") | $EVENTS | $RESTARTS |" >> "$SUMMARY"
  if [ "$EVENTS" = "n/a" ]; then
    echo "UNKNOWN $c the oom_kill counter could not be read"; UNKNOWN=1
  fi
  if [ "$RESTARTS" != "0" ] || [ "$OOMFLAG" = "true" ] || { [ "$EVENTS" != "n/a" ] && [ "$EVENTS" != "0" ]; }; then
    echo "FAIL $c restarts=$RESTARTS oom_killed=$OOMFLAG oom_kill_events=$EVENTS"; FAIL=1
  fi
done
PM2_NOW=$(pm2_restarts)
PM2_DELTA=$(counter_delta "$BASE_PM2" "$PM2_NOW")
if [ "$PM2_DELTA" = "n/a" ]; then
  echo "UNKNOWN the pm2 restart count in the app container could not be read ($BASE_PM2 -> $PM2_NOW)"; UNKNOWN=1
elif [ "$PM2_DELTA" != "0" ]; then
  echo "FAIL pm2 restarted a process in the app container ($BASE_PM2 -> $PM2_NOW)"; FAIL=1
fi
echo "- pm2 restarts in app during the soak: $PM2_DELTA" >> "$SUMMARY"
case "$(kernel_oom)" in
  yes) echo "FAIL kernel OOM killer fired (see dmesg)"; FAIL=1; KERNEL="an out-of-memory message appeared" ;;
  no) KERNEL="no out-of-memory message" ;;
  *) echo "UNKNOWN the kernel log could not be read at the end of the soak"; UNKNOWN=1; KERNEL="n/a (could not be read)" ;;
esac
echo "- kernel log (dmesg): $KERNEL" >> "$SUMMARY"
if [ "$FAIL" != 0 ]; then
  echo "- result: FAIL" >> "$SUMMARY"
  exit 1
fi
if [ "$UNKNOWN" != 0 ]; then
  echo "UNKNOWN: a counter could not be read, so this run does not show zero OOM kills. Summary: $SUMMARY"
  echo "- result: UNKNOWN (a counter could not be read, so no OOM-kill count was observed)" >> "$SUMMARY"
  exit 2
fi
echo "PASS: $(( ($(date +%s) - START) / 60 )) minute soak, no OOM, no restarts. Summary: $SUMMARY"
echo "- result: PASS" >> "$SUMMARY"
