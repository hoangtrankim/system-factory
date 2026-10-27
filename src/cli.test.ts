import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, run } from './cli.js';
import { parseRemote } from './config.js';
import { MemoryTracker } from './tracker/memory.js';

function harness() {
  const tracker = new MemoryTracker();
  const lines: string[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'factory-'));
  const exec = (cmd: string) => run(cmd.split(' '), { tracker, out: (s) => lines.push(s), cwd });
  return { tracker, lines, exec, cwd };
}

describe('parseArgs', () => {
  it('reads positionals, repeated flags, inline values and booleans', () => {
    const a = parseArgs(['move', '3', 'building', '--as', 'reviewer', '--risky', '--component=api', '--component', 'ui']);
    expect(a.positional).toEqual(['move', '3', 'building']);
    expect(a.flags.get('as')).toEqual(['reviewer']);
    expect(a.flags.get('risky')).toEqual(['true']);
    expect(a.flags.get('component')).toEqual(['api', 'ui']);
  });

  it('complains about a missing value', () => {
    expect(() => parseArgs(['move', '--as'])).toThrow(/needs a value/);
  });
});

describe('run', () => {
  it('requires --as for changes', async () => {
    const { exec } = harness();
    await expect(exec('create --title Spec --type spec')).rejects.toThrow(/--as <role> is required/);
  });

  it('files a spec and a ticket, then moves it', async () => {
    const { exec, lines, tracker } = harness();
    await exec('create --as grill --type spec --title Todo --body AC-1');
    await exec('create --as planner --title Add --spec 1 --covers AC-1 --priority p1 --component ui');
    await exec('move 2 designed --as designer');
    expect((await tracker.get(2)).state).toBe('designed');
    expect(lines.at(-1)).toMatch(/^#2 {2}designed/);
  });

  it('prints JSON with --json', async () => {
    const { exec, lines } = harness();
    await exec('create --as grill --type spec --title Todo --json');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ id: 1, type: 'spec', state: 'spec' });
  });

  it('reads maxRounds from factory.config.yml', async () => {
    const { exec, cwd, tracker } = harness();
    writeFileSync(join(cwd, 'factory.config.yml'), 'maxRounds: 1\n');
    await exec('create --as grill --type spec --title Todo --body AC-1');
    await exec('create --as planner --title Add --spec 1 --covers AC-1');
    await exec('move 2 designed --as designer');
    await exec('tests-ready 2 --as qa-writer');
    await exec('move 2 building --as builder');
    await exec('move 2 in-review --as builder --pr 5');
    await exec('move 2 building --as reviewer --reason missing-test');
    expect((await tracker.get(2)).state).toBe('needs-human');
  });

  it('rejects unknown states and roles', async () => {
    const { exec } = harness();
    await expect(exec('move 1 shipped --as builder')).rejects.toThrow(/state must be one of/);
    await expect(exec('move 1 done --as boss')).rejects.toThrow(/unknown role/);
  });
});

describe('parseRemote', () => {
  it('reads https and ssh remotes', () => {
    expect(parseRemote('https://github.com/hoangtrankim/system-factory.git')).toBe('hoangtrankim/system-factory');
    expect(parseRemote('git@github.com:hoangtrankim/system-factory.git')).toBe('hoangtrankim/system-factory');
    expect(parseRemote('https://example.com/x/y')).toBeUndefined();
  });
});
