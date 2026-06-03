export interface AuditWriter {
  write(eventType: string, payload: Record<string, unknown>): Promise<void>;
}

export class NoopAuditWriter implements AuditWriter {
  async write(): Promise<void> {}
}

export class RepositoryAuditWriter implements AuditWriter {
  constructor(private readonly writeAudit: (eventType: string, payload: Record<string, unknown>) => Promise<void>) {}

  async write(eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.writeAudit(eventType, payload);
  }
}
