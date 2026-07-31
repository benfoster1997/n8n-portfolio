/**
 * Stands in for Slack while demonstrating the pipeline.
 *
 * Prints whatever the pipeline delivers, and returns 200. Nothing to install,
 * no account, no external service.
 *
 *   node 03-reliable-pipeline/demo-sink.mjs
 *
 * In production the pipeline posts to a real Slack incoming webhook instead and
 * this file is irrelevant.
 */
import { createServer } from 'node:http';

const PORT = 4567;

createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    try {
      const { text } = JSON.parse(body || '{}');
      console.log(`→ delivered: ${text ?? body}`);
    } catch {
      console.log(`→ delivered (unparsed): ${body}`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
}).listen(PORT, () => console.log(`demo sink listening on http://localhost:${PORT}`));
