const fs = require('fs');

const content = fs.readFileSync('temp_metrics_log.txt', 'utf8');
const lines = content.trim().split('\n').filter(Boolean);

const analysis = {};

lines.forEach(line => {
    let entry;
    try {
        entry = JSON.parse(line);
    } catch (e) {
        return;
    }

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
            obiDeep: { min: 1, max: -1, last: 0 },
            deltaZ: { min: 100, max: -100, last: 0 },
            cvdSlope: { min: 100, max: -100, last: 0 },
            latencies: 0,
            timestamps: []
        };
    }

    const st = analysis[s];
    st.count++;
    st.timestamps.push(entry.canonical_time_ms);

    // Canonical Check
    if (entry.canonical_time_ms <= st.lastCanonical && st.count > 1) {
        st.monotonic = false;
    }
    st.lastCanonical = entry.canonical_time_ms;

    // Metrics Check
    if (entry.metrics?.prints_per_second > 0) st.printsGtZero++;
    if (entry.metrics?.spread_pct > 0) st.spreadGtZero++;
    if (entry.metrics?.best_bid < entry.metrics?.best_ask) st.validBidAsp++;

    // Gate Check
    if (entry.gate?.passed) st.gatePassed++;
    if (entry.gate?.reason) {
        st.reasons[entry.gate.reason] = (st.reasons[entry.gate.reason] || 0) + 1;
    }

    // Mathematical Health
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


// Report
console.log('--- ANALYSIS ---');
Object.keys(analysis).forEach(sym => {
    const s = analysis[sym];
    console.log(`Symbol: ${sym}`);
    console.log(`  Count: ${s.count}`);
    console.log(`  Last Canonical: ${s.lastCanonical}`);
    console.log(`  Monotonic: ${s.monotonic}`);
    console.log(`  Prints > 0: ${s.printsGtZero}`);
    console.log(`  Spread > 0: ${s.spreadGtZero}`);
    console.log(`  Gate Passed: ${s.gatePassed}/${s.count} (${(s.gatePassed / s.count * 100).toFixed(1)}%)`);
    console.log(`  Fail Reasons: ${JSON.stringify(s.reasons)}`);
    console.log(`  OBI Deep: [${s.obiDeep.min.toFixed(4)}, ${s.obiDeep.max.toFixed(4)}] Last: ${s.obiDeep.last.toFixed(4)}`);
    console.log(`  Delta Z: [${s.deltaZ.min.toFixed(4)}, ${s.deltaZ.max.toFixed(4)}] Last: ${s.deltaZ.last.toFixed(4)}`);
    console.log(`  CVD Slope: [${s.cvdSlope.min.toFixed(4)}, ${s.cvdSlope.max.toFixed(4)}] Last: ${s.cvdSlope.last.toFixed(4)}`);

    // Rate check
    if (s.timestamps.length > 1) {
        const duration = s.timestamps[s.timestamps.length - 1] - s.timestamps[0];
        const rate = (s.count / (duration / 1000)).toFixed(2);
        console.log(`  Rate: ${rate} events/sec`);
    }
    console.log('');
});
