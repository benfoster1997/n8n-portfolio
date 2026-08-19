# RUNBOOK — n8n SQLite off the virtiofs bind mount, verified backups, and a real external health check

> # ✅ EXECUTED 19 August 2026, 07:26–07:31 BST. **Total downtime: 3 minutes.**
>
> Ben approved it ("do it now"). Ran Part 0 + Part 1. **Every gate passed; nothing was rolled back.**
>
> | Phase | Result |
> |---|---|
> | 0.1 | `docker-compose.yml.pre-volume-19aug` written — this is the rollback artefact |
> | **0.5** | **`/opt/homebrew/bin/n8n` → `n8n.DISABLED`.** ⭐ See the finding below — this may matter more than the volume |
> | 0.6 | `start-n8n.sh` → `.RETIRED-19aug` (it would have started a SECOND n8n on 5678 against `.n8n-data`) |
> | 0.7 | Pre-flight: exec 78 `success` at 07:20:09, 0 failures. Monitor alive before anything was touched |
> | B1 | `compose stop -t 60` → `Exited (0)` in under a second |
> | B2 | `n8n-predvolume-20260819T072649.tgz` (1.6 MB, includes the sidecars as-found) |
> | B3 | Cold backup **proved by query**: integrity ok · wf_rows 1 · **live_code 1** · creds 0 · seen 53 · notifyCount 6 · dlq 7 · lastPollAt `1787120409405` · exec 78. `config` hash identical, mode `600` |
> | B4 | ⚠️ `-wal` was **865 KB**, not empty — checkpointed from a throwaway container: `CKPT busy:0`, `INTEGRITY ok`, both sidecars then gone |
> | B5 | Post-checkpoint content **byte-for-byte identical** to the cold baseline |
> | C1 | `n8n_data` created → `/var/lib/docker/volumes/n8n_data/_data` |
> | C2 | tar out / tar in, two gated steps, `chown -R 1000:1000` |
> | C3 | **file counts 8 = 8 · byte totals 8,300,213 = 8,300,213** · config `-rw------- 1000 1000` · hash matches |
> | C4 | Volume DB content **identical to the cold baseline** |
> | D1–D2 | New compose written, `YAML_OK`, `up -d` recreated the container |
> | **E1** | **0 virtiofs mounts inside the container.** `docker inspect` → `Type: volume` |
> | **E3** | integrity ok · active=1 · `ebf1de74` · **live_code 1** · seen 53 · notifyCount 6 · dlq 7 · failStreak 0 |
> | **E6** | ⭐ **Poll 79 landed 07:30:09 on the boundary, `success`** — `lastPollAt` advanced exactly 10 min from baseline. **0 SQLite errors** |
>
> ## ⛔ D-2 (raise the VM to 4 GB) was DELIBERATELY SKIPPED — and the runbook's advice was wrong for this machine
>
> **The host has 8 GB of RAM and 6 CPUs.** Giving the VM 4 GB takes half the machine while Chrome,
> Claude and Blender are also running — trading a *speculative* OOM for **real host swapping**.
> And there is no pressure to relieve: the VM was using **265 MB of 1959 MB with 1694 MB available**.
> ▶️ **Revisit only if memory pressure is ever actually measured.** The runbook recommended 4 GB
> without knowing host RAM. 🔑 **A sizing recommendation made without the host's total is not advice.**
>
> ## ⭐ THE FINDING THAT MAY MATTER MORE THAN THE MIGRATION
>
> **`/opt/homebrew/bin/n8n` existed — a HOST install of n8n 2.32.6, dated 30 July — and it defaults
> to `~/.n8n/database.sqlite`, the exact file the container held open.** Any host `n8n` invocation
> would open the live WAL database as a **second writer from the other side of the virtiofs boundary**.
>
> ⚠️ **"virtiofs corrupts SQLite" is NOT established.** A two-writer probe *on the virtiofs mount*
> (400 transactions, WAL) completed with `integrity_check ok`. **Two hypotheses survive** — cross-
> boundary `-shm` incoherence, and this host binary — and there is no evidence which caused 18 Aug.
> ⛔ **Do not record the virtiofs explanation as settled.** The migration closes both paths, which is
> why it was worth doing, but it did not prove either one.
>
> ## ✅ SECOND CHANGE, made separately so a regression has one suspect
>
> `N8N_EVENTBUS_LOGWRITER_LOGFULLPATH=/eventlog/n8nEventLog.log` + a bind mount at
> `/Users/aiwork/n8n-eventlog`. **The event log is the only liveness signal outside the database**,
> and the volume move had just hidden it from the host. An append-only text file is safe on virtiofs;
> only SQLite had to leave.
> ⚠️ n8n warns on every start that the old logs still exist inside the volume and *"may contain unsent
> events"*. **They were left in place** rather than deleting data mid-migration. Cosmetic; follow-up.
>
> ## 🔑 What is now true, and what still is not
>
> ✅ `/Users/aiwork/.n8n` is **untouched and is the rollback copy** — `cp` the pristine compose back
> and `up -d`, under 60 seconds.
> ⛔ **`healthz`/`readiness` prove almost nothing** — they ping `SELECT 1`, which touches no btree
> page, so **they answer 200 through a corrupted database.** Only a landed poll is evidence.
> ⛔ **The database is still not crash-proof.** The guest ext4 lives in a sparse disk image on APFS.
> **Always `colima stop`; never kill the VM.**


**Machine:** this Mac (darwin 27.0, Colima `vz`/virtiofs, Docker context `colima`)
**Written:** 19 Aug 2026. **Nothing below has been executed.**
**Timing:** Part 0 is zero-downtime and can run any time. **Do not begin Part 1 after 11:30 BST today** — the 12:00 LinkedIn/Buffer task is unrelated, but do not have two things in flight.

---

## §0. WHAT IS ESTABLISHED, AND WHAT IS NOT

**Established on this machine:**
- `/Users/aiwork` is mounted in the lima VM as `virtiofs`, with DAX **off** (`virtio_fs_setup_dax: No cache capability`). Guest and host therefore do not share one physical page for an `mmap`'d file, which is what SQLite's `-shm` wal-index requires.
- `/var/lib/docker` is `ext4` on `/dev/vdb1` **inside the VM**. A Docker named volume therefore has no virtiofs in its path. **Part 1 Phase A0 falsifies this before you take any downtime — do not trust it on my word.**
- n8n 2.32.6 hardcodes `enableWAL: true` with `poolSize: 3`. There is no env var to turn WAL off in 2.x (`DB_SQLITE_POOL_SIZE=0` is stale 1.x guidance; the schema is now `.gte(1)`).
- `/healthz/readiness` pings with `SELECT 1`, which touches no btree page. **It answers 200 through a corrupted database.** Readiness is necessary, never sufficient.
- `/opt/homebrew/bin/n8n` is a global host install of n8n 2.32.6 which defaults to `~/.n8n/database.sqlite` — the exact file the container holds open. A second process opening a WAL database across that boundary is textbook incoherent-`-shm` corruption.

**Not established:**
- That virtiofs alone corrupts SQLite. A two-writer probe **on the virtiofs mount** (400 txns, WAL) completed with `integrity_check ok`. The named volume is still the right destination, but "virtiofs is broken for SQLite" is **not** proven and must not go into the record as settled.
- Which of the two candidate mechanisms (cross-boundary `-shm` incoherence vs. the host binary being run as a second writer) caused the 18 Aug evening corruption. There is no shell-history evidence the host binary fired, but tool-driven Bash calls do not write zsh history, so it is not excluded.
- Whether `kern.waketime` advances on DarkWake. The watchdog is built so this does not matter; a probe to settle it is in §2.6 T6.

**Things this runbook deliberately refuses to do:**
- Hardcode any expected count of `seenTopics`, `notifyCount`, `dlq`, `credentials_entity`, or `lastPollAt`. **Every baseline is captured live, in Phase A, minutes before it is compared.** Numbers written down yesterday are the single most dangerous thing in a migration runbook: the DB's main file has not been checkpointed since 18 Aug 19:22, so a stale baseline and a total loss of the WAL are the *same* set of numbers.

---

## DECISIONS THE OPERATOR MUST MAKE FIRST

| # | Decision | Recommendation |
|---|---|---|
| **D-1** | **Migrate today, or run Part 0 only and observe 72 h first?** Part 0 removes the second-writer hypothesis with zero downtime and no rollback. If you then wait and corruption recurs, you have falsified it. If you migrate immediately you fix both mechanisms but learn nothing. | **Do Part 0 now, then migrate today.** Rollback is a `cp` and 60 seconds, the outage is ~6 minutes, and the volume subsumes Part 0's protection permanently rather than depending on a `mv` nobody remembers. If you would rather buy information than certainty, Part 0 alone is a defensible stopping point — say so out loud and set a calendar note for 22 Aug. |
| **D-2** | **Bump the VM from ~2 GB / no swap to 4 GB in the same outage?** The VM has `Mem: 1959 MB total, Swap: 0`. An OOM kill mid-checkpoint tears a write on ext4 exactly as on virtiofs. | **Yes — as Phase C0, after the cold backup is proven and before the cutover.** It costs no extra downtime (you are already stopped) and removes a corruption vector the volume does nothing about. Skip only if you are nervous about `colima start` on an unfamiliar day. |
| **D-3** | **Heartbeat file, or the executions-API probe, as the freshness signal?** They are mutually exclusive with follow-up F1 (`EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`). | **Heartbeat file.** It survives F1, survives the DB being unreadable, and needs no API key. Use the API probe only as a stopgap if you will not touch the workflow today. |
| **D-4** | **Add an off-box dead-man's switch** (healthchecks.io free tier or equivalent) so that the watchdog's own death is detectable? The watchdog cannot page you about itself. | **Yes.** Create one check with a 45-minute grace and drop the ping URL in `etc/deadman-url`. Without it, "watchdog fine" and "watchdog dead" look identical: silence. The script works with or without it. |
| **D-5** | **Neutralise `/opt/homebrew/bin/n8n` today?** | **Yes, in Part 0.** It is one `mv`, reversible, and post-migration `/Users/aiwork/.n8n` becomes your rollback copy — a stray host `n8n` would silently mutate the one artifact recovery depends on. |
| **D-6** | **Same ntfy topic for the watchdog as the monitor, or a separate one?** | **Same topic.** Your phone is already subscribed to it. A watchdog alert on a topic you are not watching is not an alert. |
| **D-7** | **Retire the in-workflow canary now or later?** | **Later — after the external watchdog has survived one full sleep cycle and one T1 pass (§2.7).** Two mediocre checks beat zero checks during a migration. |

---

# PART 0 — ZERO-DOWNTIME HARDENING (do this first, regardless of D-1)

Nothing in Part 0 stops the container or touches the database.

## 0.1 Scratch directory and pristine compose copy

```bash
mkdir -p /Users/aiwork/n8n-migrate
cp -p /Users/aiwork/n8n-docker/docker-compose.yml \
      /Users/aiwork/n8n-docker/docker-compose.yml.pre-volume-19aug
ls -la /Users/aiwork/n8n-docker/docker-compose.yml*
```
**Expected:** both files listed, identical sizes.
**If it fails:** stop. Rollback in Part 1 is defined as copying this file back; without it you would be hand-editing YAML under pressure.

> ⚠️ **All scratch work lives under `/Users/aiwork`.** That is the *only* host path shared into the lima VM (`mounts: []` in `~/.colima/default/colima.yaml` plus the `/Users/aiwork` share). A `docker run -v /tmp/...:/out` **creates the directory inside the VM**, the container writes there, prints success, and the host path stays empty — and a later `sqlite3` against that missing file **creates an empty database and prints `ok`**. Never bind-mount `/tmp` in this runbook.

## 0.2 The inspection tool — one script, used for every comparison

Write `/Users/aiwork/n8n-migrate/inspect.sh`:

