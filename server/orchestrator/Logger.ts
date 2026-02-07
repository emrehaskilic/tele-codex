import * as fs from 'fs';
import * as path from 'path';

type LogKind = 'metrics' | 'execution' | 'decision';

type QueueItem = {
  kind: LogKind;
  eventTimeMs: number;
  payload: any;
};

export interface OrchestratorLoggerConfig {
  dir: string;
  queueLimit: number;
  dropHaltThreshold: number;
  onDropSpike: (dropCount: number) => void;
}

export class OrchestratorLogger {
  private readonly queue: QueueItem[] = [];
  private readonly streams = new Map<string, fs.WriteStream>();
  private flushing = false;
  private dropCount = 0;
  private dropWindowCount = 0;

  constructor(private readonly config: OrchestratorLoggerConfig) {
    fs.mkdirSync(config.dir, { recursive: true });
    setInterval(() => {
      if (this.dropWindowCount >= this.config.dropHaltThreshold) {
        this.config.onDropSpike(this.dropWindowCount);
      }
      this.dropWindowCount = 0;
    }, 10_000);
  }

  logMetrics(eventTimeMs: number, payload: any) {
    this.enqueue({ kind: 'metrics', eventTimeMs, payload });
  }

  logExecution(eventTimeMs: number, payload: any) {
    this.enqueue({ kind: 'execution', eventTimeMs, payload });
  }

  logDecision(eventTimeMs: number, payload: any) {
    this.enqueue({ kind: 'decision', eventTimeMs, payload });
  }

  shutdown() {
    for (const stream of this.streams.values()) {
      stream.end();
    }
    this.streams.clear();
  }

  private enqueue(item: QueueItem) {
    if (this.queue.length >= this.config.queueLimit) {
      this.dropCount++;
      this.dropWindowCount++;
      return;
    }

    this.queue.push(item);
    if (!this.flushing) {
      this.flushing = true;
      setImmediate(() => this.flush());
    }
  }

  private flush() {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const line = JSON.stringify(item.payload) + '\n';
      const stream = this.getStream(item.kind, item.eventTimeMs);
      const ok = stream.write(line);
      if (!ok && this.queue.length < this.config.queueLimit) {
        this.queue.unshift(item);
        stream.once('drain', () => this.flush());
        this.flushing = false;
        return;
      }
    }

    this.flushing = false;
  }

  private getStream(kind: LogKind, eventTimeMs: number): fs.WriteStream {
    const date = this.dateToken(eventTimeMs);
    const key = `${kind}:${date}`;
    const existing = this.streams.get(key);
    if (existing) {
      return existing;
    }

    const filePath = path.join(this.config.dir, `${kind}_${date}.jsonl`);
    const stream = fs.createWriteStream(filePath, { flags: 'a' });
    this.streams.set(key, stream);
    return stream;
  }

  private dateToken(eventTimeMs: number): string {
    const d = new Date(eventTimeMs);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  }
}
