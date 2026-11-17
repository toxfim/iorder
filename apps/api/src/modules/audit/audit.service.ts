import { Injectable } from '@nestjs/common';
import { Clock } from '../../common/clock/clock.js';
import type { Tx } from '../../common/database/db-client.js';
import { AuditRepository, type AuditRow } from './audit.repository.js';
import type { AuditChanges, AuditEntry, AuditValue, SystemAuditEntry } from './audit.types.js';

@Injectable()
export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * Writes an audit row through the CALLER'S transaction (a branded `Tx`, so the plain client
   * does not compile): the change and its record commit or roll back together, and an action
   * that cannot be recorded does not happen. The actor must be the authenticated actor and the
   * time comes from the Clock; neither may come from request input.
   */
  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    await this.repository.insert(tx, entry, this.clock.now());
  }

  /** The only way to write a NULL-actor row: system actions such as the sheet sync. */
  async recordSystem(tx: Tx, entry: SystemAuditEntry): Promise<void> {
    await this.repository.insert(tx, toSystemRow(entry), this.clock.now());
  }

  /** Batched `recordSystem` for bulk syncs: one INSERT for the whole batch, one timestamp. */
  async recordSystemMany(tx: Tx, entries: readonly SystemAuditEntry[]): Promise<void> {
    await this.repository.insertMany(tx, entries.map(toSystemRow), this.clock.now());
  }
}

function toSystemRow(entry: SystemAuditEntry): AuditRow {
  return {
    actorUserId: null,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    changes: entry.changes,
  };
}

/** Builds before/after pairs for the fields that really changed; unchanged fields are omitted. */
export function diffFields(
  before: Readonly<Record<string, AuditValue>>,
  after: Readonly<Record<string, AuditValue>>,
): AuditChanges {
  const changes: AuditChanges = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
  }
  return changes;
}