```sh
#!/bin/sh
# inspect.sh <path-to-a-COPY-of-database.sqlite>
# NEVER point this at /Users/aiwork/.n8n/database.sqlite while the container runs.
set -u
DB="$1"
[ -f "$DB" ] || { echo "FATAL: $DB does not exist"; exit 2; }
printf 'file        : %s\n' "$DB"
printf 'bytes       : %s\n' "$(wc -c < "$DB" | tr -d ' ')"
printf 'integrity   : '; sqlite3 "$DB" 'PRAGMA integrity_check;' | head -1
printf 'wf_rows     : '; sqlite3 "$DB" 'SELECT count(*) FROM workflow_entity;'
printf 'wf          : '; sqlite3 "$DB" \
  "SELECT id||' active='||active||' ver='||coalesce(activeVersionId,'NULL') FROM workflow_entity;"
printf 'live_code   : '; sqlite3 "$DB" \
  'SELECT count(*) FROM workflow_history
    WHERE versionId=(SELECT activeVersionId FROM workflow_entity LIMIT 1);'
printf 'creds       : '; sqlite3 "$DB" 'SELECT count(*) FROM credentials_entity;'
sqlite3 "$DB" \
  "SELECT 'sd.'||t.key||' = '||
     CASE WHEN t.type IN ('array','object')
          THEN (SELECT count(*) FROM json_each(w.staticData, t.fullkey))
          ELSE t.atom END
   FROM workflow_entity w, json_tree(w.staticData) t
   WHERE t.key IN ('seenTopics','notifyCount','dlq','fetchFailStreak','lastPollAt');"
printf 'exec_last   : '; sqlite3 "$DB" \
  "SELECT id||'  '||datetime(startedAt,'+1 hour')||' BST  '||status
   FROM execution_entity ORDER BY id DESC LIMIT 1;"
printf 'exec_max_id : '; sqlite3 "$DB" 'SELECT coalesce(max(id),0) FROM execution_entity;'
```

```bash
chmod 755 /Users/aiwork/n8n-migrate/inspect.sh
```

⛔ **`lastPollAt` is epoch *milliseconds*. `execution_entity.startedAt` is *UTC text*.** The script prints executions already converted to BST. Never quote the two side by side without that conversion — it makes one poll look like two an hour apart, which reads exactly like a dead monitor.

**If `json_each(json, path)` inside the correlated subquery errors** on this sqlite3 build, replace the static-data block with:
```sh
python3 - "$DB" <<'EOF'
import json,subprocess,sys
s=subprocess.run(['sqlite3',sys.argv[1],'SELECT staticData FROM workflow_entity;'],
                 capture_output=True,text=True).stdout.strip()
want={'seenTopics','notifyCount','dlq','fetchFailStreak','lastPollAt'}
def walk(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k in want: print(f"sd.{k} =", len(v) if isinstance(v,(list,dict)) else v)
            walk(v)
walk(json.loads(s))
EOF
```

## 0.3 Create the shared config directory and the ntfy topic file

```bash
mkdir -p /Users/aiwork/n8n-watchdog/bin /Users/aiwork/n8n-watchdog/etc \
         /Users/aiwork/n8n-watchdog/hb  /Users/aiwork/n8n-watchdog/state \
         /Users/aiwork/n8n-backup/bin   /Users/aiwork/n8n-backup/etc \
         /Users/aiwork/n8n-backups/auto
printf '%s' '<THE REAL NTFY TOPIC>' > /Users/aiwork/n8n-watchdog/etc/ntfy-topic
chmod 600 /Users/aiwork/n8n-watchdog/etc/ntfy-topic
wc -c < /Users/aiwork/n8n-watchdog/etc/ntfy-topic
```
**Expected:** a non-zero byte count with no trailing newline.
**If it prints 0:** the topic did not land; both the backup agent and the watchdog will refuse to run.

⛔ The real topic must never reach the repo. A test asserts `CHANGE-ME` in the public `workflow.json`; the real value lives only in git-ignored `workflow.local.json`, in `/Users/aiwork/.n8n/wf-import.json`, and now here.

## 0.4 The hourly verified backup agent — the single highest-value change in this document

18 Aug cost 10.5 hours of state because there was no scheduled, *verified* backup. This is that.

**Mode file** (bind-mount era now, volume era after Part 1):
```bash
printf 'bind' > /Users/aiwork/n8n-backup/etc/mode
```

Write `/Users/aiwork/n8n-backup/bin/n8n-backup.sh`:

```sh
#!/bin/sh
# Hourly VERIFIED backup of the n8n database.
#   MODE=bind   : database is on the virtiofs bind mount. Take a FILE-LEVEL copy of
#                 database.sqlite THEN database.sqlite-wal (main file first: the WAL
#                 only grows, so the pair is coherent, we merely miss the newest
#                 frames). NEVER copy -shm: it is a derived wal-index cache and a
#                 mid-write copy is guaranteed incoherent with the copied -wal.
#                 NEVER open the live file with host sqlite3 - a second process
#                 mmapping that -shm across virtiofs is incident #1.
#   MODE=volume : database is on ext4 inside the VM. Use VACUUM INTO from a
#                 short-lived container connection - transactionally consistent,
#                 legal here because there is no cross-boundary shm sharing.
# A backup that exists is not a backup. Every file is queried before it is kept.
set -u

ROOT=/Users/aiwork/n8n-backup
DEST=/Users/aiwork/n8n-backups/auto
SRC=/Users/aiwork/.n8n
IMG=docker.n8n.io/n8nio/n8n:2.32.6
SQLITE_MOD=/usr/local/lib/node_modules/n8n/node_modules/sqlite3
LOG=/Users/aiwork/Library/Logs/n8n-backup.log
KEEP=72

log() { echo "$(date '+%F %T') $*"; }

[ -f "$LOG" ] && [ "$(wc -c < "$LOG" | tr -d ' ')" -gt 1048576 ] && \
  { tail -c 262144 "$LOG" > "$LOG.tmp" && cat "$LOG.tmp" > "$LOG" && rm -f "$LOG.tmp"; }

if [ -f "$ROOT/etc/pause" ]; then log "PAUSED (etc/pause present)"; exit 0; fi

MODE=$(cat "$ROOT/etc/mode" 2>/dev/null || echo bind)
STAMP=$(date +%Y%m%dT%H%M%S)
OUT="$DEST/n8n-$STAMP.sqlite"
mkdir -p "$DEST" || { log "FATAL cannot mkdir $DEST"; exit 1; }

alert() {   # $1 body
    T=$(cat /Users/aiwork/n8n-watchdog/etc/ntfy-topic 2>/dev/null) || return 0
    [ -n "$T" ] || return 0
    curl -s -o /dev/null --max-time 10 -H "Title: n8n BACKUP FAILED" \
         -H "Priority: high" -H "Tags: floppy_disk" -d "$1" "https://ntfy.sh/$T"
}

case "$MODE" in
  bind)
    cp "$SRC/database.sqlite" "$OUT"          || { log "FATAL cp main"; alert "cp of database.sqlite failed"; exit 1; }
    if [ -f "$SRC/database.sqlite-wal" ]; then
        cp "$SRC/database.sqlite-wal" "$OUT-wal" || { log "FATAL cp wal"; alert "cp of -wal failed"; exit 1; }
    fi
    rm -f "$OUT-shm"
    ;;
  volume)
    docker exec n8n node -e \
      'const s=require("'"$SQLITE_MOD"'");const d=new s.Database("/home/node/.n8n/database.sqlite");
       d.run("VACUUM INTO \x27/home/node/.n8n/.bkp.sqlite\x27",e=>{console.log(e?"ERR "+e.message:"SNAP_OK");process.exit(e?1:0)})' \
      >/dev/null 2>&1 || { log "FATAL vacuum into"; alert "VACUUM INTO failed"; exit 1; }
    docker cp n8n:/home/node/.n8n/.bkp.sqlite "$OUT" >/dev/null 2>&1 \
      || { log "FATAL docker cp"; alert "docker cp of snapshot failed"; exit 1; }
    docker exec n8n rm -f /home/node/.n8n/.bkp.sqlite >/dev/null 2>&1
    ;;
  *) log "FATAL unknown mode '$MODE'"; exit 1 ;;
esac

# ---- VERIFY. A file that exists is not a backup. -----------------------------
INT=$(sqlite3 "$OUT" 'PRAGMA integrity_check;' 2>&1 | head -1)
WF=$(sqlite3  "$OUT" 'SELECT count(*) FROM workflow_entity;' 2>/dev/null || echo 0)
CODE=$(sqlite3 "$OUT" 'SELECT count(*) FROM workflow_history
        WHERE versionId=(SELECT activeVersionId FROM workflow_entity LIMIT 1);' 2>/dev/null || echo 0)
if [ "$INT" != "ok" ] || [ "${WF:-0}" -lt 1 ] || [ "${CODE:-0}" -lt 1 ]; then
    log "REJECTED $OUT integrity=$INT wf=$WF live_code=$CODE"
    alert "backup rejected: integrity=$INT workflow_rows=$WF live_code_rows=$CODE"
    mv "$OUT" "$OUT.REJECTED" 2>/dev/null; rm -f "$OUT-wal"
    exit 1
fi

# Collapse the WAL into the kept file so restores never depend on a sidecar.
[ -f "$OUT-wal" ] && sqlite3 "$OUT" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1
rm -f "$OUT-wal" "$OUT-shm"

log "OK $OUT wf=$WF live_code=$CODE bytes=$(wc -c < "$OUT" | tr -d ' ')"

# ---- retention ---------------------------------------------------------------
ls -t "$DEST"/n8n-*.sqlite 2>/dev/null | tail -n +$((KEEP+1)) | while read -r f; do
    rm -f "$f"; log "pruned $f"
done
exit 0
```

```bash
chmod 755 /Users/aiwork/n8n-backup/bin/n8n-backup.sh
/Users/aiwork/n8n-backup/bin/n8n-backup.sh
tail -5 /Users/aiwork/Library/Logs/n8n-backup.log
```
**Expected:** a line `OK /Users/aiwork/n8n-backups/auto/n8n-….sqlite wf=1 live_code=1 bytes=…`
**If it says `REJECTED`:** you have just discovered the live database does not contain a runnable workflow. **Stop everything and investigate — do not migrate.**

Now prove the backup by content, not by existence:
```bash
/Users/aiwork/n8n-migrate/inspect.sh "$(ls -t /Users/aiwork/n8n-backups/auto/n8n-*.sqlite | head -1)"
```
**Expected:** `integrity : ok`, `wf_rows : 1`, `wf : jobs-board-monitor active=1 ver=ebf1de74-…`, `live_code : 1`, and five `sd.*` lines with plausible values (`sd.lastPollAt` within the last 10 minutes, converted: `date -r $((<value>/1000))`).
**If `wf_rows` is 0 while integrity is `ok`:** that is the 18 Aug `.recover` signature — a structurally valid, semantically empty database. Stop.

**Install the agent.** `/Users/aiwork/Library/LaunchAgents/com.benfoster.n8n-backup.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.benfoster.n8n-backup</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>/Users/aiwork/n8n-backup/bin/n8n-backup.sh</string>
    </array>
    <key>StartInterval</key><integer>3600</integer>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>/Users/aiwork/Library/Logs/n8n-backup.log</string>
    <key>StandardErrorPath</key><string>/Users/aiwork/Library/Logs/n8n-backup.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <!-- colima's own agent loads in these session types; match it so the backup
         is not silently absent at the login window or after fast user switch. -->
    <key>LimitLoadToSessionType</key>
    <array>
        <string>Aqua</string><string>Background</string><string>LoginWindow</string>
        <string>StandardIO</string><string>System</string>
    </array>
    <key>ProcessType</key><string>Background</string>
    <key>LowPriorityIO</key><true/>
    <key>Nice</key><integer>5</integer>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/501 /Users/aiwork/Library/LaunchAgents/com.benfoster.n8n-backup.plist
launchctl enable gui/501/com.benfoster.n8n-backup
launchctl print gui/501/com.benfoster.n8n-backup | grep -E 'state|last exit code'
```
**Expected:** `state = waiting` (or `running`) and `last exit code = 0`.
**If bootstrap errors with `Load failed: 5: Input/output error`:** the plist is malformed — `plutil -lint <path>` will say where. Do not use `launchctl load`; it is legacy on this machine.

## 0.5 Remove the second-writer path (decision D-5)

```bash
ls -la /opt/homebrew/bin/n8n
pgrep -fl 'node .*n8n' | grep -v docker || echo "no host n8n running"
mv /opt/homebrew/bin/n8n /opt/homebrew/bin/n8n.DISABLED
command -v n8n || echo "host n8n binary is now gone from PATH"
```
**Expected:** `no host n8n running`, then `host n8n binary is now gone from PATH`.
**If something *is* running:** do not kill it blindly — identify it first (`ps -o pid,lstart,command -p <pid>`). A second n8n process against `~/.n8n/database.sqlite` is the leading corruption hypothesis and you have just caught it live.
**Reverse:** `mv /opt/homebrew/bin/n8n.DISABLED /opt/homebrew/bin/n8n`.

The documented deploy route uses a one-off **container** (`import:workflow`, not `n8n import:workflow`), so nothing should depend on the host binary. If some script breaks in the next 24 h, reverse it and note what needed it.

## 0.6 Retire `start-n8n.sh`

