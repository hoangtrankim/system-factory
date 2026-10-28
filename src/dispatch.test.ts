import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Check, CodeHost, PullRequest } from './codehost.js';
import { Dispatcher, Lock } from './dispatch.js';
import { Factory } from './factory.js';
import { specStatus, type Ticket } from './lifecycle.js';
import { JsonlLog } from './logs.js';
import { route, waitingOnOwner, type Snapshot } from './router.js';
import { parseResult, type AgentRunner, type RunRequest } from './runner.js';
import { MemoryTracker } from './tracker/memory.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 10, title: 't', body: '', type: 'build', state: 'planned', priority: 2, round: 0, risky: false,
    testsReady: false, gates: {}, components: [], blockedBy: [], covers: ['AC-1'], spec: 1, closed: false, ...over,
  };
}

const spec = (over: Partial<Ticket> = {}) => ticket({ id: 1, type: 'spec', state: 'spec', body: '- AC-1: x', covers: [], spec: undefined, ...over });

function snap(tickets: Ticket[], over: Partial<Snapshot> = {}): Snapshot {
  const specs = tickets.filter((t) => t.type === 'spec' && !t.closed).map((s) => ({ spec: s, status: specStatus(s, tickets) }));
  return { tickets, specs, prs: new Map(), reported: new Map(), ...over };
}

describe('route', () => {
  it('splits an uncovered spec before anything else', () => {
    expect(route(snap([spec(), ticket({ id: 2, covers: ['AC-9'] })]))).toMatchObject({ agent: 'planner', ticket: 1, rule: 'split-spec' });
  });

  it('sends each state to its agent', () => {
    const cases: Array<[Partial<Ticket>, string]> = [
      [{ state: 'planned' }, 'designer'],
      [{ state: 'designed' }, 'qa-writer'],
      [{ state: 'designed', testsReady: true }, 'builder'],
      [{ state: 'building', round: 1 }, 'builder'],
      [{ state: 'in-review', pr: 5 }, 'reviewer'],
      [{ state: 'in-review', pr: 5, risky: true }, 'security'],
      [{ state: 'in-review', pr: 5, risky: true, gates: { security: 'pass' } }, 'reviewer'],
    ];
    for (const [over, agent] of cases) {
      expect(route(snap([spec(), ticket(over)])), JSON.stringify(over)).toMatchObject({ agent, ticket: 10 });
    }
  });

  it('finishes work before starting new work, and respects blockers and priority', () => {
    const tickets = [spec(), ticket({ id: 2, state: 'planned', priority: 0 }), ticket({ id: 3, state: 'in-review', pr: 7 })];
    expect(route(snap(tickets))).toMatchObject({ agent: 'reviewer', ticket: 3 });
    const blocked = [spec(), ticket({ id: 4, state: 'designed', testsReady: true, blockedBy: [5] }), ticket({ id: 5, state: 'in-qa', pr: 8 })];
    expect(route(snap(blocked))).toBeUndefined();
  });

  it('reports QA once per head SHA, then marks a merged PR done', () => {
    const t = ticket({ state: 'in-qa', pr: 5, reviewedSha: 'abc' });
    const prs = new Map([[10, { headSha: 'abc', merged: false, checksDone: true }]]);
    expect(route(snap([spec(), t], { prs }))).toMatchObject({ agent: 'qa-reporter' });
    expect(route(snap([spec(), t], { prs: new Map([[10, { headSha: 'abc', merged: false, checksDone: false }]]) }))).toBeUndefined();
    const reported = new Map([[10, new Set(['abc'])]]);
    expect(route(snap([spec(), t], { prs, reported }))).toBeUndefined();
    expect(waitingOnOwner(snap([spec(), t], { prs, reported })).toMerge).toEqual([10]);
    const merged = new Map([[10, { headSha: 'abc', merged: true, checksDone: false }]]);
    expect(route(snap([spec(), t], { prs: merged }))).toEqual({ kind: 'mark-done', ticket: 10, rule: 'merged-pr' });
  });

  it('sends a PR that changed after its review back to review, before QA or merge', () => {
    const t = ticket({ state: 'in-qa', pr: 5, reviewedSha: 'abc' });
    const prs = new Map([[10, { headSha: 'def', merged: false, checksDone: true }]]);
    const reported = new Map([[10, new Set(['def'])]]);
    expect(route(snap([spec(), t], { prs, reported }))).toEqual({ kind: 're-review', ticket: 10, rule: 'pushed-after-review' });
    expect(waitingOnOwner(snap([spec(), t], { prs, reported })).toMerge).toEqual([]);
    const legacy = ticket({ state: 'in-qa', pr: 5 });
    expect(route(snap([spec(), legacy], { prs }))).toMatchObject({ kind: 're-review' });
  });

  it('closes a spec whose tickets are all done, and skips what it was told to', () => {
    const tickets = [spec(), ticket({ state: 'done', closed: true })];
    expect(route(snap(tickets))).toMatchObject({ agent: 'planner', rule: 'close-spec' });
    expect(route(snap([spec(), ticket()]), new Set(['designer:10']))).toBeUndefined();
  });

  it('leaves blocked and needs-human tickets to the owner', () => {
    const tickets = [spec(), ticket({ state: 'needs-human' }), ticket({ id: 11, state: 'blocked' })];
    expect(route(snap(tickets))).toBeUndefined();
    expect(waitingOnOwner(snap(tickets)).needsHuman).toEqual([10, 11]);
  });
});

