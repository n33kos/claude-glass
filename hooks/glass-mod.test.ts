// The glass mod against the real Claude Code runtime (`claude plugin test`): the CLI it runs is
// answered from here (process.run), so these check the mod's side alone. The glass's side is
// tested in test/unit (vitest), and both together live (CLAUDE.md, Gotchas).
import { describe, expect, test } from 'claude-code/testing'

const SOCK = '/tmp/claude-glass-test/glass.sock'

/** Answer the mod's CLI calls (by subcommand) and its file checks; returns what it ran. */
function fakeGlass(on: any, replies: Record<string, (stdin: string, argv: readonly string[]) => unknown> = {}) {
  const ran: { cmd: string; argv: readonly string[]; stdin: string }[] = []
  on('process.run', async (_$: any, e: any) => {
    const cmd = String(e.argv[1] ?? '')
    const stdin = String(e.init?.stdin ?? '')
    ran.push({ cmd, argv: e.argv, stdin })
    const out = cmd === 'session-start'
      ? { open: true, guide: 'THE GUIDE', socket: SOCK, toolReminders: true, config: '/tmp/claude-glass-test/config.json', hooks: {} }
      : replies[cmd]?.(stdin, e.argv) ?? {}
    return { value: { exitCode: 0, stdout: JSON.stringify(out) + '\n', stderr: '' } }
  })
  on('fs.exists', async () => ({ value: true }))
  on('fs.read', async () => ({ value: '{}' }))
  // Claude Code's own side of the events the mod passes on (nothing else answers them in a test).
  on('classic.SessionStart', async () => ({}))
  on('classic.PermissionRequest', async () => ({}))
  return ran
}

