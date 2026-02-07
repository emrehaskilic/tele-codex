const fs = require('fs');

const content = fs.readFileSync('temp_metrics_log.txt', 'utf8');
const lines = content.trim().split('\n').map(l => {
    try {
        return JSON.parse(l);
    } catch (e) {
        return null;
    }
}).filter(Boolean);

const stats = {};

lines.forEach(entry => {
    const s = entry.symbol;
    if (!stats[s]) {
        stats[s] = {
            count: 0,
            lastCanonical: 0,
            canonicalMonotonic: true,
            printsGtZero: 0,
            spreadGtZero: 0,
            bidAskOrder: 0,
            failedReasons: {},
            passedCount: 0,
            obiDeepVals: [],
            deltaZVals: [],
            cvdSlopeVals: [],
            timestamps: []
        };
    }

    const st = stats[s];
    st.count++;
    st.timestamps.push(entry.canonical_time_ms);

    // Canonical time check
    if (entry.canonical_time_ms <= st.lastCanonical && st.count > 1) {
        st.canonicalMonotonic = false;
    }
    st.lastCanonical = entry.canonical_time_ms;

    // Source of Truth
    if (entry.metrics.prints_per_second > 0) st.printsGtZero++;
    if (entry.metrics.spread_pct > 0) st.spreadGtZero++;
    if (entry.metrics.best_bid < entry.metrics.best_ask) st.bidAskOrder++;

    // Health
    if (entry.metrics.legacyMetrics) {
        st.obiDeepVals.push(entry.metrics.legacyMetrics.obiDeep);
        st.deltaZVals.push(entry.metrics.legacyMetrics.deltaZ);
        st.cvdSlopeVals.push(entry.metrics.legacyMetrics.cvdSlope);
    }

    // Gate
    if (entry.gate.passed) st.passedCount++;
    if (entry.gate.reason) {
        st.failedReasons[entry.gate.reason] = (st.failedReasons[entry.gate.reason] || 0) + 1;
    }
});

console.log(JSON.stringify(stats, null, 2));
