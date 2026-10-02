// The event-driven apps (tasks, agents, tests, files) and diagram validation.
// Event shapes are what the glass mod sends (src/core/events.ts); test/fixtures/mod-events.ndjson
// is a real recorded session.
import { describe, expect, it } from 'vitest';
import { agents } from '../../src/apps/agents';
import { diagram } from '../../src/apps/diagram';
import { files } from '../../src/apps/files';
import { tasks } from '../../src/apps/tasks';
import { detectRunner, parseResults, tests } from '../../src/apps/tests';

const post = (tool: string, input: object, result: object, extra: object = {}) =>
  ({ e: 'tool.end', tool, input, result, id: `t-${Math.random()}`, ...extra });
const feed = <S>(app: { init(): S; onEvent?(s: S, ev: any): S }, events: any[]): S => events.reduce((s: S, ev) => app.onEvent!(s, ev), app.init());

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
    s = tasks.onEvent!(s, post('TodoWrite', { todos: [{ content: 'X', status: 'in_progress', activeForm: 'Doing X' }] }, {}));
    expect(s.items).toMatchObject([{ subject: 'X', status: 'in_progress', activeForm: 'Doing X' }]);
  });
});

describe('agents', () => {
  it('tracks a background agent from its call to the end of its own turn', () => {
    const input = { description: 'Reply with hi only', prompt: 'Reply with the word hi and nothing else.', subagent_type: 'general-purpose' };
    const s = feed(agents, [
      { e: 'tool.start', tool: 'Agent', input, id: 'call1' },
      { e: 'tool.start', tool: 'Bash', input: { command: 'ls' }, id: 'sub1', agentId: 'a193' }, // the agent's own work
      { e: 'tool.end', tool: 'Agent', input, id: 'call1', result: { isAsync: true, status: 'async_launched', agentId: 'a193' } },
    ]);
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ status: 'running', background: true, agentId: 'a193', type: 'general-purpose' });
    const done = agents.onEvent!(s, { e: 'agent.end', agentId: 'a193', answer: 'hi' });
    expect(done.runs[0]).toMatchObject({ status: 'done', result: 'hi' });
  });
  it('a foreground agent is done when its call returns; a failed call fails it', () => {
    const s = feed(agents, [
      { e: 'tool.start', tool: 'Agent', input: { description: 'Look', prompt: 'p' }, id: 'c2' },
      { e: 'tool.end', tool: 'Agent', input: {}, id: 'c2', result: { content: [{ type: 'text', text: 'Found it.' }] } },
    ]);
    expect(s.runs[0]).toMatchObject({ status: 'done', result: 'Found it.' });
    const failed = feed(agents, [
      { e: 'tool.start', tool: 'Agent', input: { description: 'Look', prompt: 'p' }, id: 'c3' },
      { e: 'tool.end', tool: 'Agent', input: {}, id: 'c3', error: 'Interrupted' },
    ]);
    expect(failed.runs[0]).toMatchObject({ status: 'failed', result: 'Interrupted' });
  });
});

describe('tests', () => {
  it('a test command that started is running until its result comes in', () => {
    const start = { e: 'tool.start', tool: 'Bash', input: { command: 'npx vitest run' }, id: 'r1' };
    let s = feed(tests, [start]);
    expect(s.running).toMatchObject({ command: 'npx vitest run', runner: 'vitest', id: 'r1' });
    expect(s.runs).toHaveLength(0);
    s = tests.onEvent!(s, post('Bash', { command: 'npx vitest run' }, { stdout: 'Tests  1 failed | 3 passed (4)' }));
    expect(s.running).toBeUndefined();
    expect(s.runs[0]).toMatchObject({ passed: 3, failed: 1, ok: false });
    expect(feed(tests, [{ ...start, input: { command: 'ls' } }]).running).toBeUndefined(); // not a test command
  });
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
  it('records a run from a Bash call', () => {
    const s = tests.onEvent!(tests.init(), post('Bash', { command: 'npm test' }, { stdout: '      Tests  5 passed (5)', stderr: '' }, { durationMs: 1200 }));
    expect(s.runs[0]).toMatchObject({ ok: true, passed: 5, runner: 'npm' });
    expect(tests.onEvent!(tests.init(), post('Bash', { command: 'ls' }, { stdout: '' }))).toEqual(tests.init());
  });
});

describe('files', () => {
  it('counts reads and edits relative to the project', () => {
    const s = feed(files, [
      post('Read', { file_path: '/p/src/a.ts' }, {}, { cwd: '/p' }),
      post('Edit', { file_path: '/p/src/b.ts' }, {}, { cwd: '/p' }),
      post('Edit', { file_path: '/p/src/a.ts' }, {}, { cwd: '/p' }),
      post('Read', { file_path: '/p/README.md' }, {}, { cwd: '/p' }),
    ]);
    expect(s.files['src/a.ts']).toMatchObject({ reads: 1, edits: 1 });
    expect(s.files['src/b.ts']).toMatchObject({ edits: 1 });
    expect(s.files['README.md']).toMatchObject({ reads: 1, edits: 0 });
  });
  it('only list and tree views; a glass saved with the map view goes back to the list', () => {
    expect(() => files.command(files.init(), 'view', { mode: 'map' })).toThrow(/list\|tree/);
    const old = { files: {}, links: { x: 1 }, view: 'map' } as any;
    const s = files.onEvent!(old, { e: 'tool.end', tool: 'Read', input: { file_path: '/p/a.ts' }, id: 'r', cwd: '/p' }) as any;
    expect(s.view).toBeUndefined();
    expect(s.links).toBeUndefined();
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