describe('the glass mod', () => {
  test('a session start binds the glass; the guide goes with the first message', async ($, on) => {
    const ran = fakeGlass(on)
    on('prompt.context', async (_$: any, e: any) => ({ blocks: e.blocks }))
    await $.classic.SessionStart({ source: 'startup' })
    expect(ran.some((r) => r.cmd === 'session-start' && r.argv.includes('startup'))).toBe(true)
    const r = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] })
    expect(r.blocks).toEqual([{ name: 'currentDate', text: 'today' }, { name: 'claudeGlass', text: 'THE GUIDE' }])
  })

  test('tool calls reach the glass in order, as events; shell file I/O gets the reminder', async ($, on) => {
    const ran = fakeGlass(on)
    on('tool.call', async () => ({ result: { stdout: 'x', stderr: '', interrupted: false } }))
    await $.classic.SessionStart({ source: 'startup' })
    const cat: any = await $.tool.call({ tool: 'Bash', command: 'cat src/a.ts' } as any)
    expect(cat.context?.[0]).toMatch(/^Reminder \(Claude Glass is open\)/)
    const git: any = await $.tool.call({ tool: 'Bash', command: 'git status' } as any)
    expect(git.context ?? []).toEqual([])
    const sent = ran.filter((r) => r.cmd === 'event').flatMap((r) => r.stdin.trim().split('\n').map((l) => JSON.parse(l)))
    // (sent in the background, in order; the last batch may still be on its way)
    expect(sent.map((e) => `${e.e}:${e.input?.command}`).slice(0, 2)).toEqual(['tool.start:cat src/a.ts', 'tool.end:cat src/a.ts'])
  })

  test('after /clear (the session ends, a new one starts) events keep reaching the glass', async ($, on) => {
    const ran = fakeGlass(on)
    on('tool.call', async () => ({ result: { stdout: 'x', stderr: '', interrupted: false } }))
    on('session.end', async () => ({ sessionId: 'old' }))
    await $.classic.SessionStart({ source: 'startup' })
    await $.tool.call({ tool: 'Bash', command: 'echo one' } as any)
    await $.session.end({ reason: 'clear' } as any)
    await $.classic.SessionStart({ source: 'clear', session_id: 'after-clear' } as any)
    await $.tool.call({ tool: 'Bash', command: 'echo two' } as any)
    await $.tool.call({ tool: 'Bash', command: 'echo three' } as any)
    const sent = ran.filter((r) => r.cmd === 'event').flatMap((r) => r.stdin.trim().split('\n').map((l) => JSON.parse(l)))
    expect(ran.filter((r) => r.cmd === 'session-start').map((r) => r.argv[r.argv.indexOf('--source') + 1])).toEqual(['startup', 'clear'])
    expect(sent.some((e) => e.e === 'tool.start' && e.input?.command === 'echo two')).toBe(true)
    expect(sent.some((e) => e.e === 'session.end')).toBe(false) // the conversation goes on in the same glass
    // The glass learns which session the new one replaced, so it can follow the conversation.
    const starts = ran.filter((r) => r.cmd === 'session-start')
    expect(starts[0].argv.includes('--previous')).toBe(false)
    const clear = starts[1].argv
    expect(clear[clear.indexOf('--previous') + 1]).toBe(starts[0].argv[starts[0].argv.indexOf('--session') + 1])
  })

  test('a /clear the mod hears nothing about: the next prompt finds the new session id and follows it', async ($, on) => {
    const ran = fakeGlass(on)
    let id = 'before-clear'
    on('session.id', async () => ({ value: id }))
    on('prompt.context', async (_$: any, e: any) => ({ blocks: e.blocks }))
    on('session.end', async () => ({ sessionId: 'before-clear' }))
    await $.classic.SessionStart({ source: 'startup', session_id: 'before-clear' } as any)
    await $.session.end({ reason: 'clear' } as any)
    id = 'after-clear' // no classic SessionStart, no session.start: only the id changed
    const r = await $.prompt.context({ blocks: [] })
    const starts = ran.filter((x) => x.cmd === 'session-start').map((x) => x.argv)
    const arg = (argv: readonly string[], flag: string) => argv[argv.indexOf(flag) + 1]
    expect(starts.map((a) => [arg(a, '--session'), arg(a, '--source')])).toEqual([['before-clear', 'startup'], ['after-clear', 'clear']])
    expect(arg(starts[1], '--previous')).toBe('before-clear')
    expect(r.blocks).toEqual([{ name: 'claudeGlass', text: 'THE GUIDE' }]) // the guide comes with the new conversation's first message
    // A classic SessionStart for the same clear, arriving late, changes nothing.
    await $.classic.SessionStart({ source: 'clear', session_id: 'after-clear' } as any)
    expect(ran.filter((x) => x.cmd === 'session-start').length).toBe(2)
  })

  test('a permission prompt answered in the glass becomes the decision', async ($, on) => {
    const ran = fakeGlass(on, {
      action: (_stdin, argv) => (argv[2] === 'request' ? { id: 'r1', holdMs: 60_000, summary: '$ ls' } : argv[2] === 'wait' ? { status: 'answered', choice: 'allow', by: 'glass' } : { ok: true }),
    })
    await $.classic.SessionStart({ source: 'startup' })
    const r = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [] } as any)
    expect(r).toEqual({ decision: { behavior: 'allow' } })
    expect(ran.filter((x) => x.cmd === 'action').map((x) => x.argv[2])).toEqual(['request', 'wait'])
  })

  test('approvals off in the glass: Claude Code\'s own prompt, untouched', async ($, on) => {
    fakeGlass(on, { action: () => ({ off: 'approvals from the glass are off' }) })
    await $.classic.SessionStart({ source: 'startup' })
    expect(await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } } as any)).toEqual({})
  })

  test('a two-way app the glass says hooks Bash can refuse the call', async ($, on) => {
    fakeGlass(on, {
      event: () => ({ hooks: { 'tool.call': ['Bash'] } }),
      hook: (stdin) => (JSON.parse(stdin).input.command === 'rm -rf build' ? { answer: { deny: 'Guard said no.' } } : { e: JSON.parse(stdin) }),
    })
    on('tool.call', async () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
    await $.classic.SessionStart({ source: 'startup' })
    await $.tool.call({ tool: 'Read', file_path: '/tmp/x' } as any) // an event batch: the glass's reply names the hooked tools
    const r: any = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as any)
    expect(r.deny ?? r.text).toContain('Guard said no.') // a deny, however the caller sees it
  })

  test('any other event an app hooks goes to the glass as Claude Code has it; unhooked ones never do', async ($, on) => {
    const ran = fakeGlass(on, {
      event: () => ({ hooks: { 'attribution.text': ['*'] } }),
      hook: (stdin) => ({ answer: { text: `${JSON.parse(stdin).text} (via the glass)` } }),
    })
    on('tool.call', async () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
    on('attribution.text', async (_$: any, e: any) => ({ text: e.text }))
    on('agent.offer', async (_$: any, e: any) => e)
    await $.classic.SessionStart({ source: 'startup' })
    await $.tool.call({ tool: 'Read', file_path: '/tmp/x' } as any) // the glass's reply names the hooked events
    const r: any = await $.attribution.text({ text: 'Co-Authored-By: Claude' } as any)
    expect(r.text).toBe('Co-Authored-By: Claude (via the glass)')
    expect(ran.filter((x) => x.cmd === 'hook').map((x) => x.argv[2])).toEqual(['attribution.text'])
  })
  test('session controls from an app: the mod runs them (slash commands, the prompt box, a prompt)', async ($, on) => {
    let sent = false
    const ran = fakeGlass(on, { watch: () => (sent ? [] : (sent = true, [
      { kind: 'session', control: 'model', args: { model: 'sonnet' }, app: 'review' },
      { kind: 'session', control: 'compact', args: { instructions: 'keep the plan' }, app: 'review' },
      { kind: 'session', control: 'command', args: { command: 'cost', args: '' }, app: 'review' },
      { kind: 'session', control: 'fill', args: { text: 'draft' }, app: 'review' },
      { kind: 'session', control: 'prompt', args: { text: 'review done: fix it' }, app: 'review' },
    ])) })
    const commands: string[] = []
    const filled: string[] = []
    const submitted: string[] = []
    on('command.run', async (_$: any, e: any) => { commands.push(`/${e.command} ${e.args}`.trim()); return { text: '' } })
    on('prompt.fill', async (_$: any, e: any) => { filled.push(e.text); return { isFilled: true } })
    on('prompt.submit', async (_$: any, e: any) => { submitted.push(e.text); return { text: e.text } })
    on('session.id', async () => ({ value: 'controls' }))
    on('session.start', async () => ({ cwd: '/tmp/controls' }))
    await $.session.start({ cwd: '/tmp/controls' } as any) // the controls loop starts with the mod
    for (let i = 0; i < 50 && !submitted.length; i++) await new Promise((r) => setTimeout(r, 20))
    expect(ran.some((r) => r.cmd === 'watch')).toBe(true)
    expect(commands).toEqual(['/model sonnet', '/compact keep the plan', '/cost'])
    expect(filled).toEqual(['draft'])
    expect(submitted).toEqual(['review done: fix it'])
  })
})
