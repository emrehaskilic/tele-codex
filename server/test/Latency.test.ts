// Regression test: TimeAndSales should compute without latency fields.
function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

import { TimeAndSales } from '../metrics/TimeAndSales';

export function runTests() {
  const tas = new TimeAndSales(10_000);
  const now = Date.now();
  tas.addTrade({ price: 100, quantity: 1, side: 'buy', timestamp: now + 10_000 });
  const metrics = tas.computeMetrics();
  assert(typeof metrics.printsPerSecond === 'number', 'printsPerSecond should be present');
  assert(!Object.prototype.hasOwnProperty.call(metrics, 'avgLatencyMs'), 'avgLatencyMs must not exist');
}
