# system-factory

An autonomous spec-to-PR workflow built on Claude Code. You agree a spec with the Grill. After that, agents split it into tickets, then design, test, build, review and QA each ticket, with one PR per ticket. Nobody reviews the PRs by hand: rules in code, a security gate for risky work, blind acceptance tests and CI decide.

The idea comes from [Kiln](https://github.com/thuongdinh/kiln-software-factory): **judgement lives in prompts, rules live in code, state lives in the tracker.** Agents never edit labels themselves. They call the `factory` CLI, which refuses any move the rules don't allow.

Design doc: https://claude.ai/artifact/Kqw238YaXngzZFgXsEv4fn

## Status

| Phase | What | State |
| --- | --- | --- |
| 1 | Rules CLI, labels, GitHub tracker adapter, unit tests | done |
| 2 | Agent prompts: Grill, Planner, Designer, QA test writer, Builder, Security, Reviewer, QA reporter | done, tuned by two dry runs on [todo-app](https://github.com/hoangtrankim/todo-app) |
| 3 | CI gate, branch protection and merge queue | next: until then the owner merges each PR |
| 4 | `factory dispatch`: the loop that runs the agents, plus JSONL logs | done |
| 5 | Parallel slots, then retro and lessons from the logs | later |

## The workflow

```
 you + Grill          Planner           per ticket (one PR each)                                   you
 ───────────    ───────────────    ─────────────────────────────────────────────────────────    ─────
 idea → spec ─▶ spec → tickets ─▶ Designer → QA writer → Builder → [Security] → Reviewer → QA ─▶ merge
 (AC-1, AC-2…)  (covers, blockers,  design    blind       PR        risky      read-only   CI      │
                 priority, risky)   note      tests                 only       review    evidence  ▼
                                                                                         ticket done
                                       ◀────── send-back with a typed reason (round +1) ──────┘
 Planner again: when every ticket is done, files review follow-ups as tickets or closes the spec
```

1. **Grill** (`/factory-grill` in Claude Code). It questions you one at a time, each with a suggested default, until every behaviour is testable. It writes the spec with numbered `AC-n` criteria and files it as a GitHub issue labelled `type:spec`.
2. **Plan.** The planner splits the spec into PR-sized tickets. Each ticket names the criteria it covers, its components (from `factory.config.yml`), its priority and its blockers. Tickets touching the same component block each other so they never run at once. Risky tickets are marked `risky` (see below).
3. **Design.** The designer writes a short design note on the ticket covering the public interface, test setup, files, approach and risks. The public interface names every control's role and accessible name, plus each route's status codes.
4. **Blind tests.** The QA writer reads only the spec and the design note's public interface (`factory interface N`), never the code. It writes acceptance tests under `tests/acceptance/`, pushes them to branch `ticket-N`, and marks the ticket `tests-ready`. The builder can never change these tests.
5. **Build.** In its own worktree on top of those tests, the builder makes them pass and adds its own tests. It opens the PR with `factory pr`. If an acceptance test is wrong, it sends the ticket back to the QA writer (`flawed-test`) rather than working around it.
6. **Security gate** (risky tickets only). A read-only security reviewer passes or fails the PR. A fail sends it back and costs a round. It also writes a risk note for the owner's weekly digest.
7. **Review.** A read-only reviewer checks the PR against the spec, the design note, the ticket's components and the acceptance-test commits, and runs the tests. Blocking findings send the ticket back with a typed reason. Minor ones become **Follow-ups**.
8. **QA.** The QA reporter reads CI on the PR's head commit and posts per-test evidence on the ticket. Red CI sends the ticket back.
9. **Merge.** The owner merges the PR (the merge queue takes over in phase 3). The dispatcher then marks the ticket done, which unblocks the next one.
10. **Close.** When every ticket is done, the planner files the real follow-ups as new tickets, or closes the spec.

A ticket sent back 3 times goes to `needs-human`. So does any question an agent cannot answer. Agents never guess past a gap in the spec.

**Risky** means login or sessions, permissions or one user reaching another's data, payments, secrets, personal data, or bulk or irreversible deletion. A user deleting one of their own items is not risky. Risky tickets still merge without a human, but only after the security gate.

## Run it

The runner is one machine (the Mac mini) with Node 22+, `git`, the GitHub CLI and Claude Code, all signed in.

```sh
# once: the factory CLI (the repo is private, so link it from a clone)
git clone https://github.com/hoangtrankim/system-factory && cd system-factory
npm ci && npm run build && npm link

# once per target repo
cd ~/path/to/your-app
factory init --repo owner/name      # agents + grill skill into .claude/, and factory.config.yml
factory setup                       # create the labels
```

Then, for each piece of work:

1. In Claude Code in the target repo, run `/factory-grill` and agree the spec.
2. In a terminal in the same repo, run `factory dispatch --watch`.
3. Merge each PR when it is ready. The dispatcher prints them, and each ticket has the QA evidence. The dispatcher notices the merge and carries on.

Check `factory dispatch --dry-run` at any time to see what would run next. `factory list --all` shows every ticket.

A step-by-step runbook for todo-app: https://claude.ai/artifact/CYF2fR38JET9qbkC4C5k9N

## The dispatcher

`factory dispatch` reads the tickets, picks the next step from the routing table in `src/router.ts`, and runs that agent as its own process: `claude -p --agent factory-<role>`, given only the ticket number. It then reads the tickets again. The first matching rule wins:

1. A spec with uncovered criteria → planner (split).
2. `in-qa` with a merged PR → the dispatcher marks it done.
3. `in-qa` with CI finished and no QA note for the head SHA → qa-reporter.
4. Risky `in-review` without a passed gate → security.
5. Other `in-review` → reviewer.
6. `building` (a send-back, or a build that stopped) → builder.
7. `designed` with tests ready and blockers done → builder.
8. `designed` without tests → qa-writer.
9. `planned` → designer.
10. A spec whose tickets are all done → planner (close or file follow-ups).

Finishing work comes before starting new work, and within a rule the lowest priority number goes first.

The dispatcher runs one agent at a time and posts "Started `factory-<role>`" on the ticket before each run. If a run changes nothing, it skips that agent on that ticket until the ticket changes. It never merges. A lock file stops a second dispatcher on the same repo.

| Flag | Effect |
| --- | --- |
| `--dry-run` | print the next step only |
| `--max-runs N` | stop after N agent runs (default 25; ignored with `--watch`) |
| `--watch [--interval S]` | never stop; when idle, check again every S seconds (default 300) for merges and new specs |

### Logs

Logs record facts, not transcripts. They go to `~/.factory/logs/<owner>/<repo>/`, or `FACTORY_LOG_DIR` if set, and the phase 5 retro will read them:

- `events.jsonl` has every ticket change made through the CLI, including the agents' own: moves, gates, notes, rounds, escalations.
- `runs.jsonl` has one line per agent run: ticket, agent, rule, exit code, duration, cost, turns, session id, whether it changed anything, and its one-line summary.

## Agents

Each role is a Claude Code subagent in `agents/`, and the Grill is a skill in `skills/`. `factory init` copies them into a project's `.claude/` folder. Every agent:

- changes tickets only through `factory ... --as <its role>`;
- reads `lessons/<role>.md` if it exists;
- writes its notes to `/tmp/factory/<role>-<N>.md`;
- ends with a one-line report.

| Agent | Picks up | Does | Tools |
| --- | --- | --- | --- |
| Grill (skill) | an idea from the owner | grills the owner one question at a time, writes the spec, files it | main session |
| `factory-planner` | a new spec, a blocked ticket, a finished spec | splits the spec into tickets; corrects them before building (`factory edit`); files follow-ups; closes the spec | read only |
| `factory-designer` | `planned` | design note: public interface with test setup, files, approach, risks (must / should) | read + temp files |
| `factory-qa-writer` | `designed` without tests | blind acceptance tests and the test setup they need, pushed to `ticket-N` | no `Grep` or `Edit`; never reads app code |
| `factory-builder` | ready tickets and send-backs | builds in a worktree, opens the PR; never touches `tests/acceptance/` | full |
| `factory-security` | risky tickets in `in-review` | security gate pass or fail, plus a risk note | read only, opus |
| `factory-reviewer` | `in-review` (after security on risky) | fresh review against spec, design and scope; runs the tests; blocking findings or follow-ups | read only, opus |
| `factory-qa-reporter` | `in-qa` with CI finished | per-test evidence from CI; red CI goes back | read only |

Read-only agents still have `Bash`, so they can run `factory`, `git` and tests. The prompts forbid writes. Guard hooks that block writes mechanically come later.

The contract test in `src/agents.test.ts` keeps the prompts honest. It checks that each agent acts only as its own role, names only real states and send-back reasons, never uses GraphQL `gh` commands, and keeps the flawed-test path.

## Ticket lifecycle

```
planned -> designed -> building -> in-review -> in-qa -> done
              ^           ^            |           |
              |           +-- send back (round +1) +
              +-- flawed-test send-back (round +1)
side states: blocked, needs-human
```

| Move | Who | The CLI checks first |
| --- | --- | --- |
| planned → designed | designer | |
| designed → building | builder | blind QA tests are marked ready, every `Blocked by` ticket is done |
| building → in-review | builder | a PR is given |
| in-review → in-qa | reviewer | a `risky` ticket has passed the security gate |
| in-qa → done | system (the dispatcher) | the PR is linked; the dispatcher only does this once it is merged |
| in-review → building | reviewer, security | a send-back reason; round + 1 |
| in-qa → building | qa-reporter, system | a send-back reason; round + 1 |
| building / in-review → designed | builder, reviewer | reason `flawed-test` only; round + 1, tests-ready cleared, so the QA writer fixes the test |
| any → blocked | any agent, owner | a reason |
| any → needs-human | any agent, owner, system | a reason |
| blocked / needs-human → planned | planner, owner | |

The send-back that reaches `maxRounds` (default 3) goes to `needs-human` instead. Send-back reasons: `spec-gap`, `wrong-behavior`, `missing-test`, `failing-check`, `scope-creep`, `design`, `unmarked-risk`, `flawed-test`.

Only the grill or owner file specs. Only the planner or owner file tickets, edit them before building and close specs. Only the qa-writer marks tests ready, and only the builder opens a ticket's PR, from branch `ticket-N`.

## How a ticket is stored

| Field | On GitHub |
| --- | --- |
| State | `factory:<state>` label |
| Type | `type:spec` label (none means a build ticket) |
| Priority | `priority:p0` … `priority:p3` (none means p2) |
| Round | `round:N` |
| Flags | `risky`, `qa:tests-ready` |
| Components | `component:<name>` |
| Gate results | `gate:security:pass` or `:fail`, cleared on every send-back |
| Links | body lines `Spec: #1`, `Covers: AC-1, AC-2`, `Blocked by: #3`, `PR: #12` |
| Design note, reviews, evidence | comments on the ticket, each starting with the role that wrote it |

All ticket access goes through the `Tracker` interface in `src/tracker/tracker.ts`, so a Jira adapter can replace GitHub Issues later. PRs and CI go through `CodeHost` in `src/codehost.ts`. Every GitHub call uses the REST API (`gh api`), never GraphQL, so it also works on networks that block GraphQL.

## CLI reference

Commands that change something need `--as <role>`. A refused change exits with code 2 and says why. `--note-file` works anywhere `--note` does.

```sh
factory init [dir] [--force]                 # install agents, grill skill, factory.config.yml
factory setup                                # create the labels
factory list [--state S] [--type spec|build] [--all]
factory show N [--comments [--from role,role]]
factory next                                 # tickets a builder may start now
factory spec-status S                        # criteria, uncovered, open tickets

factory create --as grill --type spec --title T --body-file F
factory create --as planner --spec S --title T --covers AC-1,AC-2 --component ui [--blocked-by 2] [--priority p1] [--risky]
factory edit N --as planner [--risky | --not-risky] [--component C] [--covers ...] [--blocked-by ...]
factory move N <state> --as R [--reason R] [--note-file F] [--pr P]
factory tests-ready N --as qa-writer --note-file F
factory gate N security pass|fail --as security [--reason R] --note-file F
factory note N --as R --note-file F
factory evidence N <file> --as qa-reporter   # upload, print the link
factory close-spec S --as planner

factory interface N                          # the design note's Public interface only
factory pr N --as builder --body-file F      # open or find the PR for branch ticket-N
factory diff N                               # the PR's diff
factory checks N                             # CI on the PR head, and whether it is merged; exit 3 failed, 4 pending
factory dispatch [--dry-run] [--max-runs N] [--watch [--interval S]]
```

The repo comes from `--repo`, then `FACTORY_REPO`, then `repo:` in `factory.config.yml`, then the `origin` remote.

## factory.config.yml

```yaml
repo: owner/name
base: main          # branch PRs target
maxRounds: 3        # send-backs before needs-human
components:         # name -> paths it owns; tickets use these names, the reviewer checks PR scope
  ui: ["public/**"]
  api: ["server.js", "lib/**"]
claudeArgs:         # optional: flags for each agent run (default below)
  ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"]
```

`factory init --force` rewrites this file from the template, so keep a copy when you reinstall the agents.

## Development

```sh
npm test          # unit tests, including the agent-prompt contract test
npm run typecheck
npm run build     # dist/, used by the linked `factory` command
```
