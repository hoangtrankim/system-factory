#!/usr/bin/env node
// factory: the only way agents change tickets. Every command that changes something needs --as.

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig, resolveRepo } from './config.js';
import { Factory, RuleError } from './factory.js';
import { GATES, ROLES, STATES, isRole, isState, type Gate, type Priority, type Role, type Ticket } from './lifecycle.js';
import { GitHubTracker } from './tracker/github.js';
import type { Tracker } from './tracker/tracker.js';

const USAGE = `Usage: factory <command> [options]

Commands
  setup                                   Create the factory labels in the repo
  list [--state S] [--type spec|build] [--all]
  show <id>
  next [--limit N]                        Tickets a builder may start now
  create --as R --title T [--body B | --body-file F] [--type spec]
         [--spec N --covers AC-1,AC-2] [--blocked-by 1,2] [--component C]...
         [--priority p0..p3] [--risky]
  move <id> <state> --as R [--reason R] [--note N] [--pr N]
  tests-ready <id> --as qa-writer [--note N]
  gate <id> <gate> pass|fail --as R [--reason R] [--note N]
  spec-status <id>
  close-spec <id> --as R

Options
  --repo owner/name   Defaults to FACTORY_REPO, factory.config.yml, then the origin remote
  --json              Print JSON

States: ${STATES.join(', ')}
Roles:  ${ROLES.join(', ')}`;

interface Args {
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(['risky', 'json', 'all', 'help']);

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    let value = inline;
    if (value === undefined) {
      if (BOOLEAN_FLAGS.has(name)) value = 'true';
      else {
        value = argv[++i];
        if (value === undefined) throw new UsageError(`--${name} needs a value`);
      }
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positional, flags };
}

class UsageError extends Error {}

const flag = (a: Args, name: string) => a.flags.get(name)?.at(-1);
const flagAll = (a: Args, name: string) => (a.flags.get(name) ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);

function role(a: Args): Role {
  const r = flag(a, 'as');
  if (!r) throw new UsageError('--as <role> is required for every change');
  if (!isRole(r)) throw new UsageError(`unknown role "${r}" (${ROLES.join(', ')})`);
  return r;
}

function id(v: string | undefined, what = 'id'): number {
  const n = Number(String(v ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`expected an issue number for ${what}, got "${v ?? ''}"`);
  return n;
}

function priority(v: string | undefined): Priority | undefined {
  if (v === undefined) return undefined;
  const m = /^p?([0-3])$/.exec(v);
  if (!m) throw new UsageError(`priority must be p0..p3, got "${v}"`);
  return Number(m[1]) as Priority;
}

function summary(t: Ticket): string {
  const bits = [`#${t.id}`, t.state.padEnd(11), `p${t.priority}`, t.title];
  const extra = [
    t.type === 'spec' ? 'spec' : '',
    t.round ? `round ${t.round}` : '',
    t.risky ? 'risky' : '',
    t.testsReady ? 'tests-ready' : '',
    t.pr ? `PR #${t.pr}` : '',
  ].filter(Boolean);
  return bits.join('  ') + (extra.length ? `  [${extra.join(', ')}]` : '');
}

export interface Deps {
  tracker?: Tracker;
  out?: (s: string) => void;
  cwd?: string;
}

export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => console.log(s));
  const a = parseArgs(argv);
  const [cmd, ...rest] = a.positional;
  if (!cmd || flag(a, 'help')) {
    out(USAGE);
    return cmd || flag(a, 'help') ? 0 : 1;
  }

  const config = loadConfig(deps.cwd);
  const tracker = deps.tracker ?? new GitHubTracker(resolveRepo(flag(a, 'repo'), config, deps.cwd));
  const factory = new Factory(tracker, { maxRounds: config.maxRounds });
  const json = flag(a, 'json') === 'true';
  const print = (v: Ticket | Ticket[] | object) => {
    if (json) return out(JSON.stringify(v, null, 2));
    if (Array.isArray(v)) return out(v.length ? v.map(summary).join('\n') : '(none)');
    if ('id' in v && 'state' in v) return out(summary(v as Ticket));
    out(JSON.stringify(v, null, 2));
  };

  switch (cmd) {
    case 'setup':
      await tracker.setup();
      out('Labels are in place.');
      return 0;

    case 'list': {
      const state = flag(a, 'state');
      if (state && !isState(state)) throw new UsageError(`unknown state "${state}"`);
      const type = flag(a, 'type');
      if (type && type !== 'spec' && type !== 'build') throw new UsageError(`--type must be spec or build`);
      print(await tracker.list({ state: state as never, type: type as never, includeClosed: flag(a, 'all') === 'true' }));
      return 0;
    }

    case 'show':
      print(await tracker.get(id(rest[0])));
      return 0;

    case 'next': {
      const limit = flag(a, 'limit');
      print(await factory.next(limit ? id(limit, '--limit') : undefined));
      return 0;
    }

    case 'create': {
      const title = flag(a, 'title');
      if (!title) throw new UsageError('--title is required');
      const bodyFile = flag(a, 'body-file');
      const type = flag(a, 'type') ?? 'build';
      if (type !== 'spec' && type !== 'build') throw new UsageError(`--type must be spec or build`);
      const spec = flag(a, 'spec');
      print(
        await factory.create(
          {
            title,
            body: bodyFile ? readFileSync(bodyFile, 'utf8') : (flag(a, 'body') ?? ''),
            type,
            priority: priority(flag(a, 'priority')),
            risky: flag(a, 'risky') === 'true',
            components: flagAll(a, 'component'),
            blockedBy: flagAll(a, 'blocked-by').map((v) => id(v, '--blocked-by')),
            covers: flagAll(a, 'covers'),
            spec: spec ? id(spec, '--spec') : undefined,
          },
          role(a),
        ),
      );
      return 0;
    }

    case 'move': {
      const to = rest[1];
      if (!to || !isState(to)) throw new UsageError(`move <id> <state>: state must be one of ${STATES.join(', ')}`);
      const pr = flag(a, 'pr');
      print(
        await factory.move(id(rest[0]), {
          to,
          role: role(a),
          reason: flag(a, 'reason'),
          note: flag(a, 'note'),
          pr: pr ? id(pr, '--pr') : undefined,
        }),
      );
      return 0;
    }

    case 'tests-ready':
      print(await factory.markTestsReady(id(rest[0]), role(a), flag(a, 'note')));
      return 0;

    case 'gate': {
      const [ticket, gate, result] = rest;
      if (!gate || !(GATES as readonly string[]).includes(gate)) throw new UsageError(`gate must be one of ${GATES.join(', ')}`);
      if (result !== 'pass' && result !== 'fail') throw new UsageError('gate result must be pass or fail');
      print(await factory.recordGate(id(ticket), gate as Gate, result, role(a), flag(a, 'reason'), flag(a, 'note')));
      return 0;
    }

    case 'spec-status':
      print(await factory.specStatus(id(rest[0])));
      return 0;

    case 'close-spec':
      print(await factory.closeSpec(id(rest[0]), role(a)));
      return 0;

    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    process.exitCode = await run(argv);
  } catch (e) {
    if (e instanceof RuleError) {
      console.error(`refused: ${e.message}`);
      process.exitCode = 2;
    } else if (e instanceof UsageError) {
      console.error(`${e.message}\n\nRun "factory --help" for usage.`);
      process.exitCode = 64;
    } else {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