```bash
grep -n 'N8N_USER_FOLDER' "/Users/aiwork/Documents/Claude Code/start-n8n.sh"
mv "/Users/aiwork/Documents/Claude Code/start-n8n.sh" \
   "/Users/aiwork/Documents/Claude Code/start-n8n.sh.RETIRED-19aug"
```
**Expected:** the grep shows the `N8N_USER_FOLDER="$PROJECT_DIR/.n8n-data"` line, then the move succeeds.
**Why:** running it starts a **second n8n on port 5678** with a different data dir. It is still referenced as current in two docs (fixed in F6).

## 0.7 Confirm the monitor is actually alive *before* you touch anything

```bash
cp /Users/aiwork/.n8n/database.sqlite     /Users/aiwork/n8n-migrate/pre.sqlite
cp /Users/aiwork/.n8n/database.sqlite-wal /Users/aiwork/n8n-migrate/pre.sqlite-wal 2>/dev/null
rm -f /Users/aiwork/n8n-migrate/pre.sqlite-shm
/Users/aiwork/n8n-migrate/inspect.sh /Users/aiwork/n8n-migrate/pre.sqlite
```
**Expected:** `exec_last` shows an execution from within the last ~10 minutes with status `success`, and `sd.lastPollAt` converts to a time within the last ~10 minutes.
**If the newest execution is hours old:** the monitor is *already* dead. **Stop.** Fix that first — otherwise a failed E6 later cannot be told apart from "the migration broke it."

⛔ Note the copy order: main file **then** `-wal`, and **never** `-shm`. The main file has not been checkpointed since 18 Aug 19:22, so it is static; the WAL only grows. Missing the newest frames is fine, copying an incoherent wal-index is not.

**Part 0 is complete.** If you chose to stop here (D-1 alternative), you now have hourly verified backups, no second writer, and no stray start script. Come back for Part 1 with 72 hours of evidence.

---

# PART 1 — MIGRATE THE DATABASE ONTO A NAMED VOLUME

