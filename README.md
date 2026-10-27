# system-factory

An autonomous spec-to-PR workflow built on Claude Code. Agents grill a spec, split it into tickets, design, build, review and QA each ticket, and merge through CI. Nobody reviews PRs by hand: rules in code and a CI gate decide.

Design doc: https://claude.ai/artifact/Kqw238YaXngzZFgXsEv4fn

The idea, borrowed from [Kiln](https://github.com/thuongdinh/kiln-software-factory): **judgement lives in prompts, rules live in code, state lives in the tracker.** Agents never edit labels themselves. They call the `factory` CLI, which refuses any move the rules don't allow.

## Status

Phase 1 of 5 is here: the rules script, the labels and the GitHub tracker.

1. Rules script, labels, GitHub tracker adapter, unit tests (this)
2. Agent prompts: Grill, Planner, Designer, QA test writer, Builder, Reviewer, QA reporter, Security reviewer
3. CI gate, branch protection and merge queue
4. Dispatcher loop on the Mac mini, plus logs
5. Parallel improvements, then retro and lessons

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
| any → blocked | any agent, owner | a reason |
| any → needs-human | any agent, owner, system | a reason |
| blocked / needs-human → planned | planner, owner | |

The send-back that reaches `maxRounds` (default 3) goes to `needs-human` instead. Send-back reasons: `spec-gap`, `wrong-behavior`, `missing-test`, `failing-check`, `scope-creep`, `design`, `unmarked-risk`.

Only the qa-writer marks tests ready, only grill or owner file specs, only planner or owner file tickets and close specs.

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

```sh
npm install && npm run build
npx factory setup --repo owner/name          # create the labels once
npx factory create --as grill --type spec --title "Todo app" --body-file spec.md
npx factory create --as planner --title "Add a todo" --spec 1 --covers AC-1 --component ui
npx factory move 2 designed --as designer
npx factory tests-ready 2 --as qa-writer
npx factory next                             # tickets a builder may start now
npx factory move 2 building --as builder
npx factory move 2 in-review --as builder --pr 5
npx factory move 2 building --as reviewer --reason missing-test --note "No test for empty input"
```

The repo comes from `--repo`, then `FACTORY_REPO`, then `repo:` in `factory.config.yml`, then the `origin` remote. GitHub calls go through `gh api`, so run `gh auth login` first. A refused move exits with code 2 and says why.

`factory.config.yml` (optional):

```yaml
repo: owner/name
maxRounds: 3
```

## Development

```sh
npm test          # unit tests
npm run typecheck
```
