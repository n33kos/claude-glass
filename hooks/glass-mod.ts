// The Claude Glass mod: Claude Code loads it in every session (hooks/hooks.json) and it feeds this
// session's glass. It watches the session's events and hands them to the glass the same way a
// person or Claude drives it: the `claude-glass` CLI, over the glass's Unix socket. No server.
//
// - Events go out in order, in batches: one `claude-glass event` at a time, carrying everything
//   queued since the last one. Streamed text replaces its own queued copy, so a slow glass gets
//   the latest text, not every step of it.
// - Nothing here waits on the glass except the session start: with no glass open the CLI isn't
//   even run, and a glass that's slow or gone never holds Claude up.
// - The glass's own types live in src/core/events.ts (GlassEvent); keep the two in step.

type Ev = Record<string, unknown> & { e: string }

let cid = '' // the Claude session id (changes after /clear)
let cwd = ''
let sock = '' // this session's glass socket (or the link to a folder glass)
let guide: string | null = null
let toolReminders = true
let queue: Ev[] = []
let sending = false

const bin = ($: any) => `${$.plugin.root}/bin/claude-glass`

function send($: any, ev: Ev) {
  if (!cid) return
  if (ev.e === 'text') {
    const i = queue.findIndex((q) => q.e === 'text' && q.id === ev.id)
    if (i !== -1) { queue[i] = ev; return }
  }
  queue.push(ev)
  void flush($)
}

async function flush($: any) {
  if (sending) return
  sending = true
  try {
    while (queue.length) {
      const batch = queue
      queue = []
      if (!sock || !(await $.fs.exists(sock))) continue // no glass: off means off
      const stdin = batch.map((x) => JSON.stringify(x)).join('\n') + '\n'
      await $.process.run([bin($), 'event', '--session', cid], { stdin, timeoutMs: 5000 }).catch(() => {})
    }
  } finally {
    sending = false
  }
}

/** Bind the session to its glass (opening it on autoStart) and learn what the hooks need. */
async function sessionStart($: any, source: string) {
  try {
    const r = await $.process.run([bin($), 'session-start', '--session', cid, '--source', source, '--cwd', cwd], { timeoutMs: 30000 })
    const info = JSON.parse(String(r.stdout).trim().split('\n').pop() || '{}')
    sock = typeof info.socket === 'string' ? info.socket : ''
    guide = typeof info.guide === 'string' ? info.guide : null
    toolReminders = info.toolReminders !== false
  } catch {
    // Not built yet (the first CLI command builds it), or something broke: the session goes on.
  }
}

