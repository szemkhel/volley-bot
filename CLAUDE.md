# CLAUDE.md — volley-bot

WhatsApp bot for the volleyball group **"Rajszew team 🏐"**. Weekly polls, AI-written Polish
reminders, attendance stats, MVP voting, hall-cost settlement, calendar feed, public Grafana
dashboard.

This file is the working context for sessions started in `C:\Users\patry\volley-bot`.
Deeper project history and open TODOs live in the project memory (`project_whatsapp_agent`).

## Where things run

| | |
|---|---|
| Local clone (edit here) | `C:\Users\patry\volley-bot` |
| Production | LXC **119** (`192.168.31.203`), `/opt/whatsapp-agent`, systemd `whatsapp-agent.service` |
| Repo | `szemkhel/volley-bot` — **public**; source on `main`, calendar feed on orphan branch `calendar` |
| Postgres (stats mirror) | LXC 107 (`192.168.31.103:5432`), DB `volley` |
| Public stats dashboard | https://siatkowka.agatrymki.net/public-dashboards/04eb09a0ce994c36851e51d5e877f1b4 |
| Container ops | `mcp__proxmox__proxmox_execute_vm_command(node=pve, vmid=119, type=lxc, …)` |
| Logs | `journalctl -u whatsapp-agent -f`, or central Loki via the `/loki` skill |

The bot runs on the **owner's own WhatsApp number** (48690331000, Patryk) via Baileys pair-code.
Auth lives in `auth_info/` on the container — **never delete it**, it would force a re-pair.

## Commands

```bash
npm run check    # node --check on index/reminder/scheduler/notify/lib
npm test         # node --test — 26 tests, all must pass (auto-discovers test/; do NOT pass test/ as an arg on Node 22)
```

Both must be green before pushing. CI (`.github/workflows/ci.yml`, job `test`) runs the same.

## Layout

- `index.js` (~1600 lines) — the bot: connection, command dispatch, poll/vote handling, state, crons.
- `reminder.js` — all Anthropic calls. `CREATIVE_MODEL = "claude-sonnet-4-6"` for Polish prose
  (reminders, motivation, MVP congrats — Haiku produced poor Polish); `CLASSIFY_MODEL =
  "claude-haiku-4-5-20251001"` for classification (day detection, response analysis, command intent).
- `scheduler.js` — per-game cron reminder pairs.
- `lib.js` — pure helpers, **this is what the tests cover**. Put testable logic here.
- `db.js` — best-effort Postgres mirror; no-op when `DATABASE_URL` is unset.
- `chart.js` — frekwencja PNG bar chart via `@napi-rs/canvas`.
- `notify.js` — owner self-chat DM.
- `avatars.js` — monthly cache of member profile pictures (`avatars/`, gitignored) for the MVP
  caricature feature. Cron 1st @ 04:00; hidden owner self-chat trigger `avatary` to run on demand.
- `find-group.js`, `create-test-group.js`, `trigger.js` — one-shot helpers.
- `releases.json` — user-facing changelog in Polish, newest first; feeds `bot zmiany`. Currently **v1.22**.

Data files (`state.json`, `history.json`, `contacts.json`, `mvp.json`, `weeklog.json`,
`suggestions.json`, `config.json`, `.env`, `auth_info/`) are **gitignored and live only on the
container**. They survive deploys; tracked files do not (see below).

## Hard rules

1. **Never edit tracked files directly on the container.** `deploy.sh` runs from cron every 3
   minutes and does `git reset --hard origin/main` — live edits are wiped. All code changes go
   through branch → PR → squash-merge.
2. **No real secrets in the repo — and none on GitHub at all.** Secrets live in the container
   `.env` (`ANTHROPIC_API_KEY`, `PHONE`, `NOTIFY_JID`, `NOTIFY_LID`, `BLIK_NUMBER`,
   `DATABASE_URL`, `LOG_LEVEL`), backed up **locally only** to `C:\Users\patry\.claude\volley.env`.
   `config.example.json` / `.env.example` carry placeholders only. The old private
   `szemkhel/volley-secrets` repo was deleted on 2026-08-01 — credentials must never leave the
   local machine, so don't recreate it.
3. **Every functional change updates all four surfaces** — see the release loop below.
4. Commit author is `Volley Bot <bot@volley.local>` (the real email is blocked by GitHub privacy).
   Leave it as is.
