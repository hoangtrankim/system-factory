// Applies the lifecycle rules against a tracker. Every accepted change is written to the
// ticket, explained in a comment, and reported as an event for the logs.

import {
  DEFAULT_MAX_ROUNDS,
  applyMove,
  canCloseSpec,
  canCreate,
  canMarkTestsReady,
  canMove,
  canRecordGate,
  pickReady,
  specStatus,
  type Check,
  type Gate,
  type GateResult,
  type Priority,
  type Role,
  type SpecStatus,
  type State,
  type Ticket,
  type TicketType,
} from './lifecycle.js';
import type { Tracker } from './tracker/tracker.js';

export class RuleError extends Error {}

export interface FactoryEvent {
  at: string;
  kind: 'create' | 'move' | 'mark' | 'gate' | 'close-spec';
  ticket: number;
  role: Role;
  from?: State;
  to?: State;
  reason?: string;
  round?: number;
  escalated?: boolean;
  gate?: Gate;
  result?: GateResult;
}

export interface FactoryOptions {
  maxRounds?: number;
  onEvent?: (e: FactoryEvent) => void;
  now?: () => Date;
}

export interface CreateInput {
  title: string;
  body?: string;
  type?: TicketType;
  priority?: Priority;
  risky?: boolean;
  components?: string[];
  blockedBy?: number[];
  covers?: string[];
  spec?: number;
}

export interface MoveInput {
  to: State;
  role: Role;
  reason?: string;
  note?: string;
  pr?: number;
}

function check(c: Check): void {
  if (!c.ok) throw new RuleError(c.error);
}

export class Factory {
  private readonly maxRounds: number;

  constructor(
    private readonly tracker: Tracker,
    private readonly opts: FactoryOptions = {},
  ) {
    this.maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  }

  private emit(e: Omit<FactoryEvent, 'at'>): void {
    this.opts.onEvent?.({ at: (this.opts.now?.() ?? new Date()).toISOString(), ...e });
  }

  async create(input: CreateInput, role: Role): Promise<Ticket> {
    const type = input.type ?? 'build';
    check(canCreate(type, role));
    if (type === 'build') {
      if (!input.spec) throw new RuleError('a ticket needs --spec <issue>');
      const spec = await this.tracker.get(input.spec);
      if (spec.type !== 'spec') throw new RuleError(`#${input.spec} is not a spec`);
      if (!input.covers?.length) throw new RuleError('a ticket needs --covers AC-n[,AC-m]');
    }
    const t = await this.tracker.create({
      title: input.title,
      body: input.body ?? '',
      type,
      state: type === 'spec' ? 'spec' : 'planned',
      priority: input.priority ?? 2,
      risky: input.risky ?? false,
      components: input.components ?? [],
      blockedBy: input.blockedBy ?? [],
      covers: input.covers ?? [],
      spec: input.spec,
    });
    this.emit({ kind: 'create', ticket: t.id, role, to: t.state });
    return t;
  }

  async move(id: number, input: MoveInput): Promise<Ticket> {
    const ticket = await this.tracker.get(id);
    const openBlockers = await this.openBlockers(ticket);
    check(canMove(ticket, input, { openBlockers }));

    const { ticket: next, escalated } = applyMove(ticket, input, this.maxRounds);
    const saved = await this.tracker.update(next);

    let text = escalated
      ? `**${input.role}** sent this back, and it reached round ${next.round} of ${this.maxRounds}, so it goes to \`needs-human\``
      : `**${input.role}** moved this from \`${ticket.state}\` to \`${input.to}\``;
    if (input.reason) text += `\n\nReason: \`${input.reason}\``;
    if (!escalated && next.round !== ticket.round) text += ` (round ${next.round} of ${this.maxRounds})`;
    if (input.note) text += `\n\n${input.note}`;
    await this.tracker.comment(id, text);

    this.emit({
      kind: 'move',
      ticket: id,
      role: input.role,
      from: ticket.state,
      to: saved.state,
      reason: input.reason,
      round: saved.round,
      escalated,
    });
    return saved;
  }

  async markTestsReady(id: number, role: Role, note?: string): Promise<Ticket> {
    const ticket = await this.tracker.get(id);
    check(canMarkTestsReady(ticket, role));
    const saved = await this.tracker.update({ ...ticket, testsReady: true });
    await this.tracker.comment(id, `**${role}** marked the blind QA tests ready.${note ? `\n\n${note}` : ''}`);
    this.emit({ kind: 'mark', ticket: id, role });
    return saved;
  }

  // A passed gate is recorded on the ticket. A failed blocking gate sends the ticket back.
  async recordGate(id: number, gate: Gate, result: GateResult, role: Role, reason?: string, note?: string): Promise<Ticket> {
    const ticket = await this.tracker.get(id);
    check(canRecordGate(ticket, gate, result, role, reason));
    this.emit({ kind: 'gate', ticket: id, role, gate, result, reason });
    if (result === 'fail') {
      return this.move(id, { to: 'building', role, reason, note: `The ${gate} gate failed.${note ? `\n\n${note}` : ''}` });
    }
    const saved = await this.tracker.update({ ...ticket, gates: { ...ticket.gates, [gate]: 'pass' } });
    await this.tracker.comment(id, `**${role}** passed the \`${gate}\` gate.${note ? `\n\n${note}` : ''}`);
    return saved;
  }

  async specStatus(id: number): Promise<SpecStatus> {
    const spec = await this.tracker.get(id);
    if (spec.type !== 'spec') throw new RuleError(`#${id} is not a spec`);
    return specStatus(spec, await this.tracker.list({ includeClosed: true }));
  }

  async closeSpec(id: number, role: Role): Promise<Ticket> {
    const spec = await this.tracker.get(id);
    check(canCloseSpec(spec, await this.tracker.list({ includeClosed: true }), role));
    const saved = await this.tracker.update({ ...spec, state: 'done', closed: true });
    await this.tracker.comment(id, `**${role}** closed this spec: every criterion is covered and every ticket is done.`);
    this.emit({ kind: 'close-spec', ticket: id, role, from: spec.state, to: 'done' });
    return saved;
  }

  async next(limit?: number): Promise<Ticket[]> {
    return pickReady(await this.tracker.list({ includeClosed: true }), limit);
  }

  private async openBlockers(ticket: Ticket): Promise<number[]> {
    const open: number[] = [];
    for (const b of ticket.blockedBy) {
      const t = await this.tracker.get(b).catch(() => undefined);
      if (!t || !(t.closed || t.state === 'done')) open.push(b);
    }
    return open;
  }
}