// Shell commands that read or change file contents, which the glass can't show (the user sees
// Read, Edit and Write). Plain `grep -n` and piping a command's output through head/tail are fine.
const FILE_IO = /(^|[;&(]|\|\|)\s*(cat|head|tail|less|more|awk|sed|nl|bat)\s|sed\s+-i|grep[^|;&]*\s-[A-Za-z]*[ABC]|<<\s*-?['"]?[A-Za-z_]+|(python3?|node|ruby|perl)\s+(-c|-e)\s|[^0-9&>]>>?\s*[A-Za-z./~][^\s;&|]*\.[A-Za-z]+/
const REMINDER = 'Reminder (Claude Glass is open): that Bash command read or changed file contents through the shell, which the user cannot see in their glass. Read files with the Read tool (grep -n to find the line, then Read with offset/limit) and change them with Edit/Write. Keep Bash for running commands: build, test, git, the claude-glass CLI. See the "Work visibly" part of the Claude Glass guide (claude-glass help).'

/** A tool's record, minus what the glass never uses: an image Read's bytes (the glass copies the file). */
function slim(result: any): unknown {
  if (result?.type === 'image' && result.file?.base64) return { ...result, file: { ...result.file, base64: undefined } }
  return result
}

function errorOf(r: any): string | undefined {
  if (r?.deny !== undefined) return String(r.deny)
  if (r?.isError) return String(r.text ?? r.result ?? 'failed')
  return undefined
}

export function register(on: any) {
  // Every start of a conversation: startup, /clear (a new session id), resume, compact.
  on('classic.SessionStart', async ($: any, e: any, next: any) => {
    cid = String(e.session_id ?? '')
    cwd = String(e.cwd ?? cwd)
    if (cid) await sessionStart($, String(e.source ?? 'startup'))
    return next(e)
  })

  // Once per load of this module, including a hot reload, which starts it with nothing known.
  on('session.start', async ($: any, e: any, next: any) => {
    if (!cid) {
      cid = String(await $.session.id())
      cwd = String(e.cwd ?? (await $.session.cwd()))
      await sessionStart($, 'reload')
    }
    return next(e)
  })

  // The guide, with the first message of each conversation, while a glass is open.
  on('prompt.context', async ($: any, e: any, next: any) => {
    const r = await next(e)
    if (!guide || !sock || !(await $.fs.exists(sock))) return r
    return { ...r, blocks: [...r.blocks, { name: 'claudeGlass', text: guide }] }
  })

  on('turn.start', async ($: any, e: any, next: any) => {
    send($, { e: 'turn.start', turnId: e.turnId, text: e.text })
    return next(e)
  })

  // The reply streams into the conversation: the text so far of each text block.
  on('turn.step', async function* ($: any, e: any, next: any) {
    if (e.agentId) return yield* next(e) // a subagent's reasoning isn't the conversation
    send($, { e: 'step', turnId: e.turnId, index: e.index })
    const texts = new Map<number, string>()
    const id = (index: number) => `${e.turnId}:${e.index}:${index}`
    const stream = next(e)
    let r = await stream.next()
    while (!r.done) {
      const c = r.value
      if (c?.kind === 'text') {
        const text = (texts.get(c.index) ?? '') + c.text
        texts.set(c.index, text)
        send($, { e: 'text', id: id(c.index), turnId: e.turnId, text })
      }
      yield c
      r = await stream.next()
    }
    for (const [index, text] of texts) send($, { e: 'text', id: id(index), turnId: e.turnId, text, final: true })
    return r.value
  })

  on('turn.complete', async ($: any, e: any, next: any) => {
    if (e.agentId) send($, { e: 'agent.end', agentId: e.agentId, answer: e.answer, aborted: e.isAborted })
    else send($, { e: 'turn.complete', turnId: e.turnId, durationMs: e.durationMs, reason: e.reason, aborted: e.isAborted })
    return next(e)
  })

  on('tool.call', async ($: any, e: any, next: any) => {
    const { tool, tool_use_id: id, agentId, ...input } = e
    const at = Date.now()
    send($, { e: 'tool.start', id, tool, input, agentId, cwd })
    const r = await next(e)
    const error = errorOf(r)
    send($, { e: 'tool.end', id, tool, input, result: error ? undefined : slim(r?.result), error, durationMs: Date.now() - at, agentId, cwd })
    if (tool === 'Bash' && !error && toolReminders && !agentId && sock && FILE_IO.test(String(input.command ?? ''))
      && !/^\s*git\s|claude-glass\s/.test(String(input.command)) && (await $.fs.exists(sock))) {
      return { ...r, context: [...(r.context ?? []), REMINDER] }
    }
    return r
  })

  // Context window use, cost and plan limits, measured after each turn.
  on('session.measure', async ($: any, e: any, next: any) => {
    send($, { e: 'usage', context: e.context, cost: e.cost, rateLimits: e.rateLimits })
    return next(e)
  })

  // Claude Code is showing a permission prompt: the glass says it's waiting on the user.
  on('classic.PermissionRequest', async ($: any, e: any, next: any) => {
    send($, { e: 'permission', tool: e.tool_name, input: e.tool_input })
    return next(e)
  })

  on('session.end', async ($: any, e: any, next: any) => {
    send($, { e: 'session.end', reason: e.reason })
    return next(e)
  })
}
