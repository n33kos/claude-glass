#!/usr/bin/env bash
# Forward a Claude Code hook payload (stdin) to this session's glass socket.
# Off means off: if no glass socket exists for the session, exit immediately.
# Runs as an async hook; never blocks Claude.
line=$(jq -c '{op:"hook",payload:.}' 2>/dev/null) || exit 0
sid=$(jq -r '.payload.session_id // empty' <<<"$line")
[ -n "$sid" ] || exit 0
case "$sid" in *[!A-Za-z0-9._-]*) exit 0 ;; esac
sock="${CLAUDE_GLASS_RUNTIME:-/tmp/claude-glass-$(id -u)}/$sid.sock"
[ -S "$sock" ] || exit 0
printf '%s\n' "$line" | nc -U -w 2 "$sock" >/dev/null 2>&1
exit 0
