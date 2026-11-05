#!/bin/sh
# Claude Code statusLine wrapper.
# Saves rate_limits for the Herdr usage-weed mod, then hands stdin to Orca's hook.
dir="${XDG_STATE_HOME:-$HOME/.local/state}/herdr-usage"
payload=$(cat)
case "$payload" in
  *'"rate_limits"'*)
    if [ -z "${CLAUDE_JOB_DIR-}" ] && command -v jq >/dev/null 2>&1; then
      mkdir -p "$dir"
      now=$(date +%s)
      last=$(cat "$dir/.last" 2>/dev/null || echo 0)
      case "$last" in ''|*[!0-9]*) last=0 ;; esac
      if [ $((now - last)) -ge 15 ]; then
        tmp="$dir/claude.json.$$"
        if printf '%s' "$payload" | jq -c --argjson at "$now" \
          '{at: $at, fiveHour: .rate_limits.five_hour, sevenDay: .rate_limits.seven_day}' \
          > "$tmp" 2>/dev/null; then
          mv "$tmp" "$dir/claude.json"
          echo "$now" > "$dir/.last"
        else
          rm -f "$tmp"
        fi
      fi
    fi
    ;;
esac
orca="$HOME/.orca/agent-hooks/claude-statusline.sh"
if [ -f "$orca" ] && [ -r "$orca" ]; then
  printf '%s' "$payload" | /bin/sh "$orca"
fi
exit 0
