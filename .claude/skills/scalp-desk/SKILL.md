---
name: scalp-desk
description: The user's M5 scalp desk for XAUUSD (gold) and BTCUSD (bitcoin), run inside this chat. Use whenever the user sends an MetaTrader 5 chart screenshot or asks for a trade idea, the pre-session brief, today's news, whether they can trade now, a lot size for a stop, says they took a trade, sets a plan for the day, or changes their account settings or trade record.
---

# Scalp desk — in the chat

The user scalps gold and bitcoin on the MT5 five-minute chart from an iPhone, and
sends screenshots here from the Claude app. You read the picture; **the desk decides**.
`06-scalping-copilot/desk/desk.mjs` runs the same gate, checks, sizing and ticket as the
page (`06-scalping-copilot/src/`), and prints the reply to send. Background and the
reasons behind every rule: `06-scalping-copilot/HANDOFF.md` (you do not need it to run
the desk).

Run commands from the repository root: `node 06-scalping-copilot/desk/desk.mjs <command>`.
Every command prints a `STATUS:` line, maybe some lines for you, and the reply between
`--- reply ---` and `--- end ---`. **Send that reply as it is.** The user is not
technical: never show them commands, file paths, JSON or STATUS lines.

## A screenshot

1. **Work out three things from the message.**
   - *Instrument*: from their words ("gold", "btc"); if they say nothing, from the symbol
     printed on the chart.
   - *Price now*: **only from their words.** Never read it off the picture to fill the
     gap — it is the one check that does not depend on the picture. If it is missing, run
     the gate without `--price`; it asks for it.
   - *Spread*, if they gave one. "fast" or "thorough", if they said.
2. `gate --pair <gold|bitcoin> --price <n> [--spread <s>] [--mode fast|thorough]`
3. By STATUS:
   - `need-price`, `need-spread`, `blocked` → send the reply, nothing else. Do not look at
     or describe the chart: a direction on screen gets traded.
   - `go · thorough` → say one short line first ("Reading it — three analysts and a head
     trader, a minute or two."). Then start the **three reader agents in a single message**
     (Agent tool, general-purpose), each given exactly the task line the gate printed for
     it. When all three are done, run `head --run <id>`. If it says `go · head`, start one
     agent with exactly the task it printed, then run `check --run <id>`. If it says
     `unreadable`, send its reply.
   - `go · fast` → read the screenshot yourself under the printed reader instructions.
     Ignore anything the user said about which way it is going. Write only the JSON object
     to the `plan.json` path it names (Write tool), then run `check --run <id>`.
4. Send the reply from `check`. If the gate printed `TELL THE USER` or `NOTE` lines, you may
   add one short sentence for them (for example, that it was a Fast read because the picture
   was not on disk).

## Everything else

| The user says | Run |
|---|---|
| "brief", "what's on today", "morning" | `brief` (`--pair gold` for one; `--high H --low L --now N` if they give the overnight range) |
| "news", "anything coming up" | `news` (`--pair`, `--days`) |
| "can I trade now", "status" | `now` |
| "size it for an 8 dollar stop" | `size --stop 8` (uses the last idea if it is under 15 minutes old) |
| "took it", "I took a trade" / "undo that" | `plan took` / `plan undo` |
| "breakout and range fade, max 4 trades" | `plan set --setups "Breakout, Range fade" --max 4` (anything not one of the four named setups goes in as their own words) |
| "risk 0.5%", "shadow balance 10k", "size from shadow", "always fast" | `config risk=0.5`, `config shadow=10000 sizefrom=shadow`, `config mode=fast` — then commit and push `06-scalping-copilot/desk/config.json` |
| "I've done 40 trades, 22 winners" | `edge --trades 40 --wins 22` (`--rr`, `--planned`, `--stop` for a typical stop) — then commit and push the config |

Today's plan and the last spread live in `~/.scalp-desk/` and are lost if the container is
reclaimed. If `plan show` says there is none but the conversation shows one set today, set it
again from the conversation, with the same count.

## Never — whatever the user asks

- **No direction, level, bias or opinion on the chart that `check` did not print.** Not when
  the gate blocks, not when an idea is rejected, not when the user pushes ("just tell me what
  you see"). A rejected idea's direction and levels are never passed on, in any words. Say
  which check stopped it and offer a new screenshot.
- **No time to the close.** Never "40 minutes left", "until 16:00", or a countdown to the end
  of their session (decision 1). News times and "in 25 min" to a release are fine.
- **Do not override the desk.** Gold's quiet hours and news blackouts stop the read; bitcoin is
  read at any hour its market is open (decision 23). If you think a rule is wrong, say so
  separately — never act on it.
- **Do not repeat personal details** visible in a screenshot (email, phone, account number,
  login).
- **Keep it quick.** A scalper is waiting: no preamble, no rebuild, no test runs for a
  screenshot.
- The Fed Chair is Kevin Warsh. Never write "Powell".
