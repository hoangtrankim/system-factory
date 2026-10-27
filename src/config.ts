// factory.config.yml at the target repo's root. Every field is optional.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DEFAULT_MAX_ROUNDS } from './lifecycle.js';

export interface Config {
  repo?: string;
  maxRounds: number;
}

export const CONFIG_FILE = 'factory.config.yml';

export function loadConfig(dir = process.cwd()): Config {
  const file = join(dir, CONFIG_FILE);
  const raw = existsSync(file) ? ((parse(readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>) : {};
  const maxRounds = Number(raw.maxRounds ?? DEFAULT_MAX_ROUNDS);
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error(`${CONFIG_FILE}: maxRounds must be a positive integer`);
  return { repo: typeof raw.repo === 'string' ? raw.repo : undefined, maxRounds };
}

// owner/name from --repo, FACTORY_REPO, the config file, or the origin remote, in that order.
export function resolveRepo(flag: string | undefined, config: Config, dir = process.cwd()): string {
  const repo = flag ?? process.env.FACTORY_REPO ?? config.repo ?? originRepo(dir);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error('cannot tell which repo to use; pass --repo owner/name or set FACTORY_REPO');
  }
  return repo;
}

export function originRepo(dir: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' }).trim();
    return parseRemote(url);
  } catch {
    return undefined;
  }
}

export function parseRemote(url: string): string | undefined {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}