5. On Windows `core.autocrlf=true`, so `git show` smudges to CRLF. That's a false alarm — check
   real line endings with `git ls-files --eol`.

## Release loop

Use the **`/volley-release`** skill (user-scope, available from any directory) — it has the full
recipe. In short, for every functional change update **all** of:

1. `README.md` (including the command list)
2. the in-bot `bot pomoc` / help text in `index.js`
3. `releases.json` — prepend `{version, date, notes}`, notes in Polish, date like `"7 lipca 2026"`
4. project memory

then `npm run check && npm test` → branch → push → PR → squash-merge → verify deploy.

`main` is branch-protected (PR + code-owner review + required `test` check), but `enforce_admins=FALSE`,
so the szemkhel PAT bypasses it — I open and merge the PR myself rather than handing it back.

**Auth:** there is no `gh` CLI and Git Credential Manager won't release the token non-interactively.
Recover the classic PAT from the container clone's remote:

```
git -C /opt/whatsapp-agent remote get-url origin | grep -oE 'ghp_[A-Za-z0-9]+'
```

Hold it in-session only, push via an inline-token URL (never write it into `.git/config`), and
scrub it from any echoed output. The same PAT also authenticates the `github` MCP server.
It is flagged for rotation to a fine-grained token.

**Deploy:** `deploy.sh` on cron `*/3`, or trigger now with
`cd /opt/whatsapp-agent && bash deploy.sh`. It validates (`node --check` on every `*.js` +
`npm test`) before restarting and **auto-rolls-back** to the previous SHA if validation fails,
logging to `NEEDS_REPAIR.txt`. The bot never crash-loops on a bad `main`.
Verify: `git rev-parse --short HEAD` + `systemctl is-active whatsapp-agent`.

## Domain gotchas

- **LID, not phone.** The group is LID-addressed: participants are `<num>@lid` and
  `groupMetadata` returns **empty** `notify` fields, so WhatsApp gives no names. Names come only
  from `contacts.json`, keyed by LID user-part and filled from `msg.pushName` — a member resolves
  to a real name only after posting at least once, otherwise `Gracz <last4>`. Any naming fix must
  key by **LID**, never phone number.
- **Poll vote decryption** needs `pollCreatorJid` = `jidNormalizedUser(sock.user.lid)`. The raw
  `sock.user.lid` carries a device suffix (`:5`) and fails with
  `Unsupported state or unable to authenticate data`.
- **Votes arrive on both** `messages.upsert` (the owner's own vote is `fromMe:true`, handled
  *before* the fromMe skip) and `messages.update`.
- **Never capture the socket in a closure.** Baileys reconnects several times a day and
  reassigns module-level `sock`. `scheduler.js` therefore takes a `getSock` *getter*
  (`const getSock = () => sock` in index.js) and `fireReminder` retries transient connection
  errors up to 15× at 60s. This was the root cause of silently missed reminders.
- **Multi-poll model.** `state.polls[]` tracks several concurrent games; each poll owns its
  `voters`, `gameDay`, `gameTime`, `gameDate`, `messageKey`, `encKeyB64`. `migrateState()`
  converts the old single-`activePoll` shape and runs idempotently on every load.
- **Soft cancel.** `nie gramy` sets `cancelled = true` (keeps key and votes, `cofnij` re-enables).
  A poll is finalized into history only by a settlement (`settleAndClose`) or by `finalizePolls()`
  once `gameDate + finalizeGraceDays` (default 3) has passed.
- **Test mode.** When `config.groupJid === config.testGroupJid` the bot reads/writes `*.test.json`,
  so test activity never pollutes production stats. `config.json` and `contacts.json` stay shared;
  the calendar and the Sunday digest always read **production** files.
- **Every group message is prefixed** `🤖SiatkoBot🤖` by a wrapper installed on `sock.sendMessage`
  after each reconnect — this is also the loop-prevention filter. Images aren't auto-tagged; their
  captions prefix `BOT_TAG` manually.
- **Hidden features** (deliberately absent from `pomoc`, README and the changelog): the Sunday
  20:00 feature-proposal digest (test group only) and the owner-only `bot imie @osoba <name>`.
  Keep them undocumented.

## Style

Polish for everything user-facing (bot messages, README, release notes); English for code,
comments and commit messages. Comments in this codebase explain *why* — especially around the
LID/socket/vote-decryption traps. Match that.
