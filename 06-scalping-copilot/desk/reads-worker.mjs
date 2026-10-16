/**
 * desk/reads-worker.mjs — one worker thread of computeReads() (desk/reads.mjs).
 *
 * It parses the bar file itself (sending 320,000 bars to every worker would
 * cost more than parsing them), then answers chunks of check indices with
 * their reads until told it is done. Nothing in it decides anything: each
 * read is readAt(), the same function the single-process path calls.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { loadBarsFile, readRange, extraFor } from './reads.mjs';

const { file, opts } = workerData;
try {
  const bars = loadBarsFile(file, opts.pair);
  const extra = await extraFor(opts);
  parentPort.on('message', (m) => {
    if (m.done) { parentPort.close(); return; }
    try {
      parentPort.postMessage({ id: m.id, reads: readRange(bars, m.ks, { ...opts, extra }) });
    } catch (e) {
      parentPort.postMessage({ error: e.stack || String(e) });
    }
  });
  parentPort.postMessage({ ready: true });
} catch (e) {
  parentPort.postMessage({ error: e.stack || String(e) });
}
