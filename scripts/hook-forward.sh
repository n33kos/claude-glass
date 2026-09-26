#!/usr/bin/env bash
# Forward a Claude Code hook payload (stdin) to this session's canvas socket.
# Off means off: if no canvas socket exists for the session, exit immediately.
# Runs as an async hook; never blocks Claude.
line=$(jq -c '{op:"hook",payload:.}' 2>/dev/null) || exit 0
sid=$(jq -r '.payload.session_id // empty' <<<"$line")
[ -n "$sid" ] || exit 0
case "$sid" in *[!A-Za-z0-9._-]*) exit 0 ;; esac
sock="${CLAUDE_CANVAS_RUNTIME:-/tmp/claude-canvas-$(id -u)}/$sid.sock"
[ -S "$sock" ] || exit 0
printf '%s\n' "$line" | nc -U -w 2 "$sock" >/dev/null 2>&1
exit 0
