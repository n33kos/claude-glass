// Example mod core: pure functions over this app's own state.
exports.init = () => ({ counts: {}, note: '', sort: 'count' });

exports.command = (state, cmd, args) => {
  if (cmd === 'note') return { ...state, note: String(args.text ?? '') };
  if (cmd === 'sort') return { ...state, sort: args.by === 'name' ? 'name' : 'count' };
  throw new Error(`tool-count: unknown command "${cmd}"`);
};

exports.onEvent = (state, ev) => {
  if (ev.e !== 'tool.start' || !ev.tool) return state;
  return { ...state, counts: { ...state.counts, [ev.tool]: (state.counts[ev.tool] ?? 0) + 1 } };
};
