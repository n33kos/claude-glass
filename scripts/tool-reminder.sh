#!/usr/bin/env bash
# PostToolUse (Bash): when this session's glass is open and the command read or changed file
# contents through the shell (cat, sed, head, heredocs, python...), remind Claude to use Read and
# Edit/Write, which the glass can show. A reminder only: never blocks, never touches the command.
# Off when no glass is open, or with the global setting toolReminders=false.
input=$(cat) || exit 0
sid=$(jq -r '.session_id // empty' <<<"$input" 2>/dev/null)
[ -n "$sid" ] || exit 0
case "$sid" in *[!A-Za-z0-9._-]*) exit 0 ;; esac
[ -S "${CLAUDE_GLASS_RUNTIME:-/tmp/claude-glass-$(id -u)}/$sid.sock" ] || exit 0
config="${CLAUDE_GLASS_HOME:-$HOME/.claude/claude-glass}/config.json"
[ "$(jq -r '.toolReminders' "$config" 2>/dev/null)" = "false" ] && exit 0

cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
case "$cmd" in git\ *|*claude-glass\ *) exit 0 ;; esac # messages and --text args are prose, not file I/O
# File reads/writes through the shell. Plain `grep -n` (finding a line) and piping a command's
# output through head/tail are fine; context dumps and reading files directly aren't.
re='(^|[;&(]|\|\|)[[:space:]]*(cat|head|tail|less|more|awk|sed|nl|bat)[[:space:]]|sed[[:space:]]+-i|grep[^|;&]*[[:space:]]-[A-Za-z]*[ABC]|<<[[:space:]]*-?[\x27"]?[A-Za-z_]+|(python3?|node|ruby|perl)[[:space:]]+(-c|-e)[[:space:]]|[^0-9&>]>>?[[:space:]]*[A-Za-z./~][^[:space:];&|]*\.[A-Za-z]+'
grep -Eq -- "$re" <<<"$cmd" || exit 0

jq -n '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext:
  "Reminder (Claude Glass is open): that Bash command read or changed file contents through the shell, which the user cannot see in their glass. Read files with the Read tool (grep -n to find the line, then Read with offset/limit) and change them with Edit/Write. Keep Bash for running commands: build, test, git, the claude-glass CLI. See the \"Work visibly\" part of the Claude Glass guide (claude-glass help)."}}'
exit 0
