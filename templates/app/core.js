// Pure functions over this app's own state. No I/O, no globals: same input → same output.
// Runs in the glass's main process (plain Node). State is saved with the session.

/** Initial state for a new window. */
exports.init = () => ({ text: '', updatedAt: 0 });

/** Commands from Claude (`claude-glass app __TYPE__ <command> --key value`) or your view. */
exports.command = (state, command, args) => {
  switch (command) {
    case 'set': return { text: String(args.text ?? ''), updatedAt: Date.now() };
    case 'clear': return exports.init();
    default: throw new Error(`__TYPE__: unknown command "${command}"`);
  }
};

/**
 * Optional: every Claude Code hook payload (see Claude Code's hooks docs). Return the same state
 * object when nothing changes. Delete this if your app is only driven by commands.
 */
exports.onHook = (state, payload) => state;