**Downtime budget:** ~4–8 minutes (~12 if you take D-2's memory bump).
**Rollback:** copy one file back, `up -d`. Under 60 seconds.

## Phase A — Pre-flight, container still RUNNING

### A0. FALSIFICATION — prove a named volume is off virtiofs *before* taking any downtime

This is the step that decides whether the migration is worth doing at all. It costs nothing and touches no live data.

```bash
colima ssh -- df -T /var/lib/docker
docker volume create n8n_fstest
docker run --rm -v n8n_fstest:/probe --entrypoint sh \
  docker.n8n.io/n8nio/n8n:2.32.6 -c 'awk "\$2==\"/probe\"{print \$1, \$3; f=1} END{exit !f}" /proc/mounts'
docker run --rm -v /Users/aiwork/.n8n:/probe --entrypoint sh \
  docker.n8n.io/n8nio/n8n:2.32.6 -c 'awk "\$2==\"/probe\"{print \$1, \$3; f=1} END{exit !f}" /proc/mounts'
docker volume rm n8n_fstest
```
**Expected:**
```
Filesystem  Type ...  Mounted on
/dev/vdb1   ext4 ...  /var/lib/docker
/dev/vdb1 ext4                 <- the named volume
lima-ded64129c8217e87 virtiofs <- today's bind mount
```
**If the named-volume line says `virtiofs`, or the `awk` exits non-zero (no line printed at all):** the premise is false. **Abort Part 1.** Keep Part 0, and re-plan.

Note the `awk … END{exit !f}` form: a `grep -v virtiofs` would "pass" on *empty output*, which is the failure mode you most need to catch.

### A1. Record the starting point

```bash
date +"%F %T %Z"
docker ps --filter 'name=^/n8n$' --format '{{.Names}} {{.Image}} {{.Status}}'
docker image inspect docker.n8n.io/n8nio/n8n:2.32.6 --format '{{.Id}} {{.Config.User}}'
df -h /Users/aiwork | tail -1
colima ssh -- df -h /var/lib/docker | tail -1
```
**Expected:** `n8n docker.n8n.io/n8nio/n8n:2.32.6 Up …`; an image ID and `node`; ample free space on both.
**If the image tag is not `2.32.6`:** stop. The pin exists so schema migrations never run unattended against this data.
**If the image inspect errors:** stop — do not begin an outage that depends on a registry pull.

### A2. ⛔ THE RULE THAT GOVERNS THIS WHOLE PHASE

**While the container is running, no process outside it may open `/Users/aiwork/.n8n/database.sqlite` — not host `sqlite3`, not `mode=ro`, not a container.**

- `mode=ro` returns correct answers but must mmap the `-shm` wal-index across the virtiofs boundary — the exact operation behind the 18 Aug morning outage. A verification step must never participate in the fault it checks for.
- `immutable=1` is worse: it bypasses the WAL entirely and was **measured returning empty for a WAL-committed row**. It gives you a confidently wrong "the data isn't there."

`cp` and `shasum` take no locks and open no SQLite connection — those are fine. **Every query in this runbook runs against a copy.**

### A3. Capture the LIVE baseline — this replaces every hardcoded number

```bash
rm -f /Users/aiwork/n8n-migrate/live.sqlite*
cp /Users/aiwork/.n8n/database.sqlite     /Users/aiwork/n8n-migrate/live.sqlite
cp /Users/aiwork/.n8n/database.sqlite-wal /Users/aiwork/n8n-migrate/live.sqlite-wal 2>/dev/null
rm -f /Users/aiwork/n8n-migrate/live.sqlite-shm
ls -la /Users/aiwork/.n8n/database.sqlite*
/Users/aiwork/n8n-migrate/inspect.sh /Users/aiwork/n8n-migrate/live.sqlite \
  | tee /Users/aiwork/n8n-migrate/baseline-PRE.txt
```
**Expected:** `integrity : ok`, `wf_rows : 1`, `live_code : 1`, five `sd.*` lines, an `exec_last` from within ~10 min.
**If integrity is not `ok` on this copy:** the live DB is already damaged. **Stop and restore from `/Users/aiwork/n8n-backups/auto/` instead of migrating.**

Now write the baseline down, because everything downstream compares against it:

```bash
cat /Users/aiwork/n8n-migrate/baseline-PRE.txt
```
Copy these five values onto paper or into a note: **`sd.seenTopics`, `sd.notifyCount`, `sd.dlq`, `sd.fetchFailStreak`, `sd.lastPollAt`, `creds`, `exec_max_id`.**

The acceptance rules for the rest of the runbook are **relative**, never literal:

| quantity | post-migration rule |
|---|---|
| `integrity` | `ok` |
| `wf_rows` | exactly 1 |
| `wf` | `jobs-board-monitor active=1 ver=ebf1de74-5c09-42c2-81f9-d8bc01cda242` |
| `live_code` | exactly 1 |
| `creds` | **equal** to the PRE value (whatever it is — it may well be 0) |
| `sd.seenTopics` | **≥** PRE |
| `sd.notifyCount` | **≥** PRE |
| `sd.dlq` | **equal** to PRE |
| `sd.fetchFailStreak` | 0 |
| `sd.lastPollAt` | **strictly greater** than PRE, after a poll has landed |
| `exec_max_id` | **strictly greater** than PRE, after a poll has landed |

⛔ **Why "strictly greater" matters.** The main database file is byte-identical to the 18 Aug 08:34 backup, because n8n has not checkpointed since the 19:22 restore — every hour of state since then lives only in the `-wal`. **If the WAL is discarded at any point, every gate that accepts "equal or greater" passes and you will tick "zero loss" over a real loss.** Strict inequality on `lastPollAt` and `exec_max_id` is the only check that can tell the two apart.

For the same reason: **do not compare `shasum` of `database.sqlite` between the backup and the live file and conclude anything.** On a WAL database with a live writer, a main-file hash carries no information about liveness.

### A4. Fingerprint the encryption key without printing it

```bash
ls -la /Users/aiwork/.n8n/config
shasum -a 256 /Users/aiwork/.n8n/config
python3 -c "import json;print(list(json.load(open('/Users/aiwork/.n8n/config')).keys()))"
```
**Expected:** `-rw-------  1 aiwork  staff  56 … config`, a 64-hex hash, and `['encryptionKey']`.
**If the mode is not `600` or the key list differs:** note it and continue; record the hash either way — it is compared in C3 and E2. No `N8N_ENCRYPTION_KEY` is set in compose, so this file is the only copy. It must reach the volume byte-for-byte, owned `1000:1000`, mode `0600`.

### A5. Pause the backup agent for the duration

```bash
touch /Users/aiwork/n8n-backup/etc/pause
```
**Expected:** no output.
**Why:** a `bind`-mode backup firing while you are moving sidecars around would copy a half-migrated state and could reject-alert you mid-outage. **Remember to remove this file in E8.**

---

## Phase B — Stop cleanly, then back up before anything is mutated

### B1. Graceful stop with enough grace

```bash
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml stop -t 60
docker ps -a --filter 'name=^/n8n$' --format '{{.Names}} {{.Status}}'
```
**Expected:** `✔ Container n8n Stopped`, then `n8n Exited (0) …`.
**If it exits non-zero or takes the full 60 s:** note it; continue, but expect the B2 fallback branch.

`docker stop` defaults to 10 s; n8n's own graceful-shutdown budget is 30 s. The default SIGKILLs n8n mid-checkpoint and leaves a dirty `-wal`. `stop_grace_period: 60s` goes into the new compose file permanently.

### B2. COLD BACKUP FIRST — before any sidecar is touched

```bash
tar -C /Users/aiwork -cpzf \
  "/Users/aiwork/n8n-backups/n8n-predvolume-$(date +%Y%m%dT%H%M%S).tgz" .n8n
ls -la /Users/aiwork/n8n-backups/n8n-predvolume-*.tgz
```
**Expected:** a tarball of a few MB.
**If tar errors:** stop. `docker compose … start` returns you to a running system, unchanged.

This tar **includes `-wal` and `-shm` exactly as they are**. That is deliberate: it is taken *before* any checkpoint or move, so whatever happens next is recoverable.

### B3. Prove the cold backup contains the data

```bash
rm -rf /Users/aiwork/n8n-migrate/cold && mkdir -p /Users/aiwork/n8n-migrate/cold
tar -xzf "$(ls -t /Users/aiwork/n8n-backups/n8n-predvolume-*.tgz | head -1)" \
    -C /Users/aiwork/n8n-migrate/cold
rm -f /Users/aiwork/n8n-migrate/cold/.n8n/database.sqlite-shm
/Users/aiwork/n8n-migrate/inspect.sh /Users/aiwork/n8n-migrate/cold/.n8n/database.sqlite \
  | tee /Users/aiwork/n8n-migrate/baseline-COLD.txt
shasum -a 256 /Users/aiwork/n8n-migrate/cold/.n8n/config
ls -la /Users/aiwork/n8n-migrate/cold/.n8n/config
```
**Expected:** `integrity : ok`; `wf_rows : 1`; `live_code : 1`; `creds` equal to PRE; every `sd.*` **≥** its PRE value and `sd.lastPollAt` **≥** PRE; the config hash **equal** to A4's; mode `-rw-------`.
**If `wf_rows` is 0, or `live_code` is 0, or any `sd.*` is *below* PRE:** **ABORT.** Nothing has been changed yet — `docker compose -f … start` restores service exactly. Investigate before retrying.

`live_code` is not decoration: `workflow_entity.nodes` is a stale snapshot in n8n 2.x; the code that actually runs lives in `workflow_history` keyed by `activeVersionId`. A backup without that row restores a workflow with no body.

### B4. Now — and only now — deal with the sidecars

```bash
ls -la /Users/aiwork/.n8n/database.sqlite*
```
**PASS:** only `database.sqlite` remains; `-wal` and `-shm` are gone (SQLite checkpoints and deletes both when the last connection closes cleanly). **Skip to Phase C.**

**If either still exists** — expected, given 18 Aug — checkpoint from *inside a throwaway container*, never from the host:

```bash
docker ps -a --filter 'name=^/n8n$' --format '{{.Names}} {{.Status}}'   # MUST say Exited
docker run --rm --entrypoint node -v /Users/aiwork/.n8n:/d \
  docker.n8n.io/n8nio/n8n:2.32.6 -e \
  'const s=require("/usr/local/lib/node_modules/n8n/node_modules/sqlite3");
   const d=new s.Database("/d/database.sqlite");
   d.all("PRAGMA wal_checkpoint(TRUNCATE)",(e,r)=>{
     if(e){console.log("ERR "+e.message);process.exit(1);}
     console.log("CKPT "+JSON.stringify(r));
     d.all("PRAGMA integrity_check",(e2,r2)=>{
       console.log("INTEGRITY "+JSON.stringify(r2));
       d.close(()=>process.exit(e2?1:0));});});'
ls -la /Users/aiwork/.n8n/database.sqlite*
```
**Expected:** `CKPT [{"busy":0,"log":0,"checkpointed":0}]`, `INTEGRITY [{"integrity_check":"ok"}]`, and then **only `database.sqlite`** — closing the last connection cleanly deletes both sidecars.

**Gate — read this before typing anything else:**
- **If `busy` is not 0, or integrity is not `ok`, or the command errors: STOP.** Do not move the `-wal`. Restore from the tarball you just proved in B3 and re-plan.
- **If `-wal` still exists after the above, check its size.** Move it aside **only if it is 0 bytes**:
```bash
[ -s /Users/aiwork/.n8n/database.sqlite-wal ] \
  && echo "REFUSING: -wal is NOT empty, it contains unmerged transactions - STOP" \
  || { mv /Users/aiwork/.n8n/database.sqlite-wal /Users/aiwork/n8n-backups/stale-wal-19aug 2>/dev/null
       mv /Users/aiwork/.n8n/database.sqlite-shm /Users/aiwork/n8n-backups/stale-shm-19aug 2>/dev/null
       ls -la /Users/aiwork/.n8n/database.sqlite*; }
```
**If it prints `REFUSING`:** a non-empty `-wal` holds committed transactions. Moving it aside discards them, and — because the main file is byte-identical to the 18 Aug backup — the loss is invisible to every count-based check. Go back to the checkpoint step, or restore from B3's tarball.

### B5. Re-verify the on-disk state after the sidecar work

```bash
cp /Users/aiwork/.n8n/database.sqlite /Users/aiwork/n8n-migrate/postckpt.sqlite
/Users/aiwork/n8n-migrate/inspect.sh /Users/aiwork/n8n-migrate/postckpt.sqlite
```
**Expected:** identical to `baseline-COLD.txt` — in particular `sd.lastPollAt` and `exec_max_id` **equal to or greater than** the PRE values.
**If `sd.lastPollAt` has gone *backwards* to a value from 18 Aug:** the WAL was discarded. **Stop. Restore from the B3 tarball** (extract, put `.n8n` back, verify with `inspect.sh`, then restart) before doing anything else.

---

## Phase C — Volume, memory, and the copy

### C0. (Optional, decision D-2) Raise the VM to 4 GB while everything is stopped

```bash
colima stop
colima start --cpu 2 --memory 4
docker context use colima
colima ssh -- free -m
docker ps -a --filter 'name=^/n8n$' --format '{{.Names}} {{.Status}}'
```
**Expected:** `free -m` shows ~4000 MB total; the n8n container still listed as `Exited` (it does not auto-start because you stopped it via compose).
**If `colima start` fails:** `colima start` with no flags returns you to the previous configuration. Skip C0 and continue — it is an improvement, not a prerequisite.
**Note:** never `colima delete`. And from now on, shut down cleanly with `colima stop`, not by killing the VM — the guest ext4 lives inside a sparse disk image on APFS and a hard kill is its own corruption vector.

### C1. Create the volume

```bash
docker volume ls
docker volume create n8n_data
docker volume inspect n8n_data --format '{{.Name}} {{.Mountpoint}} {{.Driver}}'
```
**Expected:** the list is empty (no collision), then `n8n_data /var/lib/docker/volumes/n8n_data/_data local`.
**If `n8n_data` already exists:** inspect it before reusing. `docker volume rm n8n_data` is safe only if you are certain it is the empty one you just made.

### C2. Copy the host directory into the volume

Two sequential, separately-gated `tar` steps — **not** a pipe. A pipeline's exit status is the last command's, so a truncated read on the source side still prints success.

```bash
docker run --rm --entrypoint sh --user 0:0 \
  -v /Users/aiwork/.n8n:/src:ro \
  -v /Users/aiwork/n8n-migrate:/stage \
  docker.n8n.io/n8nio/n8n:2.32.6 -c '
    cd /src &&
    tar -cpf /stage/n8n-payload.tar \
        --exclude=./database.sqlite-shm \
        --exclude=./database.sqlite-wal \
        --exclude=./crash.journal . &&
    echo TAR_CREATE_OK'
ls -la /Users/aiwork/n8n-migrate/n8n-payload.tar
```
**Expected:** `TAR_CREATE_OK` and a tar file of a few MB.
**If `TAR_CREATE_OK` does not print:** nothing has been written to the volume. Fix and retry.

```bash
docker run --rm --entrypoint sh --user 0:0 \
  -v /Users/aiwork/n8n-migrate:/stage:ro \
  -v n8n_data:/dst \
  docker.n8n.io/n8nio/n8n:2.32.6 -c '
    tar -C /dst -xpf /stage/n8n-payload.tar &&
    chown -R 1000:1000 /dst &&
    echo EXTRACT_OK'
```
**Expected:** `EXTRACT_OK`.
**If not:** `docker volume rm n8n_data` and start Phase C again. Nothing is live.

Notes:
- The source is mounted **read-only**, so `/Users/aiwork/.n8n` cannot be touched by this step.
- `-wal`/`-shm` are excluded — **safe only because B4 proved them gone or empty.** Had B4 refused, you would not be here.
- **Do not use `docker cp` for this.** It reads through macOS ownership (uid 501), not the virtiofs-mapped 1000.
- `wf-import.json` **is** copied. It is inert at runtime but contains the real ntfy topic; it must never reach the repo from either location.

### C3. Verify the volume's contents before starting n8n

```bash
docker run --rm --entrypoint sh --user 0:0 \
  -v /Users/aiwork/.n8n:/src:ro -v n8n_data:/dst \
  docker.n8n.io/n8nio/n8n:2.32.6 -c '
    echo "--- dst ---"; ls -lan /dst
    echo "--- config hash ---"; sha256sum /dst/config
    echo "--- file counts src/dst ---"
    find /src -type f ! -name "database.sqlite-wal" ! -name "database.sqlite-shm" \
         ! -name "crash.journal" | wc -l
    find /dst -type f | wc -l
    echo "--- byte totals src/dst ---"
    find /src -type f ! -name "database.sqlite-wal" ! -name "database.sqlite-shm" \
         ! -name "crash.journal" -exec wc -c {} + | tail -1
    find /dst -type f -exec wc -c {} + | tail -1'
```
**Expected:** `config` shown as `-rw------- 1 1000 1000 56`; `database.sqlite` owned `1000 1000`; `nodes` and `storage` present and owned `1000 1000`; the config hash **equal to A4's**; the two file counts **equal**; the two byte totals **equal**.
**If the counts or totals differ:** the copy is incomplete. `docker volume rm n8n_data` and redo C1–C3.
**If `config` is `0644`:** n8n 2.x will chmod it on start (permission enforcement defaults on), but a wrong *owner* is fatal — re-run the `chown` step.
**If `sha256sum` is missing from the image:** substitute `md5sum` or `cksum` and compare against the equivalent host command.

### C4. Verify the copied database by CONTENT, not by hash

```bash
rm -rf /Users/aiwork/n8n-migrate/vol && mkdir -p /Users/aiwork/n8n-migrate/vol
docker run --rm --entrypoint sh --user 0:0 \
  -v n8n_data:/src:ro -v /Users/aiwork/n8n-migrate/vol:/out \
  docker.n8n.io/n8nio/n8n:2.32.6 -c '
    cp /src/database.sqlite /out/ && chown 501:20 /out/database.sqlite && echo EXPORT_OK'
ls -la /Users/aiwork/n8n-migrate/vol/
/Users/aiwork/n8n-migrate/inspect.sh /Users/aiwork/n8n-migrate/vol/database.sqlite
```
**Expected:** `EXPORT_OK`, a real file on the host (non-zero size — if it is missing, you bind-mounted a path the VM does not share), and inspect output **identical to `baseline-COLD.txt`**: `integrity ok`, `wf_rows 1`, correct `activeVersionId`, `live_code 1`, `creds` = PRE, every `sd.*` ≥ PRE, `sd.lastPollAt` ≥ PRE, `exec_max_id` ≥ PRE.
**If any value is below its PRE counterpart:** the volume contains a rewound database. `docker volume rm n8n_data`, redo C1–C4 from the cold tarball rather than from `.n8n`.

A byte-hash match between the volume copy and `/Users/aiwork/.n8n/database.sqlite` proves the copy is faithful. It **cannot** prove completeness, because both sides derive from the same file. The content comparison above is the check that means something.

---

## Phase D — Cut over

### D1. Write the new `/Users/aiwork/n8n-docker/docker-compose.yml`

**Change exactly one thing.** The env block below is byte-identical to today's. Tuning goes in Phase F, each with its own recreate, so a regression has one suspect.

```yaml
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:2.32.6   # PINNED. An unpinned :latest would run
                                            # schema migrations against this data on
                                            # first start. Do not float this.
    container_name: n8n
    restart: unless-stopped

    # n8n's own graceful-shutdown budget is 30s. Docker's default stop timeout is 10s,
    # which SIGKILLs n8n mid-checkpoint and leaves a dirty -wal. A dirty -wal is how
    # the 18 Aug morning outage started.
    stop_grace_period: 60s

    ports:
      - "5678:5678"

    environment:
      - GENERIC_TIMEZONE=Europe/London
      - TZ=Europe/London
      - N8N_DIAGNOSTICS_ENABLED=false
      - N8N_RUNNERS_ENABLED=true            # deprecated & inert from n8n 2.0; kept so
                                            # this migration changes exactly one thing

    volumes:
      # ================= 19 Aug 2026: MOVED OFF THE BIND MOUNT ==================
      # WAS: - /Users/aiwork/.n8n:/home/node/.n8n
      #
      # That path is a macOS->Linux virtiofs share (Colima vmType vz, mountType
      # virtiofs) with DAX unavailable, so guest and host do not share one physical
      # page for an mmap'd file. n8n 2.32.6 hardcodes SQLite WAL on with a
      # 3-connection pool and offers no env var to disable it; WAL requires all
      # connections to share the mmap'd -shm wal-index. On 18 Aug 2026 the DB failed
      # twice in one day: a stale -shm that a docker restart would not clear, then
      # genuine btree corruption costing ~10.5h of state.
      #
      # A named volume lives at /var/lib/docker/volumes/n8n_data/_data on /dev/vdb1,
      # ext4, inside the lima VM. One kernel, one page cache, no virtiofs. It also
      # makes any host-side n8n physically unable to open this database.
      #
      # This fixes SQLite's LOCKING/COHERENCY exposure. It does not make the database
      # crash-proof: the ext4 filesystem lives inside a sparse disk image on APFS, so
      # always shut the VM down with `colima stop`, never by killing it.
      #
      # ROLLBACK: cp docker-compose.yml.pre-volume-19aug over this file, then
      #   docker compose -f … up -d
      # /Users/aiwork/.n8n is untouched by the migration and is the rollback copy.
      # ==========================================================================
      - n8n_data:/home/node/.n8n

volumes:
  n8n_data:
    external: true     # created and populated by hand (Phase C). external:true means
    name: n8n_data     # compose ERRORS if it is missing, instead of silently inventing
                       # an empty one and starting n8n with no workflows.
```

**Delete the old 6-line comment claiming the bind mount is "the whole point of the migration."** Leaving both is how the next session gets it wrong.

```bash
diff /Users/aiwork/n8n-docker/docker-compose.yml.pre-volume-19aug \
     /Users/aiwork/n8n-docker/docker-compose.yml
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml config >/dev/null && echo YAML_OK
```
**Expected:** a diff showing only the volume/comment/`stop_grace_period` changes, then `YAML_OK`.
**If `config` errors:** fix the YAML now. This is the last quiet moment.

### D2. Bring it up

```bash
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml up -d
docker ps --filter 'name=^/n8n$' --format '{{.Names}} {{.Status}}'
```
**Expected:** `✔ Container n8n Started`, then `n8n Up N seconds`.
**If compose says the external volume `n8n_data` is missing:** you are in the wrong docker context (`docker context use colima`) or C1 did not run. Nothing is broken.
**Do not run `docker compose down`.** `up -d` recreates the container by itself because the service config hash changed.

---

## Phase E — VERIFICATION. A partial pass is a fail.

### E1. Falsification: the mount is no longer virtiofs

```bash
docker exec n8n awk '$2=="/home/node/.n8n"{print $1, $3; f=1} END{exit !f}' /proc/mounts
echo "awk exit: $?"
```
**Expected:** `/dev/vdb1 ext4` and `awk exit: 0`.
**If the exit code is 1 (no line printed at all), or the fstype says `virtiofs`:** the volume line did not take. **Roll back and re-read D1.** An absent line is a failure, not a pass.

### E2. WAL is live on ext4, and the key survived

```bash
docker exec n8n ls -la /home/node/.n8n
docker exec n8n sha256sum /home/node/.n8n/config
```
**Expected:** `database.sqlite-wal` and `database.sqlite-shm` have **reappeared** (proof n8n opened it in WAL mode, on ext4 this time); `config` is `-rw------- 1 node node 56`; the hash **equals A4's**.
**If the hash differs:** stop and roll back — the encryption key is not the one that encrypted whatever credentials exist.
**If the mode is not 600:** n8n normally corrects it on start; if it has not, `docker exec -u 0 n8n chmod 600 /home/node/.n8n/config`.

### E3. HTTP is up

```bash
curl -s -o /dev/null -w 'healthz %{http_code}\n'   --max-time 5 http://localhost:5678/healthz
curl -s -o /dev/null -w 'readiness %{http_code}\n' --max-time 5 http://localhost:5678/healthz/readiness
```
**Expected:** `healthz 200`, `readiness 200`.
**⚠️ Do not read this as "the DB is fine."** Readiness pings `SELECT 1`, which reads no btree page; it answered 200 through a reproduction of the exact 18 Aug corruption. E4 and E6 are the checks that mean something.

### E4. Consistent snapshot out of the volume, then query it on the host

`VACUUM INTO` gives a transactionally consistent copy in a single transaction. It is a second connection to the database — which is **legal here only because the database is now on ext4 inside one kernel.** Never do this against a bind-mounted SQLite file.

```bash
docker exec n8n node -e \
 'const s=require("/usr/local/lib/node_modules/n8n/node_modules/sqlite3");
  const d=new s.Database("/home/node/.n8n/database.sqlite");
  d.run("VACUUM INTO \x27/home/node/.n8n/verify-snap.sqlite\x27",
        e=>{console.log(e?"ERR "+e.message:"SNAP_OK");process.exit(e?1:0)})'
rm -rf /Users/aiwork/n8n-migrate/post && mkdir -p /Users/aiwork/n8n-migrate/post
docker cp n8n:/home/node/.n8n/verify-snap.sqlite /Users/aiwork/n8n-migrate/post/snap.sqlite
docker exec n8n rm -f /home/node/.n8n/verify-snap.sqlite
/Users/aiwork/n8n-migrate/inspect.sh /Users/aiwork/n8n-migrate/post/snap.sqlite
```
**Expected:** `SNAP_OK`, a successful `docker cp`, and inspect output satisfying **every** rule in the A3 table (`lastPollAt` and `exec_max_id` need not have advanced yet — that is E6).
**If `SNAP_OK` does not print:** fall back to a 20-second interruption — `docker compose … stop -t 60`, run the C4 export, `up -d`. Safe, just briefly interruptive.
**If any value is below its PRE counterpart:** roll back.

### E5. The workflow activated, and no SQLite errors

```bash
docker logs n8n --since 5m 2>&1 | grep -icE 'SQLITE_(CORRUPT|IOERR|BUSY|READONLY)|Failed to hard-delete'
docker logs n8n --since 5m 2>&1 | grep -iE 'activat' | head -5
```
**Expected:** the count is `0`, and a line containing `Activated workflow` / `Workflows activated`.
**If the count is non-zero:** roll back and re-plan. On 18 Aug the evening window produced 2,979 log lines in three hours, essentially all of this class.

### E6. A REAL POLL LANDS — the only check that proves the monitor is alive

Wait past the next 10-minute boundary; allow 12 minutes.

```bash
docker exec n8n node -e \
 'const s=require("/usr/local/lib/node_modules/n8n/node_modules/sqlite3");
  const d=new s.Database("/home/node/.n8n/database.sqlite");
  d.all("SELECT id, datetime(startedAt,\x27+1 hour\x27) AS bst, status FROM execution_entity ORDER BY id DESC LIMIT 5",
        (e,r)=>console.log(e?e.message:r))'
```
**Expected:** at least one row whose `id` is **strictly greater** than the PRE `exec_max_id`, whose BST timestamp is **after** your `up -d`, and whose `status` is `success`.
**If no new row after 15 minutes:** roll back (see trigger list).

⛔ **Two traps that have already burned this project:**
1. `startedAt` is UTC text; `lastPollAt` is epoch ms. The `+1 hour` above is mandatory for BST.
2. **An execution that started *before* the recreate proves nothing** — it ran the old process. Only a strictly greater `id` with a later timestamp counts.

Then re-take the E4 snapshot and confirm `sd.lastPollAt` is **strictly greater** than the PRE value.

### E7. Zero-loss confirmation

Tick this only when all of the following are true: E1 says `ext4`; E4's counts satisfy every rule in the A3 table; `sd.lastPollAt` and `exec_max_id` are **strictly greater** than PRE; E5's error count is 0; E2's config hash matches.

### E8. Re-arm the backup agent in volume mode

```bash
printf 'volume' > /Users/aiwork/n8n-backup/etc/mode
rm -f /Users/aiwork/n8n-backup/etc/pause
/Users/aiwork/n8n-backup/bin/n8n-backup.sh
tail -3 /Users/aiwork/Library/Logs/n8n-backup.log
/Users/aiwork/n8n-migrate/inspect.sh "$(ls -t /Users/aiwork/n8n-backups/auto/n8n-*.sqlite | head -1)"
```
**Expected:** an `OK …` line, and inspect output matching E4's.
**If it logs `FATAL vacuum into`:** the sqlite3 module path changed. Fix the path in the script — you are otherwise running without backups.

---

## ROLLBACK

**Trigger it if:** n8n will not start; E1 does not say `ext4`; E4 shows a missing workflow, a zero `live_code`, a wrong `activeVersionId`, or any value below its PRE counterpart; E2's config hash differs; E5 shows SQLite errors; or E6 shows no new execution after 15 minutes.

**Time: under 60 seconds.**

```bash
# 1. Stop the container running on the volume.
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml stop -t 60

# 2. Restore the pristine compose file. Do NOT hand-edit YAML under pressure.
cp /Users/aiwork/n8n-docker/docker-compose.yml.pre-volume-19aug \
   /Users/aiwork/n8n-docker/docker-compose.yml
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml config >/dev/null && echo YAML_OK

# 3. The bind mount must be clean AND complete before it is reopened.
ls -la /Users/aiwork/.n8n/database.sqlite*
ls -la /Users/aiwork/n8n-backups/stale-wal-19aug 2>/dev/null
```
- **Expect only `database.sqlite`.** If `-wal`/`-shm` are present, move them aside as in B4.
- ⛔ **If `/Users/aiwork/n8n-backups/stale-wal-19aug` exists and is NON-ZERO**, it holds committed transactions that belong to this database. Put it back **before** starting:
  ```bash
  mv /Users/aiwork/n8n-backups/stale-wal-19aug /Users/aiwork/.n8n/database.sqlite-wal
  ```
  (If it is 0 bytes, leave it where it is.)

```bash
# 4. Restart on the bind mount, and set the backup agent back to bind mode.
printf 'bind' > /Users/aiwork/n8n-backup/etc/mode
rm -f /Users/aiwork/n8n-backup/etc/pause
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml up -d
curl -s -o /dev/null -w 'healthz %{http_code}\n' --max-time 5 http://localhost:5678/healthz
docker logs n8n --since 3m 2>&1 | grep -i activat
```
**Expected:** `healthz 200` and an activation line.

```bash
# 5. Verify by content that you rolled back to the right point, not to 18 Aug.
cp /Users/aiwork/.n8n/database.sqlite     /Users/aiwork/n8n-migrate/rb.sqlite
cp /Users/aiwork/.n8n/database.sqlite-wal /Users/aiwork/n8n-migrate/rb.sqlite-wal 2>/dev/null
rm -f /Users/aiwork/n8n-migrate/rb.sqlite-shm
/Users/aiwork/n8n-migrate/inspect.sh /Users/aiwork/n8n-migrate/rb.sqlite
```
**Expected:** values at or above `baseline-PRE.txt`.
**If `sd.lastPollAt` has jumped back to 18 Aug:** you have rolled back onto a discarded WAL. **Stop and restore from the Phase B3 tarball or `/Users/aiwork/n8n-backups/auto/`.**

**Two things to understand about rollback:**

1. `/Users/aiwork/.n8n` is frozen at the moment of cutover. Anything the monitor learned while running on the volume is not in it. Rolling back rewinds state to Phase B. If you want the volume-era state, export it first (next section) — the volume survives rollback.
2. **Expect a notification burst afterwards**, because topics seen during the volume period are no longer in `seenTopics` and will be re-notified. A burst **proportional to the volume period** (a handful) is correct behaviour — do not "fix" it. **A burst of ~50 means you rolled back onto a discarded WAL — stop and go to step 5's failure branch.**

The volume survives rollback. Only `docker volume rm n8n_data` destroys it, so you can retry by copying the new compose file back.

---

## GETTING DATA BACK OUT OF THE VOLUME

`/var/lib/docker/volumes/n8n_data/_data` is inside the lima VM and is **not visible in Finder**.

**Route 1 — consistent snapshot while n8n runs (routine; this is what the hourly agent does).** See §0.4 `MODE=volume`, or run the agent by hand: `/Users/aiwork/n8n-backup/bin/n8n-backup.sh`. Always finish with `inspect.sh` on the result.

**Route 2 — full cold copy including `config`, `nodes/`, `storage/` (take one after anything that touches credentials):**
```bash
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml stop -t 60
docker run --rm --entrypoint sh --user 0:0 \
  -v n8n_data:/src:ro -v /Users/aiwork/n8n-backups:/backup \
  docker.n8n.io/n8nio/n8n:2.32.6 \
  -c "tar -C /src -cpzf /backup/n8n-full-$(date +%Y%m%dT%H%M%S).tgz . && echo TAR_OK"
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml up -d
```
**Expected:** `TAR_OK`. Then extract it to scratch and run `inspect.sh` before trusting it.

**Route 3 — logical export:**
```bash
docker exec n8n n8n export:entities --outputDir=/home/node/.n8n/export
docker cp n8n:/home/node/.n8n/export /Users/aiwork/n8n-backups/export-$(date +%Y%m%d)
docker exec n8n rm -rf /home/node/.n8n/export
```
⛔ The export contains the real ntfy topic. It must never go near the repo.

**Restoring INTO the volume:**
```bash
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml stop -t 60
docker run --rm --entrypoint sh --user 0:0 \
  -v n8n_data:/dst -v /Users/aiwork/n8n-backups:/backup \
  docker.n8n.io/n8nio/n8n:2.32.6 \
  -c 'rm -f /dst/database.sqlite /dst/database.sqlite-wal /dst/database.sqlite-shm && \
      cp /backup/<FILE>.sqlite /dst/database.sqlite && \
      chown 1000:1000 /dst/database.sqlite && chmod 644 /dst/database.sqlite && echo RESTORE_OK'
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml up -d
```
**Expected:** `RESTORE_OK`, then E1–E6.
⛔ **Removing the old `-wal`/`-shm` is not optional.** Writing `database.sqlite` back while a stale `-wal` remains does nothing — the WAL replays over your file on start. That cost a full cycle on 17 Aug.
⚠️ Restoring anything older than 17 Aug re-introduces the fat 5,726-byte DLQ entries; compaction was a one-off hand edit and the code only bounds *new* entries.

---

## Phase F — Follow-ups, one at a time, each with its own recreate

| # | Change | Why | Risk / gate |
|---|---|---|---|
| F1 | `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none` | ~144 executions/day are saved then hard-deleted; that pruner churn produced the 298 "Failed to hard-delete executions" errors and is the write pressure that turns a rare race into a daily one. | **Do it only after the §2.5 heartbeat is live and armed.** It deletes the rows the API-probe alternative and the E6 query depend on. The heartbeat file is immune. |
| F2 | `DB_SQLITE_POOL_SIZE=1` | One connection instead of three; costs nothing at one poll per 10 min. WAL stays on regardless — this is mitigation, not a fix. | Low. |
| F3 | VM memory (if you skipped D-2) | 2 vCPU / ~2 GB / **no swap**; an OOM kill mid-checkpoint tears a write on ext4 too. | `colima stop && colima start --cpu 2 --memory 4`. Restarts everything. |
| F4 | Confirm `/opt/homebrew/bin/n8n.DISABLED` is still disabled | Post-migration `/Users/aiwork/.n8n` is the rollback copy; a stray host `n8n` would silently mutate it. | Done in Part 0; re-check after any `brew upgrade`. |
| F5 | Confirm `start-n8n.sh.RETIRED-19aug` | Would start a second n8n on port 5678. | Done in Part 0. |
| F6 | Doc updates: `RESUME-HERE.md`, `project_automation_business_build.md`, `START-HERE.md:150` | All describe the bind mount or the old native path as live. The n8n gotchas block needs the new deploy path below. | None, but skipping it is how the next session gets it wrong. |

### ⛔ THE MIGRATION CHANGES THE DEPLOY PROCEDURE — record this before you forget

The old route used a one-off container with `-v /Users/aiwork/.n8n:/home/node/.n8n`. **That `-v` is now wrong.** Using it imports into the frozen rollback copy and reads as a perfect success while changing nothing that runs — the most confusing failure this migration can create.

```bash
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml stop -t 60
docker run --rm -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n:2.32.6 \
  import:workflow --input=/home/node/.n8n/wf-import.json
docker run --rm -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n:2.32.6 \
  publish:workflow --id=jobs-board-monitor --versionId=<NEW>
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml up -d
```
Unchanged gotchas: `import:workflow` **deactivates** the workflow (`active=0`, `activeVersionId=NULL`), so `publish:workflow` **and a container restart** are mandatory; the one-off container takes `import:workflow`, **not** `n8n import:workflow`; `docker exec n8n n8n import:workflow` against a running instance still fails; import overwrites credentials, so check `creds` before and after; retry `maxTries`/`waitBetweenTries` are hard-clamped to 5 and 5000 ms; **verify on an execution whose id is strictly greater than the pre-restart max.**

---

# PART 2 — THE EXTERNAL HEALTH CHECK

## Why the current canary cannot work

The in-workflow canary reads `lastPollAt` out of n8n workflow static data — out of the same SQLite database it is meant to be watching. It was silent through both 18 Aug failures. **A health check living inside the thing it checks is not a health check.**

The obvious replacement is not sufficient either: `/healthz/readiness` pings `SELECT 1` and stays 200 against a database whose `integrity_check` reports `btreeInitPage() returns error code 11`. A freshness signal is mandatory, and it cannot come from the database.

## The design

A launchd agent runs every 120 s. It applies a sleep/deferral gate, then runs seven probes cheapest-first, short-circuiting: colima socket → docker daemon → container running → `/healthz` → `/healthz/readiness` → **heartbeat freshness (two files)** → **SQLite error flood in the container log**. Three consecutive bad runs (~6 min) fires one urgent ntfy alert; it then goes quiet unless the *probe class* changes or 6 h elapse, with a hard 15-minute floor between any two pushes. It sends a recovery message on the way out. It pings an optional off-box dead-man URL on every healthy or skipped run. **It never opens the SQLite database.**

Two probes exist because two different things broke on 18 Aug:
- **Evening (workflow dead, DB corrupt, HTTP fine):** every cycle logged `workflow.started` then `workflow.failed` 0–1 ms later, with **zero** `node.started` events. No node ran → no heartbeat → P5 fires ~25–31 min in.
- **Morning (workflow *running*, 298 hard-delete errors in 14 min):** executions were being written, so a start-of-workflow heartbeat stays fresh throughout. Only P7, which reads the error log, catches this class.

And two heartbeat files exist because one cannot distinguish "the scheduler never fired" from "the workflow dies at node 2 every cycle."

## Why `StartInterval`, not `StartCalendarInterval`

`StartInterval` firings are **missed** while asleep and are never coalesced; `StartCalendarInterval` fires on wake into a half-awake machine with no DNS. For a watchdog on a laptop, missing runs is the correct behaviour, and the resulting gap is a free second witness.

## Why the heartbeat is a plain file, not a DB read

`immutable=1` was measured returning **empty** for a WAL-committed row — pointed at `lastPollAt` it would page you at 3 a.m. about a healthy monitor. `mode=ro` is correct but must mmap the `-shm` wal-index, which on a bind mount is the operation that caused incident #1 — and after Part 1 the database is not on a host path at all, so any host-sqlite probe simply breaks. The heartbeat file is written by n8n's own process and keeps working when the database is unreadable, which is the entire requirement.

---

## 2.1 Layout

```
/Users/aiwork/n8n-watchdog/
  bin/n8n-watchdog.sh        mode 755
  etc/ntfy-topic             real topic, mode 600, never committed   (created in Part 0)
  etc/deadman-url            optional off-box dead-man ping URL, mode 600
  etc/hb-required            touch ONLY after the heartbeat nodes are live
  hb/last-poll               written by n8n at the START of each poll
  hb/last-success            written by n8n at the END of a successful poll
  state/                     last-run, fail-count, alert-since, alert-key, last-notify, skip-count
/Users/aiwork/Library/LaunchAgents/com.benfoster.n8n-watchdog.plist
/Users/aiwork/Library/Logs/n8n-watchdog.log
```

State lives here and **explicitly not** in `~/.n8n` (now the frozen rollback copy) and **explicitly not** in SQLite (the thing being watched).

## 2.2 `/Users/aiwork/Library/LaunchAgents/com.benfoster.n8n-watchdog.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.benfoster.n8n-watchdog</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>/Users/aiwork/n8n-watchdog/bin/n8n-watchdog.sh</string>
    </array>

    <!-- StartInterval, NOT StartCalendarInterval. Interval firings are MISSED while
         asleep and are never coalesced on wake - exactly what a sleeping laptop needs,
         and the gap it leaves is the agent's own deferral witness. -->
    <key>StartInterval</key><integer>120</integer>
    <key>RunAtLoad</key><true/>

    <!-- launchd captures nothing unless told to and NEVER rotates these.
         The script truncates in place at 1 MB, preserving the inode. -->
    <key>StandardOutPath</key><string>/Users/aiwork/Library/Logs/n8n-watchdog.log</string>
    <key>StandardErrorPath</key><string>/Users/aiwork/Library/Logs/n8n-watchdog.log</string>

    <!-- launchd agents do NOT inherit a shell PATH. docker and colima are Homebrew
         symlinks, so /opt/homebrew/bin must come first. No "~" anywhere. -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <!-- colima's own agent loads in all of these. Without this the watchdog defaults
         to Aqua only, so there are states (login window, fast user switch) where n8n
         runs unwatched. -->
    <key>LimitLoadToSessionType</key>
    <array>
        <string>Aqua</string><string>Background</string><string>LoginWindow</string>
        <string>StandardIO</string><string>System</string>
    </array>

    <key>ProcessType</key><string>Background</string>
    <key>LowPriorityIO</key><true/>
    <key>Nice</key><integer>5</integer>
</dict>
</plist>
```

## 2.3 `/Users/aiwork/n8n-watchdog/bin/n8n-watchdog.sh` (mode 755)

```sh
#!/bin/sh
# n8n-watchdog - EXTERNAL health check for the jobs-board monitor.
#
# WHY THIS EXISTS: the in-workflow canary reads lastPollAt from n8n workflow static
# data, which lives in the same sqlite DB it is meant to be watching. It was silent
# through both 18 Aug 2026 failures.
#
# THIS SCRIPT NEVER OPENS THE SQLITE DATABASE.
#   - immutable=1 was measured returning EMPTY for a WAL-committed row.
#   - mode=ro needs the -shm wal-index mapped, which on a bind mount is the operation
#     that caused the 18 Aug morning outage; and after the named-volume migration the
#     DB is not on a host path at all.
set -u

ROOT=/Users/aiwork/n8n-watchdog
STATE="$ROOT/state"
HB_POLL="$ROOT/hb/last-poll"        # epoch seconds, stamped at the START of a poll
HB_OK="$ROOT/hb/last-success"       # epoch seconds, stamped at the END of a good poll
LOG=/Users/aiwork/Library/Logs/n8n-watchdog.log
SOCK=/Users/aiwork/.colima/default/docker.sock

INTERVAL=120            # MUST match StartInterval in the plist
GAP_TOLERANCE=480       # 4 intervals: above launchd jitter, far below any real sleep
WAKE_GRACE=900          # ignore everything for 15 min after a kernel wake
UPTIME_GRACE=1300       # suppress heartbeat staleness until n8n has had 2 poll cycles
STALE_POLL=1500         # last-poll older than 25 min = 2.5 missed polls
STALE_OK=3600           # last-success older than 60 min (longer: upstream may be down)
FAIL_THRESHOLD=3        # consecutive bad runs before paging (~6 min)
RENOTIFY=21600          # still-broken reminder every 6 h
NOTIFY_FLOOR=900        # hard minimum between ANY two pushes
SKIP_WEDGE=15           # consecutive SKIPs (30 min) while demonstrably executing = wedged
LOGWINDOW=6m
ERR_THRESHOLD=5

mkdir -p "$STATE" "$ROOT/hb" "$ROOT/etc" 2>/dev/null

NOW=$(date +%s)
log() { echo "$(date '+%F %T') $*"; }
rd()  { v=$(cat "$1" 2>/dev/null); case "$v" in ''|*[!0-9]*) echo 0 ;; *) echo "$v" ;; esac; }
# No timeout(1)/gtimeout(1) on this machine; perl's alarm survives exec.
tmo() { t=$1; shift; perl -e 'alarm shift; exec @ARGV' "$t" "$@" 2>/dev/null; }

