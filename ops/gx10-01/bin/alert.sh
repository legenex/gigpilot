#!/usr/bin/env bash
# gigpilot-alert@<unit>: invoked via OnFailure= to record a failed GigPilot unit.
RT=/srv/projects/gigpilot
msg="systemd unit ${1:-unknown} failed"
echo "$(date -u +%FT%TZ) ALERT $msg" >> "$RT/status/alerts.log"
logger -t gigpilot-alert -p user.err "ALERT $msg" 2>/dev/null || true
