// Example app core: pure functions over this app's own state. Persistent values (manifest
// "stored") come in ctx.stored; ctx.store(nextState, { key: value }) writes them.
exports.init = () => ({ counts: {}, note: '', sort: 'count' });

exports.command = (state, cmd, args, ctx) => {
  if (cmd === 'note') return ctx.store({ ...state, note: String(args.text ?? '') }, { lastNote: String(args.text ?? '') });
  if (cmd === 'sort') return { ...state, sort: args.by === 'name' ? 'name' : 'count' };
  if (cmd === 'pin') {
    const tool = String(args.tool ?? '');
    if (!tool) throw new Error('tool-count: pin --tool <name>');
    const pinned = ctx.stored.pinned.includes(tool) ? ctx.stored.pinned : [...ctx.stored.pinned, tool];
    return ctx.store(state, { pinned });
  }
  throw new Error(`tool-count: unknown command "${cmd}"`);
};

exports.onEvent = (state, ev, ctx) => {
  if (ev.e !== 'tool.start' || !ev.tool) return state;
  const next = { ...state, counts: { ...state.counts, [ev.tool]: (state.counts[ev.tool] ?? 0) + 1 } };
  return ctx.store(next, { total: ctx.stored.total + 1 }); // every tool call, in every glass
};