# Rotate IN PLACE. Replacing the inode would orphan launchd's stdout fd and silently
# discard every line this run writes - including a BAD or NOTIFIED line.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" | tr -d ' ')" -gt 1048576 ]; then
    tail -c 262144 "$LOG" > "$LOG.tmp" && cat "$LOG.tmp" > "$LOG" && rm -f "$LOG.tmp"
fi

NTFY_TOPIC=$(cat "$ROOT/etc/ntfy-topic" 2>/dev/null)
if [ -z "${NTFY_TOPIC:-}" ]; then
    # Fail LOUD in the log. A silently-exiting watchdog is indistinguishable from a
    # healthy one, which is the failure mode this whole document exists to remove.
    log "FATAL no ntfy topic at $ROOT/etc/ntfy-topic - watchdog is MUTE"
    exit 1
fi
DEADMAN=$(cat "$ROOT/etc/deadman-url" 2>/dev/null || echo "")

ping_deadman() {
    [ -n "$DEADMAN" ] || return 0
    curl -fsS --max-time 5 -o /dev/null "$DEADMAN" 2>/dev/null || log "deadman ping failed"
}

# ---- GATE 0: should this run be suppressed? ----------------------------------
# TWO INDEPENDENT SUPPRESSION CONDITIONS, ORed. Either one alone SILENCES this run.
# Neither can page you. This biases hard toward silence, deliberately, because the
# machine is a laptop that sleeps - but that means a wedged agent looks like a quiet
# one, which is what the SKIP_WEDGE counter below exists to catch.
#   W1 kern.waketime - kernel timestamp of the last wake, no sudo.
#      NOTE the anchored ^{ sec = : a naive "sec = " also matches "usec" and silently
#      returns the microseconds field.
#   W2 our own run gap - StartInterval firings are missed while asleep. This is an
#      "the agent did not run recently" witness, and sleep is only ONE cause of that;
#      launchd may also defer a Background/LowPriorityIO job under load - which is the
#      same load the watchdog exists to detect. Hence 4 intervals, not 2.
WAKE=$(sysctl -n kern.waketime 2>/dev/null | sed -n 's/^{ sec = \([0-9]*\).*/\1/p')
if [ -z "${WAKE:-}" ]; then WAKE=$NOW; log "WARN kern.waketime unparsable - treating as just-woken"; fi
AWAKE_FOR=$(( NOW - WAKE ))
PREV=$(rd "$STATE/last-run")
GAP=$(( NOW - PREV ))
echo "$NOW" > "$STATE/last-run"

