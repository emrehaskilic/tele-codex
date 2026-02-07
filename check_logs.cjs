const fs = require('fs');
const path = require('path');

const logFile = path.resolve(__dirname, 'server/logs/orchestrator/metrics_20260207.jsonl');
const fd = fs.openSync(logFile, 'r');
const size = fs.fstatSync(fd).size;
const buffer = Buffer.alloc(20000); // Read last 20KB
fs.readSync(fd, buffer, 0, 20000, Math.max(0, size - 20000));
const content = buffer.toString('utf8');
const lines = content.trim().split('\n').filter(l => l.trim());
// Get valid JSON lines only (skip potentially partial first line)
const logs = lines.slice(1).map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
}).filter(Boolean);

const last3 = logs.slice(-3);

last3.forEach(entry => {
    console.log('--- LOG ENTRY ---');
    console.log(`Mode: ${entry.gate?.mode || 'N/A'}`);
    console.log(`Reason: ${entry.gate?.reason || 'OK'}`);
    console.log(`Network Latency: ${entry.gate?.network_latency_ms}`);
    console.log(`Canonical Time: ${entry.canonical_time_ms}`);
    console.log(`Full Gate: ${JSON.stringify(entry.gate)}`);

    // Validation
    if (entry.gate?.mode !== 'V1_NO_LATENCY') {
        console.error('FAIL: Mode mismatch');
    }

    const forbidden = ['latency_too_high', 'network_latency_too_high', 'avg_latency', 'processing_latency'];
    if (forbidden.includes(entry.gate?.reason)) {
        console.error(`FAIL: Forbidden reason: ${entry.gate.reason}`);
    }

    if (entry.metrics?.network_latency_ms != null) {
        console.error('FAIL: network_latency_ms is present');
    }
});
