/**
 * desk/net.mjs — making Node's fetch use the environment's proxy.
 *
 * Why this exists. In the cloud container every outbound request goes through
 * a proxy named in HTTPS_PROXY, and Node's built-in fetch ignores that variable
 * unless NODE_USE_ENV_PROXY=1 was set when the process started: without it,
 * every request fails with ENOTFOUND. The variable cannot be turned on from
 * inside a running process, so a command that needs the network runs itself
 * again with it set and exits with the child's status. desk.mjs and replay.mjs
 * each carried a copy of this; the history and learning commands need it too.
 *
 * Under test, $SCALP_DESK_BARS (a JSON file of bars per instrument) stands in
 * for every feed, so nothing is fetched and nothing is re-run.
 */
import { spawnSync } from 'node:child_process';

/**
 * Re-runs this process with NODE_USE_ENV_PROXY=1 when it would need it, and
 * never returns in that case. `when` lets a command decide (desk.mjs only
 * re-runs its network commands); the rest of the conditions are always checked.
 */
export function ensureProxy({ when = true, env = process.env } = {}) {
  if (!when || env.SCALP_DESK_BARS || !(env.HTTPS_PROXY || env.https_proxy) || env.NODE_USE_ENV_PROXY) return;
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit', env: { ...env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
  });
  process.exit(r.status ?? 1);
}
