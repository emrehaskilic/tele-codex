const fs = require('fs');

// Read the actual log file directly, taking last ~20KB
const logFile = 'server/logs/orchestrator/metrics_20260207.jsonl';
const stats = fs.statSync(logFile);
const bufferSize = Math.min(stats.size, 100000); // 100KB
const buffer = Buffer.alloc(bufferSize);
const fd = fs.openSync(logFile, 'r');
fs.readSync(fd, buffer, 0, bufferSize, stats.size - bufferSize);
fs.closeSync(fd);

const content = buffer.toString('utf8');
const lines = content.trim().split('\n').filter(Boolean);
// Skip first line if partial
const validLines = lines.slice(1).map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
}).filter(Boolean);

// Analyze only last 100
const dataset = validLines.slice(-100);

const analysis = {};
dataset.forEach(entry => {
    const s = entry.symbol || 'UNKNOWN';
    if (!analysis[s]) {
        analysis[s] = {
            count: 0,
            lastCanonical: 0,
            monotonic: true,
            printsGtZero: 0,
            spreadGtZero: 0,
            validBidAsp: 0,
            gatePassed: 0,
            reasons: {},
            obiDeep: { min: 999, max: -999, last: 0 },
            deltaZ: { min: 999, max: -999, last: 0 },
            cvdSlope: { min: 999, max: -999, last: 0 },
            timestamps: []
        };
    }
    const st = analysis[s];
    st.count++;
    st.timestamps.push(entry.canonical_time_ms);

    // Checks
    if (entry.canonical_time_ms <= st.lastCanonical && st.count > 1) st.monotonic = false;
    st.lastCanonical = entry.canonical_time_ms;

    if (entry.metrics?.prints_per_second > 0) st.printsGtZero++;
    if (entry.metrics?.spread_pct > 0) st.spreadGtZero++;
    if (entry.metrics?.best_bid < entry.metrics?.best_ask) st.validBidAsp++;

    if (entry.gate?.passed) st.gatePassed++;
    else if (entry.gate?.reason) st.reasons[entry.gate.reason] = (st.reasons[entry.gate.reason] || 0) + 1;

    if (entry.metrics?.legacyMetrics) {
        const m = entry.metrics.legacyMetrics;
        st.obiDeep.min = Math.min(st.obiDeep.min, m.obiDeep);
        st.obiDeep.max = Math.max(st.obiDeep.max, m.obiDeep);
        st.obiDeep.last = m.obiDeep;

        st.deltaZ.min = Math.min(st.deltaZ.min, m.deltaZ);
        st.deltaZ.max = Math.max(st.deltaZ.max, m.deltaZ);
        st.deltaZ.last = m.deltaZ;

        st.cvdSlope.min = Math.min(st.cvdSlope.min, m.cvdSlope);
        st.cvdSlope.max = Math.max(st.cvdSlope.max, m.cvdSlope);
        st.cvdSlope.last = m.cvdSlope;
    }
});

console.log('--- ANALYSIS REPORT ---');
Object.keys(analysis).forEach(sym => {
    const s = analysis[sym];
    const duration = (s.timestamps[s.timestamps.length - 1] - s.timestamps[0]) / 1000;
    const rate = duration > 0 ? (s.count / duration).toFixed(2) : 0;

    console.log(`Symbol: ${sym}`);
    console.log(`  Count: ${s.count}`);
    console.log(`  Monotonic: ${s.monotonic}`);
    console.log(`  Prints>0: ${s.printsGtZero}/${s.count}`);
    console.log(`  Spread>0: ${s.spreadGtZero}/${s.count}`);
    console.log(`  ValidBidAsk: ${s.validBidAsp}/${s.count}`);
    console.log(`  Gate Pass: ${s.gatePassed}/${s.count} (${(s.gatePassed / s.count * 100).toFixed(1)}%)`);
    console.log(`  Fail Reasons: ${JSON.stringify(s.reasons)}`);
    console.log(`  OBI Deep: [${s.obiDeep.min.toFixed(3)}, ${s.obiDeep.max.toFixed(3)}] Last: ${s.obiDeep.last.toFixed(3)}`);
    console.log(`  Delta Z: [${s.deltaZ.min.toFixed(3)}, ${s.deltaZ.max.toFixed(3)}] Last: ${s.deltaZ.last.toFixed(3)}`);
    console.log(`  CVD Slope: [${s.cvdSlope.min.toFixed(3)}, ${s.cvdSlope.max.toFixed(3)}] Last: ${s.cvdSlope.last.toFixed(3)}`);
    console.log(`  Rate: ${rate} evt/sec`);
    console.log('');
});