JUST_WOKE=0; [ "$AWAKE_FOR" -lt "$WAKE_GRACE" ] && JUST_WOKE=1
BIG_GAP=0;   [ "$GAP" -gt "$GAP_TOLERANCE" ] && BIG_GAP=1

if [ "$JUST_WOKE" -eq 1 ] || [ "$BIG_GAP" -eq 1 ]; then
    SKIPS=$(( $(rd "$STATE/skip-count") + 1 )); echo "$SKIPS" > "$STATE/skip-count"
    # Only a genuine WAKE invalidates accumulated evidence. A gap caused by launchd
    # deferring us must not throw away two real failures.
    [ "$JUST_WOKE" -eq 1 ] && echo 0 > "$STATE/fail-count"
    log "SKIP awake_for=${AWAKE_FOR}s gap=${GAP}s just_woke=$JUST_WOKE big_gap=$BIG_GAP skips=$SKIPS"
    if [ "$SKIPS" -ge "$SKIP_WEDGE" ]; then
        LAST_NOTE=$(rd "$STATE/last-notify")
        if [ $(( NOW - LAST_NOTE )) -ge "$NOTIFY_FLOOR" ]; then
            code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
                -H "Title: n8n watchdog WEDGED" -H "Priority: urgent" -H "Tags: warning" \
                -d "watchdog has skipped $SKIPS consecutive runs while executing - the sleep gate is stuck (awake_for=${AWAKE_FOR}s gap=${GAP}s)" \
                "https://ntfy.sh/${NTFY_TOPIC}")
            [ "$code" = "200" ] && { echo "$NOW" > "$STATE/last-notify"; log "NOTIFIED: watchdog wedged"; }
        fi
    fi
    ping_deadman
    exit 0
