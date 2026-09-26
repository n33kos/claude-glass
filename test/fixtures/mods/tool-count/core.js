// Example mod core: pure functions over this app's own state.
exports.init = () => ({ counts: {}, note: '', sort: 'count' });

exports.command = (state, cmd, args) => {
  if (cmd === 'note') return { ...state, note: String(args.text ?? '') };
  if (cmd === 'sort') return { ...state, sort: args.by === 'name' ? 'name' : 'count' };
  throw new Error(`tool-count: unknown command "${cmd}"`);
};

exports.onHook = (state, p) => {
  if (p.hook_event_name !== 'PreToolUse' || !p.tool_name) return state;
  return { ...state, counts: { ...state.counts, [p.tool_name]: (state.counts[p.tool_name] ?? 0) + 1 } };
};
