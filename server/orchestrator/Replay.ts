import * as fs from 'fs';
import * as crypto from 'crypto';
import { Orchestrator } from './Orchestrator';

type LogLine = {
  canonical_time_ms?: number;
  event_time_ms?: number;
  symbol: string;
  [k: string]: any;
};

export interface ReplayResult {
  decisionHash: string;
  finalStateHash: string;
}

export class ReplayRunner {
  constructor(private readonly orchestrator: Orchestrator) {}

  async replayFromFiles(metricsPath: string, executionPath: string): Promise<ReplayResult> {
    this.orchestrator.resetForReplay();

    const metrics = this.readJsonl(metricsPath);
    const execution = this.readJsonl(executionPath);

    const merged = [
      ...metrics.map((m) => ({
        kind: 'metrics' as const,
        event_time_ms: Number(m.canonical_time_ms || m.event_time_ms || 0),
        payload: m,
      })),
      ...execution.map((e) => ({ kind: 'execution' as const, event_time_ms: Number(e.event_time_ms || 0), payload: e })),
    ].sort((a, b) => a.event_time_ms - b.event_time_ms);

    for (const item of merged) {
      if (item.kind === 'metrics') {
        if (item.payload.metrics && item.payload.gate) {
          this.orchestrator.ingestLoggedMetrics({
            symbol: item.payload.symbol,
            canonical_time_ms: Number(item.payload.canonical_time_ms || item.payload.event_time_ms || 0),
            exchange_event_time_ms: item.payload.exchange_event_time_ms ?? item.payload.metrics?.exchange_event_time_ms ?? null,
            metrics: item.payload.metrics,
            gate: item.payload.gate,
          });
        } else {
          this.orchestrator.ingest(item.payload);
        }
      } else {
        const execution = item.payload.event ? item.payload.event : item.payload;
        if (execution && execution.type && execution.symbol) {
          this.orchestrator.ingestExecutionReplay(execution);
        }
      }
    }

    await this.orchestrator.flush();

    const decisionHash = this.hashObject(this.orchestrator.getDecisionLedger());
    const finalStateHash = this.hashObject(this.orchestrator.getStateSnapshot());
    return { decisionHash, finalStateHash };
  }

  private readJsonl(filePath: string): LogLine[] {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  }

  private hashObject(input: any): string {
    const normalized = this.stableSerialize(input);
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  private stableSerialize(value: any): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      return `[${value.map((v) => this.stableSerialize(v)).join(',')}]`;
    }

    const keys = Object.keys(value).sort();
    const chunks = keys.map((k) => `${JSON.stringify(k)}:${this.stableSerialize(value[k])}`);
    return `{${chunks.join(',')}}`;
  }
}
