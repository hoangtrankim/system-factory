// Pull requests and CI live on the code host, which stays GitHub even if tickets move to Jira.
// Agents use these through the CLI because `gh pr ...` needs GraphQL, which some networks block.

import { ghCli, type GhApi } from './tracker/github.js';

export interface PullRequest {
  number: number;
  url: string;
  head: string;
  headSha: string;
  state: 'open' | 'closed';
  merged: boolean;
}

export interface Check {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

export interface CodeHost {
  findPr(branch: string): Promise<PullRequest | undefined>;
  openPr(branch: string, base: string, title: string, body: string): Promise<PullRequest>;
  getPr(number: number): Promise<PullRequest>;
  diff(number: number): Promise<string>;
  checks(number: number): Promise<Check[]>;
}

interface GhPull {
  number: number;
  html_url: string;
  head: { ref: string; sha: string };
  state: 'open' | 'closed';
  merged_at: string | null;
}

const toPr = (p: GhPull): PullRequest => ({
  number: p.number,
  url: p.html_url,
  head: p.head.ref,
  headSha: p.head.sha,
  state: p.state,
  merged: !!p.merged_at,
});

export class GitHubCodeHost implements CodeHost {
  constructor(
    private readonly repo: string,
    private readonly gh: GhApi = ghCli,
  ) {}

  private path(p: string) {
    return `repos/${this.repo}/${p}`;
  }

  async findPr(branch: string): Promise<PullRequest | undefined> {
    const owner = this.repo.split('/')[0];
    const pulls = (await this.gh({ path: this.path(`pulls?state=all&head=${owner}:${branch}&per_page=10`) })) as GhPull[];
    const open = pulls.find((p) => p.state === 'open') ?? pulls[0];
    return open && toPr(open);
  }

  async openPr(branch: string, base: string, title: string, body: string): Promise<PullRequest> {
    return toPr((await this.gh({ method: 'POST', path: this.path('pulls'), body: { head: branch, base, title, body } })) as GhPull);
  }

  async getPr(number: number): Promise<PullRequest> {
    return toPr((await this.gh({ path: this.path(`pulls/${number}`) })) as GhPull);
  }

  async diff(number: number): Promise<string> {
    return (await this.gh({ path: this.path(`pulls/${number}`), accept: 'application/vnd.github.diff' })) as string;
  }

  async checks(number: number): Promise<Check[]> {
    const pr = await this.getPr(number);
    const res = (await this.gh({ path: this.path(`commits/${pr.headSha}/check-runs?per_page=100`) })) as {
      check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string }>;
    };
    return res.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url }));
  }
}
