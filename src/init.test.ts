import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { init, PACKAGE_ROOT } from './init.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'factory-init-'));

describe('init', () => {
  it('installs agents, the grill skill and a config', () => {
    const dir = tmp();
    const r = init(dir, { repo: 'o/r' });
    expect(r.written).toContain('.claude/agents/factory-builder.md');
    expect(r.written).toContain('.claude/skills/factory-grill/SKILL.md');
    expect(r.written).toContain('factory.config.yml');
    expect(r.written).toContain('.github/workflows/forge-dispatch.yml');
    expect(readFileSync(join(dir, 'factory.config.yml'), 'utf8')).toContain('repo: o/r');
    expect(r.skipped).toEqual([]);
  });

  it('keeps existing files unless forced', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.claude/agents'), { recursive: true });
    writeFileSync(join(dir, '.claude/agents/factory-builder.md'), 'mine');
    const r = init(dir);
    expect(r.skipped).toEqual(['.claude/agents/factory-builder.md']);
    expect(readFileSync(join(dir, '.claude/agents/factory-builder.md'), 'utf8')).toBe('mine');

    init(dir, { force: true });
    expect(readFileSync(join(dir, '.claude/agents/factory-builder.md'), 'utf8')).not.toBe('mine');
  });
});

describe('dispatch workflow template', () => {
  it('runs forge dispatch, one job at a time, with a token that starts other workflows', async () => {
    const { parse } = await import('yaml');
    const wf = parse(readFileSync(join(PACKAGE_ROOT, 'templates/workflows/forge-dispatch.yml'), 'utf8'));
    expect(Object.keys(wf.on)).toEqual(['issues', 'pull_request', 'workflow_run', 'schedule', 'workflow_dispatch']);
    expect(wf.concurrency).toEqual({ group: 'forge-dispatch', 'cancel-in-progress': false });
    const job = wf.jobs.dispatch;
    expect(job.env.GH_TOKEN).toBe('${{ secrets.FORGE_GH_TOKEN }}');
    expect(job.steps.find((s: { uses?: string }) => s.uses?.startsWith('actions/checkout')).with.token).toBe('${{ secrets.FORGE_GH_TOKEN }}');
    expect(job.steps.some((s: { run?: string }) => s.run?.startsWith('forge dispatch'))).toBe(true);
  });
});
