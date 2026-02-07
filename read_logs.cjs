const fs = require('fs');
const fd = fs.openSync('server/logs/orchestrator/metrics_20260207.jsonl', 'r');
const size = fs.fstatSync(fd).size;
const buffer = Buffer.alloc(4096);
fs.readSync(fd, buffer, 0, 4096, Math.max(0, size - 4096));
const content = buffer.toString('utf8');
const lines = content.trim().split('\n');
// Take last 3 meaningful lines
const last3 = lines.slice(-3);
console.log(JSON.stringify(last3, null, 2));
