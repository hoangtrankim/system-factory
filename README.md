# system-factory

An autonomous spec-to-PR workflow built on Claude Code. Agents grill a spec, split it into tickets, design, build, review and QA each ticket, and merge through CI. Nobody reviews PRs by hand: rules in code and a CI gate decide.

Design doc: https://claude.ai/artifact/Kqw238YaXngzZFgXsEv4fn

The idea, borrowed from [Kiln](https://github.com/thuongdinh/kiln-software-factory): **judgement lives in prompts, rules live in code, state lives in the tracker.** Agents never edit labels themselves. They call the `factory` CLI, which refuses any move the rules don't allow.

## Status

Phases 1 and 2 of 5 are here.

1. Rules script, labels, GitHub tracker adapter, unit tests
2. Agent prompts: Grill, Planner, Designer, QA test writer, Builder, Reviewer, QA reporter, Security reviewer
3. CI gate, branch protection and merge queue
4. Dispatcher loop on the Mac mini, plus logs
5. Parallel improvements, then retro and lessons

## Agents

Each role is a Claude Code subagent in `agents/`, plus the Grill skill in `skills/`. `factory init` copies them into a project's `.claude/` folder. Every agent changes tickets only through `npx factory ... --as <its role>`, reads `lessons/<role>.md` if it exists, and ends with a one-line report.

| Agent | Picks up | Does | Tools |
| --- | --- | --- | --- |
| Grill (skill, main session) | an idea from the owner | grills the owner, writes the spec with `AC-n` criteria, files it | session |
| `factory-planner` | a new spec, a blocked ticket, a finished spec | splits the spec into PR-sized tickets with coverage, priority, components, blockers, `risky` | read only + `factory` |
| `factory-designer` | `planned` | design note: public interface, files, approach, risks | read + temp files |
| `factory-qa-writer` | `designed` without tests | blind acceptance tests from the spec and the public interface only, pushed to `ticket-N` | no `Grep`, no `Edit` |
| `factory-builder` | `factory next`, or a send-back | builds in a worktree on top of the tests, opens the PR; never touches `tests/acceptance/` | full |
| `factory-security` | `risky` tickets in `in-review` | security gate pass or fail, plus a risk note for the weekly digest | read only, opus |
| `factory-reviewer` | `in-review` (after security on risky) | fresh read-only review; blocking findings send it back with a typed reason | read only, opus |
| `factory-qa-reporter` | `in-qa` | turns the CI run into per-AC evidence; red CI goes back to building | read only |

Read-only agents still have `Bash` so they can run `factory`, `gh` and tests. The prompts forbid writes; guard hooks that block them mechanically come in a later phase.

## Ticket lifecycle

A **spec** issue (label `type:spec`) holds numbered acceptance criteria, one per line starting with `AC-n`. The Planner splits it into **tickets**; one ticket becomes one PR.

```
planned -> designed -> building -> in-review -> in-qa -> done
                          ^            |           |
                          +-- send back (round +1) +
side states: blocked, needs-human
```

| Move | Who | The CLI checks first |
| --- | --- | --- |
| planned → designed | designer | |
| designed → building | builder | blind QA tests are marked ready, every `Blocked by` ticket is done |
| building → in-review | builder | a PR is given |
| in-review → in-qa | reviewer | a `risky` ticket has passed the security gate |
| in-qa → done | system | a PR is linked (phase 3 records the merge) |
| in-review → building | reviewer, security | a send-back reason; round + 1 |
| in-qa → building | qa-reporter, system | a send-back reason; round + 1 |
| building / in-review → designed | builder, reviewer | reason `flawed-test` only; round + 1, tests-ready cleared, so the QA writer fixes the test |
| any → blocked | any agent, owner | a reason |
| any → needs-human | any agent, owner, system | a reason |
| blocked / needs-human → planned | planner, owner | |

The send-back that reaches `maxRounds` (default 3) goes to `needs-human` instead. Send-back reasons: `spec-gap`, `wrong-behavior`, `missing-test`, `failing-check`, `scope-creep`, `design`, `unmarked-risk`, `flawed-test`.

Only the qa-writer marks tests ready, only grill or owner file specs, only planner or owner file tickets, edit them before building (`factory edit`) and close specs. Only the builder opens a ticket's PR, from branch `ticket-N`.

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
| Evidence | files on the orphan `factory-evidence` branch |

All GitHub access goes through the `Tracker` interface in `src/tracker/tracker.ts` (eight methods), so a Jira adapter can replace it later.

## Usage

In the project the factory will work on:

```sh
npm install -D github:hoangtrankim/system-factory
npx factory init --repo owner/name           # agents, grill skill, factory.config.yml
npx factory setup                            # create the labels once
```

Then, by hand until the dispatcher exists:

```sh
npx factory create --as grill --type spec --title "Todo app" --body-file spec.md
npx factory create --as planner --title "Add a todo" --spec 1 --covers AC-1 --component ui
npx factory move 2 designed --as designer
npx factory tests-ready 2 --as qa-writer
npx factory next                             # tickets a builder may start now
npx factory move 2 building --as builder
npx factory move 2 in-review --as builder --pr 5
npx factory move 2 building --as reviewer --reason missing-test --note "No test for empty input"
npx factory note 2 --as qa-reporter --note-file evidence.md
npx factory evidence 2 screenshot.png --as qa-reporter
```

Reading, for agents:

```sh
npx factory show 2 --comments                # ticket plus its comments (design note, send-backs)
npx factory show 2 --comments --from builder,reviewer
npx factory interface 2                      # only the design note's Public interface (for the blind QA writer)
npx factory pr 2 --as builder --body-file pr.md   # open or find the PR for branch ticket-2
npx factory diff 2                           # the PR's diff
npx factory checks 2                         # CI checks; exit 3 if one failed, 4 while running
npx factory edit 2 --as planner --not-risky --note "Deleting your own todo is not risky"
```

Every GitHub call uses the REST API (`gh api`), never GraphQL, so it works on networks that block GraphQL; agent prompts use these commands instead of `gh issue` and `gh pr`.

`--note-file` works anywhere `--note` does.

The repo comes from `--repo`, then `FACTORY_REPO`, then `repo:` in `factory.config.yml`, then the `origin` remote. GitHub calls go through `gh api`, so run `gh auth login` first. A refused move exits with code 2 and says why.

`factory.config.yml` (optional):

```yaml
repo: owner/name
base: main          # branch PRs target
maxRounds: 3
components:         # name -> paths it owns; tickets use these names, the reviewer checks PR scope
  ui: ["public/**"]
  server: ["server.js"]
```

## Development

```sh
npm test          # unit tests
npm run typecheck
```