class FakeHost implements CodeHost {
  prs = new Map<number, PullRequest>();
  checkRuns: Check[] = [{ name: 'test', status: 'completed', conclusion: 'success', url: 'u' }];
  async findPr() {
    return undefined;
  }
  async openPr(): Promise<PullRequest> {
    throw new Error('unused');
  }
  async getPr(n: number) {
    return this.prs.get(n) ?? { number: n, url: 'u', head: 'h', headSha: SHA, state: 'open' as const, merged: false };
  }
  async diff() {
    return '';
  }
  async checks() {
    return this.checkRuns;
  }
  statuses: Array<[string, string, string]> = [];
  async setStatus(sha: string, context: string, state: string) {
    this.statuses.push([sha, context, state]);
  }
}

// Plays each agent by applying the move its prompt would make.
class ScriptedRunner implements AgentRunner {
  calls: RunRequest[] = [];
  constructor(private readonly act: (agent: string, ticket: number) => Promise<void>) {}
  async run(req: RunRequest) {
    this.calls.push(req);
    await this.act(req.agent, Number(/(\d+)/.exec(req.prompt)![1]));
    return { ok: true, exitCode: 0, durationMs: 1, summary: `${req.agent} done` };
  }
}

describe('Dispatcher', () => {
  async function setup(act: (f: Factory, host: FakeHost, agent: string, n: number) => Promise<void>) {
    const tracker = new MemoryTracker();
    const host = new FakeHost();
    const factory = new Factory(tracker, { codeHost: host });
    await factory.create({ title: 'Spec', type: 'spec', body: '- AC-1: x' }, 'grill');
    await factory.create({ title: 'Add', spec: 1, covers: ['AC-1'] }, 'planner');
    const runner = new ScriptedRunner((agent, n) => act(factory, host, agent, n));
    const dir = mkdtempSync(join(tmpdir(), 'factory-logs-'));
    const lines: string[] = [];
    const d = new Dispatcher({ tracker, factory, codeHost: host, runner, cwd: '.', log: new JsonlLog(dir), out: (s) => lines.push(s) });
    return { tracker, host, factory, runner, d, dir, lines };
  }

  const happyPath = async (f: Factory, host: FakeHost, agent: string, n: number) => {
    if (agent === 'factory-designer') await f.move(n, { to: 'designed', role: 'designer' });
    if (agent === 'factory-qa-writer') await f.markTestsReady(n, 'qa-writer');
    if (agent === 'factory-builder') {
      await f.move(n, { to: 'building', role: 'builder' });
      await f.move(n, { to: 'in-review', role: 'builder', pr: 5 });
    }
    if (agent === 'factory-reviewer') await f.move(n, { to: 'in-qa', role: 'reviewer', sha: SHA });
    if (agent === 'factory-qa-reporter') await f.note(n, 'qa-reporter', `PASS at ${SHA}`);
    if (agent === 'factory-planner') await f.closeSpec(1, 'planner');
    void host;
  };

  it('runs a ticket to the merge, waits for the owner, then finishes the spec', async () => {
    const { d, runner, host, tracker, dir } = await setup(happyPath);
    const first = await d.run();
    expect(runner.calls.map((c) => c.agent)).toEqual(['factory-designer', 'factory-qa-writer', 'factory-builder', 'factory-reviewer', 'factory-qa-reporter']);
    expect(first).toMatchObject({ toMerge: [2], stoppedBy: 'idle' });
    expect(runner.calls[0]!.prompt).toBe('Ticket 2 (spec 1). Follow your prompt.');

    host.prs.set(5, { number: 5, url: 'u', head: 'ticket-2', headSha: SHA, state: 'closed', merged: true });
    const second = await d.run();
    expect(second.markedDone).toEqual([2]);
    expect(runner.calls.at(-1)!.agent).toBe('factory-planner');
    expect((await tracker.get(1)).closed).toBe(true);

    const runs = readFileSync(join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(runs).toHaveLength(6);
    expect(runs[0]).toMatchObject({ ticket: 2, agent: 'designer', rule: 'design', ok: true, changed: true });
  });

  it('reviews again when the builder pushes after the review', async () => {
    const pushed = 'e'.repeat(40);
    const { d, runner, host, tracker } = await setup(async (f, h, agent, n) => {
      if (agent === 'factory-reviewer') {
        const head = (await h.getPr(5)).headSha;
        await f.move(n, { to: 'in-qa', role: 'reviewer', sha: head });
        // The first time, a push lands right after the review.
        if (head === SHA) h.prs.set(5, { number: 5, url: 'u', head: 'ticket-2', headSha: pushed, state: 'open', merged: false });
      } else if (agent === 'factory-qa-reporter') await f.note(n, 'qa-reporter', `PASS at ${(await h.getPr(5)).headSha}`);
      else await happyPath(f, h, agent, n);
    });
    const r = await d.run();
    expect(runner.calls.map((c) => c.agent).slice(-3)).toEqual(['factory-reviewer', 'factory-reviewer', 'factory-qa-reporter']);
    expect(r.toMerge).toEqual([2]);
    expect((await tracker.get(2)).reviewedSha).toBe(pushed);
    expect(host.statuses.map((s) => s[0])).toEqual([SHA, pushed]);
  });

  it('gives up on an agent that changes nothing, until the ticket changes', async () => {
    const { d, runner, lines } = await setup(async () => {});
    const r = await d.run();
    expect(runner.calls).toHaveLength(1);
    expect(r.stuck).toEqual(['designer:2']);
    expect(lines.join('\n')).toContain('stuck');
  });

  it('stops at max runs and can dry-run', async () => {
    const { d, runner } = await setup(happyPath);
    expect(await d.run({ dryRun: true })).toMatchObject({ stoppedBy: 'dry-run', next: { agent: 'designer', ticket: 2 } });
    expect(runner.calls).toHaveLength(0);
    expect(await d.run({ maxRuns: 2 })).toMatchObject({ stoppedBy: 'max-runs' });
    expect(runner.calls).toHaveLength(2);
  });
});

describe('runner and lock', () => {
  it('reads claude -p JSON output', () => {
    const out = JSON.stringify({ result: 'did things\nMoved #3 to in-review, PR #6', is_error: false, session_id: 's', total_cost_usd: 0.42, num_turns: 9 });
    expect(parseResult(out, '', 0, 5)).toEqual({ ok: true, exitCode: 0, durationMs: 5, summary: 'Moved #3 to in-review, PR #6', sessionId: 's', costUsd: 0.42, turns: 9 });
    expect(parseResult('not json', 'boom', 1, 5)).toMatchObject({ ok: false, summary: 'boom' });
  });

  it('allows one dispatcher at a time', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'factory-lock-')), 'dispatch.lock');
    const a = new Lock(file);
    a.acquire();
    expect(() => new Lock(file).acquire()).toThrow(/another dispatcher/);
    a.release();
    new Lock(file).acquire();
  });
});

describe('ClaudeRunner', () => {
  it('passes the prompt on stdin, after variadic flags', async () => {
    const { ClaudeRunner } = await import('./runner.js');
    // A stand-in for claude that echoes its stdin and args as the JSON result.
    const dir = mkdtempSync(join(tmpdir(), 'factory-claude-'));
    const bin = join(dir, 'claude');
    const { writeFileSync, chmodSync } = await import('node:fs');
    writeFileSync(bin, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () =>
  console.log(JSON.stringify({ result: input + ' | ' + process.argv.slice(2).join(' '), is_error: false })));
`);
    chmodSync(bin, 0o755);
    const r = await new ClaudeRunner(bin).run({ agent: 'factory-designer', prompt: 'Ticket 8.', cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('Ticket 8. | -p --agent factory-designer --output-format json --permission-mode acceptEdits --allowedTools Bash');
  });
});
