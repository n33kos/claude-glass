// Example two-way app: hooks on the Claude session, like a Claude Code mod's register(on).
exports.init = () => ({});
exports.command = (state, cmd) => { throw new Error(`guard: unknown command "${cmd}"`); };

exports.register = (on) => {
  // Refuse a dangerous command outright; ask the user (in the glass) before a deploy.
  on('tool.call', { tool: 'Bash' }, async (glass, e, next) => {
    const cmd = String(e.input.command ?? '');
    if (/rm -rf \/(\s|$)/.test(cmd)) {
      glass.store({ refused: glass.stored.refused + 1 });
      return { deny: 'Guard: not deleting the root folder.' };
    }
    if (/\bdeploy\b/.test(cmd)) {
      const answer = await glass.ask(`Run "${cmd}"?`, ['Yes, deploy', 'No']);
      if (answer !== 'Yes, deploy') return { deny: `Guard: the user said "${answer}".` };
    }
    return next(e);
  });
  // Every prompt carries a line for Claude.
  on('prompt.submit', async (glass, e, next) => next({ ...e, context: [...e.context, 'Guard is watching this session.'] }));
};