fi
echo 0 > "$STATE/skip-count"

# ---- PROBE LADDER: cheapest first, short-circuit on the first failure ---------
# REASON_KEY is a per-probe CONSTANT used for de-duplication. REASON is the human
# message and MAY contain a changing number (minutes stale, an HTTP code). Comparing
# the message would make "reason changed" true on every run and storm your phone.
KEY=""; REASON=""

# P1 colima socket. A socket file can outlive its listener, so this is a cheap
# pre-check only; P2 is what actually proves the daemon answers.
if [ ! -S "$SOCK" ]; then KEY=colima_sock; REASON="colima VM is down (docker socket $SOCK missing)"; fi

# P2 docker daemon + container running. Timeout-guarded: a suspended VM hangs docker.
if [ -z "$KEY" ]; then
    OUT=$(tmo 10 docker ps --filter 'name=^/n8n$' --filter status=running --format '{{.Names}}')
    if [ "$OUT" != "n8n" ]; then
        VER=$(tmo 5 docker version --format '{{.Server.Version}}')
        if [ -z "${VER:-}" ]; then
            KEY=docker_daemon; REASON="docker daemon unresponsive (colima VM hung or stopped)"
        else
            KEY=container; REASON="n8n container not running (docker ps -> '${OUT:-empty}')"
        fi
    fi
fi

# P3 liveness
if [ -z "$KEY" ]; then
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:5678/healthz)
    [ "$CODE" = "200" ] || { KEY=healthz; REASON="/healthz did not answer 200 (got ${CODE})"; }
fi

# P4 readiness. NOTE: n8n pings with 'SELECT 1', which reads no btree page, so a
# CORRUPT database still answers 200 here. Necessary, not sufficient.
if [ -z "$KEY" ]; then
    CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:5678/healthz/readiness)
    [ "$CODE" = "200" ] || { KEY=readiness; REASON="/healthz/readiness returned ${CODE} - n8n reports its DB is not connected"; }
fi

# How long has n8n been up? A container that started 90s ago has not had a chance to
# poll yet, and a fixed wall-clock wake grace does not cover a mid-day recreate.
UPSEC=$AWAKE_FOR
UPRAW=$(tmo 10 docker inspect n8n --format '{{.State.StartedAt}}' 2>/dev/null)
if [ -n "${UPRAW:-}" ]; then
    UPEPOCH=$(TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%S' "${UPRAW%.*}" +%s 2>/dev/null || echo "")
    if [ -n "$UPEPOCH" ]; then UPSEC=$(( NOW - UPEPOCH )); else log "WARN cannot parse StartedAt '$UPRAW'"; fi
fi

# P5 poll freshness. Plain host file written by n8n. No sqlite, no locks, no -shm.
# Gated on etc/hb-required so the watchdog can be installed and proven BEFORE the
# workflow is edited, and on UPTIME_GRACE so a container recreate is not a fault.
HB_AGE=-1; OK_AGE=-1
if [ -f "$ROOT/etc/hb-required" ]; then
    HBT=$(rd "$HB_POLL"); [ "$HBT" -ne 0 ] && HB_AGE=$(( NOW - HBT ))
    OKT=$(rd "$HB_OK");   [ "$OKT" -ne 0 ] && OK_AGE=$(( NOW - OKT ))
    if [ -z "$KEY" ] && [ "$UPSEC" -ge "$UPTIME_GRACE" ]; then
        if [ "$HB_AGE" -lt 0 ]; then
            KEY=hb_missing; REASON="heartbeat file missing or unreadable at $HB_POLL"
        elif [ "$HB_AGE" -gt "$STALE_POLL" ]; then
            KEY=hb_stale
            REASON="monitor has not polled for $(( HB_AGE / 60 )) min - n8n answers HTTP but the workflow is not running"
        elif [ "$OK_AGE" -lt 0 ] || [ "$OK_AGE" -gt "$STALE_OK" ]; then
            KEY=hb_nosuccess
            REASON="scheduler is firing but no poll has SUCCEEDED for $(( OK_AGE / 60 )) min - workflow is dying mid-run"
        fi
    fi
else
    HBT=$(rd "$HB_POLL"); [ "$HBT" -ne 0 ] && HB_AGE=$(( NOW - HBT ))
    OKT=$(rd "$HB_OK");   [ "$OKT" -ne 0 ] && OK_AGE=$(( NOW - OKT ))
fi

# P6 SQLite error flood. This is the ONLY probe that catches the 18 Aug MORNING
# failure: the workflow kept executing (so the heartbeat stayed fresh) while n8n
# logged 298 hard-delete errors in 14 minutes.
if [ -z "$KEY" ]; then
    N=$(tmo 15 docker logs n8n --since "$LOGWINDOW" 2>&1 \
        | grep -cE 'SQLITE_(CORRUPT|IOERR|BUSY|READONLY)|Failed to hard-delete' || true)
    case "${N:-0}" in ''|*[!0-9]*) N=0 ;; esac
    [ "$N" -gt "$ERR_THRESHOLD" ] && { KEY=sqlite_errors; REASON="n8n logged $N SQLite errors in the last $LOGWINDOW"; }
fi

# ---- HYSTERESIS + NOTIFICATION ----------------------------------------------
FAILS=$(rd "$STATE/fail-count")
ALERT_AT=$(rd "$STATE/alert-since")
LAST_NOTE=$(rd "$STATE/last-notify")
ALERT_KEY=$(cat "$STATE/alert-key" 2>/dev/null || echo "")

# Returns 0 only if the push actually landed, so callers never record state on a
# failed send. The most likely moment for a send to fail is the known benign
# wake-time getaddrinfo ENOTFOUND blip.
notify() {  # $1 priority  $2 tags  $3 title  $4 body
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
        -H "Title: $3" -H "Priority: $1" -H "Tags: $2" \
        -d "$4" "https://ntfy.sh/${NTFY_TOPIC}")
    if [ "$code" = "200" ]; then
        echo "$NOW" > "$STATE/last-notify"; log "NOTIFIED: $3"; return 0
    fi
    log "NOTIFY FAILED (http=$code) - state not recorded, will retry next run"
    return 1
}

if [ -n "$KEY" ]; then
    FAILS=$(( FAILS + 1 )); echo "$FAILS" > "$STATE/fail-count"
    log "BAD ${FAILS}/${FAIL_THRESHOLD} [$KEY]: $REASON"
    [ "$FAILS" -lt "$FAIL_THRESHOLD" ] && exit 0

    if [ "$ALERT_AT" -eq 0 ]; then
        # First page. Commit alert state ONLY on a successful send, otherwise the next
        # run would fall through to the low-priority "STILL down / 0h so far" branch
        # and that would be the only alert you ever got for a dead monitor.
        if notify urgent "rotating_light" "n8n monitor DOWN" \
"$REASON

awake ${AWAKE_FOR}s  n8n up ${UPSEC}s  $(date '+%F %T %Z')"; then
            echo "$NOW" > "$STATE/alert-since"; printf '%s' "$KEY" > "$STATE/alert-key"
        fi
    elif [ "$KEY" != "$ALERT_KEY" ] && [ $(( NOW - LAST_NOTE )) -ge "$NOTIFY_FLOOR" ]; then
        # A changed probe CLASS is real information. The floor stops a flapping key
        # from storming.
        notify urgent "rotating_light" "n8n monitor DOWN (now: $KEY)" "$REASON" \
          && printf '%s' "$KEY" > "$STATE/alert-key"
    elif [ $(( NOW - LAST_NOTE )) -ge "$RENOTIFY" ]; then
        notify default "hourglass" "n8n monitor STILL down" \
            "$(( (NOW - ALERT_AT) / 3600 ))h so far [$KEY]: $REASON"
    fi
else
    echo 0 > "$STATE/fail-count"
    if [ "$ALERT_AT" -ne 0 ]; then
        if notify default "white_check_mark" "n8n monitor recovered" \
            "back after $(( (NOW - ALERT_AT) / 60 )) min down"; then
            rm -f "$STATE/alert-since" "$STATE/alert-key" "$STATE/last-notify"
        fi
    fi
    log "OK poll_age=${HB_AGE}s success_age=${OK_AGE}s up=${UPSEC}s awake=${AWAKE_FOR}s"
    ping_deadman
fi
exit 0
```

## 2.4 Install

```bash
chmod 755 /Users/aiwork/n8n-watchdog/bin/n8n-watchdog.sh
# Optional (decision D-4): off-box dead-man's switch.
printf '%s' 'https://hc-ping.com/<YOUR-UUID>' > /Users/aiwork/n8n-watchdog/etc/deadman-url
chmod 600 /Users/aiwork/n8n-watchdog/etc/deadman-url
# Do NOT create etc/hb-required yet.

sh -n /Users/aiwork/n8n-watchdog/bin/n8n-watchdog.sh && echo SYNTAX_OK
launchctl bootstrap gui/501 /Users/aiwork/Library/LaunchAgents/com.benfoster.n8n-watchdog.plist
launchctl enable    gui/501/com.benfoster.n8n-watchdog
launchctl kickstart -p gui/501/com.benfoster.n8n-watchdog
launchctl print gui/501/com.benfoster.n8n-watchdog | grep -E 'state|last exit code|runs'
tail -20 /Users/aiwork/Library/Logs/n8n-watchdog.log
```
**Expected within ~2 min:** `SYNTAX_OK`, `last exit code = 0`, and a log line that is either `SKIP awake_for=…` (if the Mac woke under 15 min ago) or `OK poll_age=-1s success_age=-1s up=…s awake=…s`.
**If you see `FATAL no ntfy topic`:** Part 0 §0.3 did not land. Fix it; the watchdog is mute until then.
**If nothing appears at all:** `launchctl print` will show a non-zero exit code. Check the PATH block and the script path.
**Do not use `launchctl load`** — it is legacy on this machine. The old agent label `com.benfoster.n8n` was booted out and its plist deleted; do not reuse it.

**Uninstall — one line, no sudo:**
```bash
launchctl bootout gui/501/com.benfoster.n8n-watchdog
```

## 2.5 Adding the heartbeat (a SEPARATE change, after the watchdog is proven)

### Step 1 — a second, tiny bind mount

Add under `volumes:` in `/Users/aiwork/n8n-docker/docker-compose.yml`:
```yaml
      - n8n_data:/home/node/.n8n
      - /Users/aiwork/n8n-watchdog/hb:/home/node/health   # heartbeat only; NOT sqlite
