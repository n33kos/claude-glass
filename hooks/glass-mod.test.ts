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
    // The glass learns which session the new one replaced, so it can follow the conversation.
    const starts = ran.filter((r) => r.cmd === 'session-start')
    expect(starts[0].argv.includes('--previous')).toBe(false)
    const clear = starts[1].argv
    expect(clear[clear.indexOf('--previous') + 1]).toBe(starts[0].argv[starts[0].argv.indexOf('--session') + 1])
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
})
