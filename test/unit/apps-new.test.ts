// The hook-driven prototype apps (tasks, agents, tests, files) and diagram validation.
// Payload shapes are real captures from a Claude Code run (TaskCreate/TaskUpdate, Agent, Subagent*).
import { describe, expect, it } from 'vitest';
import { agents } from '../../src/apps/agents';
import { diagram } from '../../src/apps/diagram';
import { files } from '../../src/apps/files';
import { tasks } from '../../src/apps/tasks';
import { detectRunner, parseResults, tests } from '../../src/apps/tests';

const post = (tool_name: string, tool_input: object, tool_response: object, extra: object = {}) =>
  ({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response, tool_use_id: `t-${Math.random()}`, ...extra });
const feed = <S>(app: { init(): S; onHook?(s: S, p: any): S }, payloads: any[]): S => payloads.reduce((s: S, p) => app.onHook!(s, p), app.init());

describe('tasks', () => {
  it('builds the list from TaskCreate/TaskUpdate', () => {
    const s = feed(tasks, [
      post('TaskCreate', { subject: 'Write a haiku', description: 'Write a haiku' }, { task: { id: '1', subject: 'Write a haiku' } }),
      post('TaskCreate', { subject: 'Count to three', description: 'Count to three' }, { task: { id: '2', subject: 'Count to three' } }),
      post('TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true, taskId: '1' }),
      post('TaskUpdate', { taskId: '1', status: 'completed' }, { success: true, taskId: '1' }),
    ]);
    expect(s.items.map((t) => [t.id, t.status])).toEqual([['1', 'completed'], ['2', 'pending']]);
  });
  it('a new list after a finished one starts over; TodoWrite replaces the list', () => {
    let s = feed(tasks, [
      post('TaskCreate', { subject: 'A' }, { task: { id: '1' } }),
      post('TaskUpdate', { taskId: '1', status: 'completed' }, {}),
      post('TaskCreate', { subject: 'B' }, { task: { id: '2' } }),
    ]);
    expect(s.items.map((t) => t.subject)).toEqual(['B']);
    s = tasks.onHook!(s, post('TodoWrite', { todos: [{ content: 'X', status: 'in_progress', activeForm: 'Doing X' }] }, {}));
    expect(s.items).toMatchObject([{ subject: 'X', status: 'in_progress', activeForm: 'Doing X' }]);
  });
});

describe('agents', () => {
  it('tracks a background agent from its call through SubagentStart/Stop', () => {
    const input = { description: 'Reply with hi only', prompt: 'Reply with the word hi and nothing else.', subagent_type: 'general-purpose' };
    const s = feed(agents, [
      { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: input, tool_use_id: 'call1' },
      { hook_event_name: 'SubagentStart', agent_id: 'a193', agent_type: 'general-purpose' },
      { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: input, tool_use_id: 'call1', tool_response: { isAsync: true, status: 'async_launched', agentId: 'a193' } },
    ]);
    expect(s.runs[0]).toMatchObject({ status: 'running', background: true, agentId: 'a193', type: 'general-purpose' });
    const done = agents.onHook!(s, { hook_event_name: 'SubagentStop', agent_id: 'a193', last_assistant_message: 'hi' });
    expect(done.runs[0]).toMatchObject({ status: 'done', result: 'hi' });
  });
  it('a foreground agent is done when its call returns', () => {
    const s = feed(agents, [
      { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'Look', prompt: 'p' }, tool_use_id: 'c2' },
      { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: {}, tool_use_id: 'c2', tool_response: { content: [{ type: 'text', text: 'Found it.' }] } },
    ]);
    expect(s.runs[0]).toMatchObject({ status: 'done', result: 'Found it.' });
  });
});

describe('tests', () => {
  it('recognizes test commands, not others', () => {
    expect(detectRunner('npm test -- --reporter=dot')).toBe('npm');
    expect(detectRunner('npx vitest run 2>&1 | tail')).toBe('vitest');
    expect(detectRunner('python -m pytest -q')).toBe('pytest');
    expect(detectRunner('go test ./...')).toBe('go');
    expect(detectRunner('git log --oneline')).toBeNull();
  });
  it('reads counts and failures from the common runners', () => {
    expect(parseResults(' Test Files  2 passed (2)\n      Tests  1 failed | 67 passed (68)\n FAIL  test/a.test.ts > adds')).toMatchObject({ passed: 67, failed: 1, failures: ['test/a.test.ts > adds'] });
    expect(parseResults('Tests:       1 failed, 26 passed, 27 total')).toMatchObject({ passed: 26, failed: 1 });
    expect(parseResults('FAILED tests/test_x.py::test_a - assert\n==== 1 failed, 10 passed, 2 skipped in 1.20s ====')).toMatchObject({ passed: 10, failed: 1, skipped: 2, failures: ['tests/test_x.py::test_a'] });
    expect(parseResults('test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured')).toMatchObject({ passed: 12, failed: 0, skipped: 1 });
    expect(parseResults('--- FAIL: TestParse (0.00s)\nFAIL\tgithub.com/x/y\t0.2s\nok  \tgithub.com/x/z\t0.1s')).toMatchObject({ failed: 1, failures: ['TestParse'] });
  });
  it('records a run from a Bash hook', () => {
    const s = tests.onHook!(tests.init(), post('Bash', { command: 'npm test' }, { stdout: '      Tests  5 passed (5)', stderr: '' }, { duration_ms: 1200 }));
    expect(s.runs[0]).toMatchObject({ ok: true, passed: 5, runner: 'npm' });
    expect(tests.onHook!(tests.init(), post('Bash', { command: 'ls' }, { stdout: '' }))).toEqual(tests.init());
  });
});

describe('files', () => {
  it('counts reads and edits relative to the project, and links files touched for the same prompt', () => {
    const s = feed(files, [
      post('Read', { file_path: '/p/src/a.ts' }, {}, { cwd: '/p', prompt_id: 'q1' }),
      post('Edit', { file_path: '/p/src/b.ts' }, {}, { cwd: '/p', prompt_id: 'q1' }),
      post('Edit', { file_path: '/p/src/a.ts' }, {}, { cwd: '/p', prompt_id: 'q1' }),
      post('Read', { file_path: '/p/README.md' }, {}, { cwd: '/p', prompt_id: 'q2' }),
    ]);
    expect(s.files['src/a.ts']).toMatchObject({ reads: 1, edits: 1 });
    expect(s.files['src/b.ts']).toMatchObject({ edits: 1 });
    expect(s.links[['src/a.ts', 'src/b.ts'].sort().join('\u0000')]).toBe(1);
    expect(Object.keys(s.links)).toHaveLength(1); // README was another prompt
  });
});

describe('diagram', () => {
  it('validates the template and its data', () => {
    const s = diagram.command(diagram.init(), 'show', { template: 'flow', data: '{"steps":["Parse","Plan"]}', title: 'Pipeline' });
    expect(s).toMatchObject({ template: 'flow', title: 'Pipeline', data: { steps: ['Parse', 'Plan'] } });
    expect(() => diagram.command(diagram.init(), 'show', { template: 'pie', data: '{}' })).toThrow(/unknown template/);
    expect(() => diagram.command(diagram.init(), 'show', { template: 'flow', data: '{nope' })).toThrow(/valid JSON/);
    expect(() => diagram.command(diagram.init(), 'show', { template: 'sequence', data: '{}' })).toThrow(/needs "messages"/);
  });
});
