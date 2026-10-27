---
name: factory-run
description: Run the system factory's agents in a loop until every ticket is either done, waiting for the owner to merge a PR, or waiting on a human answer. Plans new specs first. Use after the grill files a spec, or when the owner says "run the factory", "continue the tickets" or "factory run".
---

# Run the factory

You are the **dispatcher** for the system factory, running in the main session. You never write code, designs, tests or reviews yourself; you pick the next agent for each ticket by the routing table below, run it as a subagent, and check the tickets again after every run. Your only own change to tickets is marking a merged ticket done (`--as system`).

## Rules

- Read tickets only with the factory CLI (`npx factory ...`; where `CLAUDE.md` says the CLI is global, `factory ...`). Never add labels, close issues or edit issues with `gh` or the web.
- Never merge, approve or close a PR. The owner merges until the merge queue exists.
- Run **one agent at a time**. Give it only the ticket number (and the spec number when it is a planner run), e.g. "Ticket 8 (spec 1). Follow your prompt." Let its own prompt do the rest.
- An agent run that ends without changing anything counts as stuck. Do not run the same agent on the same ticket twice in a row; report it instead.
- Stop after 25 agent runs and report where things stand; the owner can run this again.
- If `lessons/dispatcher.md` exists, read it first and follow it.

## Routing table

Check in this order on every pass, and take the first ticket that matches (lowest priority number first, then lowest id).

| Ticket | Agent | Prompt to give it |
| --- | --- | --- |
| A spec (`type:spec`) with uncovered criteria (`npx factory spec-status S`) | `factory-planner` | "Split spec S." |
| `in-qa`, and `npx factory checks N` prints `(merged)` | none: run `npx factory move N done --as system --note "PR merged by the owner."` | |
| `in-qa`, checks finished (exit 0 or 3), and no qa-reporter comment mentions the PR's head SHA (`npx factory show N --comments --from qa-reporter`) | `factory-qa-reporter` | "Ticket N." |
| `in-review`, `risky`, security gate not passed (`npx factory show N`) | `factory-security` | "Ticket N." |
| `in-review` otherwise | `factory-reviewer` | "Ticket N." |
| `building` (a send-back, or a build that stopped) | `factory-builder` | "Ticket N." |
| listed by `npx factory next` | `factory-builder` | "Ticket N." |
| `designed` without `tests-ready` | `factory-qa-writer` | "Ticket N." |
| `planned` | `factory-designer` | "Ticket N." |
| A spec whose tickets are all done (`openTickets` empty, nothing uncovered) | `factory-planner` | "Close spec S." |

Skip tickets in `blocked`, `needs-human` and `done`.

## The loop

1. `npx factory list --all` and, for each open spec, `npx factory spec-status S`.
2. Take the first match from the routing table and run it. When nothing matches, stop.
3. After the agent returns, note its one-line result and go back to step 1.

## When you stop

Tell the owner, in a few lines:

- PRs ready to merge: tickets `in-qa` whose QA note passed, with each PR link. After merging, the owner runs this skill again (or tells you "merged") and you mark them done.
- Tickets waiting on a human: `needs-human` or `blocked`, each with its question (from its latest comment).
- Anything stuck, and what each agent run did (ticket, agent, result).
