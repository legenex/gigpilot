#!/usr/bin/env bash
# gigpilot-ts-proxy: expose a loopback-published GigPilot port on the host's
# Tailscale IPv4. Docker keeps services on 127.0.0.1 (boot-safe); this waits
# for Tailscale to come up, then forwards <tailscale-ip>:<port> → 127.0.0.1:<port>.
set -euo pipefail
PORT="${1:?usage: ts-proxy.sh <port>}"
case "$PORT" in 4710|4711) ;; *) echo "gigpilot-ts-proxy: refusing non-GigPilot port $PORT" >&2; exit 2 ;; esac

IP=""
for _ in $(seq 1 90); do
  IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
  if [[ "$IP" == 100.* ]] && ip -4 addr show 2>/dev/null | grep -q "inet ${IP}/"; then
    break
  fi
  IP=""
  sleep 2
done
if [[ -z "$IP" ]]; then
  echo "gigpilot-ts-proxy: no Tailscale IPv4 after waiting; systemd will retry" >&2
  exit 1
fi
echo "gigpilot-ts-proxy: ${IP}:${PORT} -> 127.0.0.1:${PORT}"
exec socat TCP-LISTEN:"${PORT}",bind="${IP}",fork,reuseaddr,backlog=256 TCP:127.0.0.1:"${PORT}"
