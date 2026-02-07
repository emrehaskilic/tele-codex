const fs = require('fs');
const path = require('path');

const logFile = path.resolve(__dirname, 'server/logs/orchestrator/metrics_20260207.jsonl');
const fd = fs.openSync(logFile, 'r');
const size = fs.fstatSync(fd).size;
const buffer = Buffer.alloc(size > 20000 ? 20000 : size);
fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
const content = buffer.toString('utf8');
const lines = content.trim().split('\n').filter(l => l.trim());

const lastLine = lines.slice(-1)[0];
console.log(lastLine);
