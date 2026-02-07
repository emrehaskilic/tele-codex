// Aggregated test entry point for server metrics.
// This file imports individual test modules.  Each imported module
// executes its own runTests function on load.
import * as TimeAndSalesTests from './TimeAndSales.test';
import * as CvdTests from './CvdCalculator.test';
import * as AbsorptionTests from './AbsorptionDetector.test';
import * as OrderbookTests from './OrderbookManager.test';
import * as OIMonitorTests from './OpenInterestMonitor.test';
import * as FundingTests from './FundingMonitor.test';

// Additional tests will be imported here
import * as LatencyTests from './Latency.test';
import * as SequenceRuleTests from './SequenceRule.test';
import * as ReconnectTests from './ReconnectContinuity.test';
import * as LegacyTests from './LegacyCalculator.test';
import * as GateTests from './Gate.test';

// Minimal test harness: runs each runTests() and prints summary
const testSuites: { name: string; fn: () => void }[] = [
  { name: 'TimeAndSales', fn: TimeAndSalesTests.runTests },
  { name: 'CvdCalculator', fn: CvdTests.runTests },
  { name: 'AbsorptionDetector', fn: AbsorptionTests.runTests },
  { name: 'OrderbookManager', fn: OrderbookTests.runTests },
  { name: 'OpenInterestMonitor', fn: OIMonitorTests.runTests },
  { name: 'FundingMonitor', fn: FundingTests.runTests },
  { name: 'LatencyClamp', fn: LatencyTests.runTests },
  { name: 'SequenceRule', fn: SequenceRuleTests.runTests },
  { name: 'ReconnectContinuity', fn: ReconnectTests.runTests },
  { name: 'LegacyCalculator', fn: LegacyTests.runTests },
  { name: 'Gate', fn: GateTests.runTests },
];

let total = 0;
let passed = 0;
for (const suite of testSuites) {
  total++;
  try {
    suite.fn();
    passed++;
    console.log(`PASS ${suite.name}`);
  } catch (e: any) {
    console.error(`FAIL ${suite.name}: ${e.message}`);
  }
}
console.log(`OK ${passed}/${total}`);