```
```bash
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml up -d
docker exec n8n sh -c 'id; touch /home/node/health/.probe && echo WRITABLE && rm /home/node/health/.probe'
```
**Expected:** `uid=1000(node)`, then `WRITABLE`.
**If not writable:** `chmod 777` is wrong; check that the host dir exists and is owned by you.

**Yes, this is a virtiofs bind mount again, and that is fine.** The hazard is SQLite's `-shm` mmap and cross-boundary locking, not file I/O. This is one 10-byte plain-text file, opened, written, closed. It *must* be a host path precisely because the database no longer is.

### Step 2 — six nodes, in two PARALLEL branches

⛔ **Wire these as parallel branches. Never in series with `Fetch Jobs Board`.** If a heartbeat write throws while it sits in the fetch path, the poll never happens — the health instrument becomes able to manufacture the exact fault it reports. That violates the same principle that keeps `Notify Canary` unwired from the DLQ (a test asserts that connection's absence).

**Branch A — "the scheduler fired" (new *second* connection on `Poll Every 10 Minutes` `main[0]`; leave the existing connection to `Fetch Jobs Board` exactly as it is):**
1. `Stamp Poll HB` — Code: `return [{ json: { ts: Math.floor(Date.now()/1000).toString() } }];`
2. `Poll HB To File` — Convert to File, operation `toText`, source property `ts`, binary property `data`
3. `Write Poll HB` — Read/Write Files from Disk, operation `write`, file name `/home/node/health/last-poll`, data property `data`, **`onError: continueRegularOutput`, `retryOnFail: false`**

**Branch B — "a poll actually completed" (new connections from BOTH success terminals, `Record Notified` and `Nothing New`):**
4. `Stamp Success HB` — Code: same one-liner
5. `Success HB To File` — Convert to File, same settings
6. `Write Success HB` — Read/Write Files from Disk, file name `/home/node/health/last-success`, **same `onError` / `retryOnFail` settings**

Both node types ship in 2.32.6, so there is no `NODE_FUNCTION_ALLOW_BUILTIN` and no task-runner `fs` restriction to fight.

⛔ **Making the edit:** UI "Import from File" **APPENDS** (19 nodes became 37, suffixed `1`) — clear the canvas with Cmd+A/Delete first, or do the edit by hand in the UI. The CLI route **deactivates** the workflow and needs `publish:workflow` plus a container restart, and now needs the **new volume path** (Phase F deploy block).

### Step 3 — propagate to the deploy artifacts, or one redeploy silently deletes the heartbeat

`/Users/aiwork/.n8n/wf-import.json` currently holds 20 nodes and none of them are heartbeat nodes. The Phase F deploy sequence imports from that file and would strip the six nodes you just added; the watchdog would then page 25 minutes later with a reason pointing at n8n rather than at the deploy.

```bash
docker exec n8n n8n export:entities --outputDir=/home/node/.n8n/export
docker cp n8n:/home/node/.n8n/export /Users/aiwork/n8n-migrate/export
docker exec n8n rm -rf /home/node/.n8n/export
```
Then update all three, deliberately:
- `wf-import.json` (in the volume, and the host copy) — full 26-node workflow, real topic
- `workflow.local.json` (git-ignored) — full workflow, real topic
- public `workflow.json` — full workflow, topic replaced with `CHANGE-ME`

And add tests asserting: the three Branch-A nodes exist and are connected to `Poll Every 10 Minutes`; the three Branch-B nodes exist and are connected to both success terminals; `Fetch Jobs Board`'s inputs are unchanged; the public `workflow.json` still contains `CHANGE-ME`; and the topic strings in the Code nodes still match each other.

### Step 4 — arm it

```bash
cat /Users/aiwork/n8n-watchdog/hb/last-poll
cat /Users/aiwork/n8n-watchdog/hb/last-success
date -r "$(cat /Users/aiwork/n8n-watchdog/hb/last-poll)"
touch /Users/aiwork/n8n-watchdog/etc/hb-required
```
**Expected:** two 10-digit epochs, the poll one within the last 10 minutes.
**If `last-success` is missing:** Branch B is not wired to a terminal that actually ran this cycle. Fix it before arming, or the watchdog pages on `hb_nosuccess` in an hour.

### Zero-edit interim (only if you will not touch the workflow today)

`GET /api/v1/executions?workflowId=jobs-board-monitor&limit=1` with an `X-N8N-API-KEY` header; the public API is enabled (it answers `401 {"message":"'X-N8N-API-KEY' header required"}`, not 404) and reads through n8n's own pool, opening no second SQLite connection. ⚠️ It is **incompatible with F1**, which deletes exactly the rows it counts. Pick one: heartbeat + F1 (recommended), or API probe and no F1.

## 2.6 THE TEST THAT PROVES IT FIRES — safe, reversible, in order

### T1. Does it page when something is genuinely dead? (negative control)
```bash
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml stop -t 60
tail -f /Users/aiwork/Library/Logs/n8n-watchdog.log
```
**Expected:** `BAD 1/3 [container]`, `BAD 2/3 [container]`, `BAD 3/3 [container]` → `NOTIFIED: n8n monitor DOWN`, and a push on your phone. **~6 minutes.**
```bash
docker compose -f /Users/aiwork/n8n-docker/docker-compose.yml up -d
```
**Expected:** the next good run logs `NOTIFIED: n8n monitor recovered`.
**⚠️ Use `compose stop -t 60`, not bare `docker stop`** — that would use the 10 s default and SIGKILL n8n mid-checkpoint. Keep the whole test under 10 minutes and start it right after a poll lands.

### T2. Does the gap witness suppress a false alarm?
```bash
echo $(( $(date +%s) - 3600 )) > /Users/aiwork/n8n-watchdog/state/last-run
launchctl kickstart -p gui/501/com.benfoster.n8n-watchdog
tail -3 /Users/aiwork/Library/Logs/n8n-watchdog.log
```
**Expected:** `SKIP awake_for=… gap=3600s just_woke=0 big_gap=1 skips=1`. No probes ran, no page, and — because `just_woke=0` — `fail-count` was **not** reset.

### T3. The real sleep test
Close the lid for 30 minutes. Open it. `tail -f` the log.
**Expected:** a **clean gap with no lines at all** during sleep (missed `StartInterval` firings — the design working), then a run of `SKIP` lines for ~15 minutes, then `OK`. **Zero notifications.**
**If you get a page:** report the `awake_for` and `up` values in it; `WAKE_GRACE` or `UPTIME_GRACE` is too tight for this machine's boot chain.

### T4. Does the freshness probe fire? (after §2.5 only)
```bash
echo $(( $(date +%s) - 3600 )) > /Users/aiwork/n8n-watchdog/hb/last-poll
```
**Expected after 3 runs:** `NOTIFIED: n8n monitor DOWN` with `monitor has not polled for 60 min - n8n answers HTTP but the workflow is not running`.
**This is the 18 Aug evening scenario**: container up, `/healthz` 200, readiness 200, DB corrupt, workflow dead. Nothing above P5 catches it.
**Undo:** wait for the next real poll (≤10 min) or `date +%s > /Users/aiwork/n8n-watchdog/hb/last-poll`.

### T5. Does the stale-heartbeat alert repeat itself into a storm? (the anti-spam test)
Leave T4's fake stale timestamp in place for **20 minutes** without fixing it.
**Expected:** exactly **one** urgent push, then silence. The log shows repeated `BAD n/3 [hb_stale]` lines and **no further `NOTIFIED:` lines**.
**If you receive a push every ~2 minutes:** the reason-key separation has been broken — `$KEY`, not `$REASON`, must be what is written to and compared against `state/alert-key`.

### T6. Does the error-flood probe fire? (the 18 Aug morning class)
```bash
docker exec n8n sh -c 'for i in 1 2 3 4 5 6 7 8; do echo "SQLITE_IOERR: disk I/O error (synthetic test)" >&2; done'
```
**Expected after 3 runs:** `BAD n/3 [sqlite_errors]` then a push reading `n8n logged 8 SQLite errors in the last 6m`.
**Undo:** nothing — the 6-minute window rolls off by itself; the recovery message follows.
**If it does not fire:** confirm `docker logs n8n --since 6m 2>&1 | grep -c SQLITE_IOERR` returns 8 by hand. This probe is the only thing standing between you and a repeat of the morning outage.

### T7. Verify pushes without a phone
```bash
curl -s "https://ntfy.sh/<topic>/json?poll=1&since=30m"
```
Reads the topic's own history.

### T8. Settle the DarkWake question (overnight, zero side effects)
```bash
while :; do
  echo "$(date '+%F %T') waketime=$(sysctl -n kern.waketime | sed -n 's/^{ sec = \([0-9]*\).*/\1/p')"
  sleep 60
done >> /Users/aiwork/n8n-watchdog/waketime-probe.log
# next morning:
pmset -g log | grep -E 'DarkWake|Wake from' | tail -40
```
`pmset -g log` shows DarkWake→Sleep cycles of 2–10 seconds every ~15–17 minutes all night. Two agent runs 120 s apart cannot both land inside a 10-second DarkWake, so the gap witness blocks it either way. Run this so the next person does not have to re-derive it.

## 2.7 Retiring the internal canary

Only after the external watchdog has survived **one full sleep cycle (T3)** and **one T1, T4, T5 and T6 pass**. Then delete `Canary Schedule`, `Canary Check`, `Fetch Broken?`, `Raise Alert`, `Healthy`, `Notify Canary`.

Why: the canary reads `lastPollAt` from the database it is watching, so it provably cannot fire when it matters, and it adds a second schedule trigger writing to static data every 6 hours (4 writes/day) on the database you are trying to stop corrupting.

⛔ **Constraints that survive the retirement — do not "simplify" these away:**
- `Notify Canary` is deliberately **not** wired to the DLQ, with a test asserting the connection's absence. The alert path must not be able to manufacture the fault it reports. The external watchdog inherits that principle: it lives outside the container, outside the VM, and outside SQLite — and §2.5's parallel wiring is the same rule applied to the heartbeat.
- The ntfy topic string appears in **two** Code nodes (`Select New Postings`, `Canary Check`) with no shared module, and a test asserts they match. Removing `Canary Check` may break that test — **update the assertion deliberately, do not delete it.** Alerts going to a topic nobody is subscribed to look exactly like no alerts at all.
- A test asserts `CHANGE-ME` in the public `workflow.json`. The real topic lives only in git-ignored `workflow.local.json`, in `wf-import.json`, in `~/n8n-watchdog/etc/ntfy-topic`, and in `~/n8n-docker/backups/db-backup-17aug.sqlite` — none of which may move inside the repo.
- Scheduled Claude tasks are **not** a valid substrate for this: they do not run on a sleeping Mac and only fire while Claude is open. launchd is the right layer.
- A flat "older than a day is stale" rule would have swallowed the entire weekend. The sleep gate exists specifically to avoid re-inventing that mistake.

---

# WHAT THIS DOES NOT FIX

**Corruption vectors still open after Part 1:**
1. **Abrupt VM death.** The guest ext4 lives inside a 20 GiB sparse disk image on APFS (`~/.colima/_lima/colima/disk`). A hard kill, a forced logout, or power loss can leave that image mid-write with fsyncs that never reached APFS. Before migration the database sat directly on APFS; after, it sits one layer further away. **Always `colima stop`. Never kill the VM.**
2. **OOM.** If you skipped D-2/F3, the VM has ~2 GB and **no swap**, with n8n alone at ~41% of total RAM. An OOM kill mid-checkpoint tears a write on ext4 exactly as on virtiofs.
3. **Host disk pressure.** Nothing here monitors free space on APFS or in the VM. A full disk during a checkpoint is a corruption event.
4. **n8n's own bugs**, and anything the pinned image does on a future upgrade. The pin is protection, not immunity — an unpinned upgrade would run schema migrations unattended.

**What the migration did NOT prove:** that virtiofs caused either 18 Aug incident. A two-writer probe on that mount did not reproduce it, and the host-binary second-writer hypothesis (now removed by Part 0 §0.5) remains at least as likely. If corruption recurs on ext4, you have learned something important — write it down.

**Data-loss floor:** the backup agent runs hourly, so worst-case loss is ~60 minutes of `seenTopics`/`notifyCount`/`lastPollAt`. That is a deliberate trade, not an accident. Shorten `StartInterval` if you want a tighter floor.

**Monitoring gaps that remain by design:**
- **A sleeping or shut-down Mac is not monitored at all**, and the watchdog will not tell you it is not monitoring. Only the off-box dead-man's switch (D-4) turns that silence into an alarm.
- The watchdog cannot page you about its own death, a bad plist, a `bootout`, or a full disk. The `SKIP_WEDGE` counter catches one specific wedge; the dead-man ping catches the rest. Without D-4, "healthy" and "dead" are the same observable.
- The heartbeat proves the scheduler fired and that a poll reached a success terminal. It does **not** prove the notification was correct, that ntfy delivered it, or that your phone was subscribed. ntfy.sh is a free public service with no delivery guarantee.
- `/healthz/readiness` remains unable to detect a corrupt database; nothing in the ladder runs `integrity_check`. P6 catches the *error log*, which is a proxy, not a proof.
- P6's window is 6 minutes with a threshold of 5. A slow trickle of one SQLite error every few minutes stays under it.

**Operational debt this creates:**
- The deploy procedure changed (Phase F). Using the old `-v /Users/aiwork/.n8n:...` would import into the frozen rollback copy and read as a perfect success while changing nothing that runs.
- `/Users/aiwork/.n8n` is now a frozen artifact that looks live. Anyone (or anything) writing to it is editing a museum piece.
- Six new nodes exist in the live workflow and must be kept in `wf-import.json`, `workflow.local.json`, and the public `workflow.json` or the next redeploy deletes them.
- `/opt/homebrew/bin/n8n.DISABLED` will silently reappear as `n8n` on the next `brew upgrade n8n`.