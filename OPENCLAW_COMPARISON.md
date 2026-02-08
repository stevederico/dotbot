# OpenClaw vs dotBot — Feature Comparison

## Already Possible Today

| Use Case | How (dotBot tools) |
|---|---|
| Summarizing PDFs | `web_fetch` to grab content, LLM summarizes |
| Writing work reports from git commits | `run_code` to exec `git log`, LLM formats |
| Web browsing / research | `web_search` + `web_fetch` |
| Remembering preferences & context | `memory_save` + `memory_search` |
| Scheduled reminders / recurring prompts | `schedule_task` with cron intervals |
| Simple code execution | `run_code` (JS, 10s timeout) |
| File-based workflows | `file_read` + `file_write` (sandboxed to `~/.dotbot`) |

## Achievable With New Tools

| Use Case | Tool Needed | Difficulty |
|---|---|---|
| Email management | `send_email` / IMAP tool | Medium — API integration |
| Calendar scheduling | Google Calendar API tool | Medium |
| Docker container management | `run_command` (shell exec, not just JS) | Low — extend `run_code` to shell |
| Deploy static sites | `run_command` + git push | Low |
| Smart home (Home Assistant) | `http_request` tool hitting HA REST API | Low |
| WHOOP / health metrics | API fetch tool with auth headers | Low |
| Kubernetes management | `run_command` with kubectl | Medium — security implications |

## Hard / Architectural Gaps

| Use Case | What's Missing |
|---|---|
| Messaging platform integration (WhatsApp, iMessage, Telegram) | dotBot is web-only — no messaging bridge layer |
| "Always on" autonomous agent | No persistent daemon; agent only runs on user request |
| Auto-accept command execution | Sandboxed by design (`~/.dotbot` only, 10s timeout) — this is a **feature**, not a bug |
| Bot-to-bot social interaction (Moltbook) | No outbound agent identity or inter-agent protocol |

## The Honest Assessment

dotBot can handle **~60-70%** of the practical OpenClaw use cases right now with minimal work. The biggest gaps are:

1. **No general shell execution** — `run_code` is JS-only with a 10s timeout. A `run_command` tool would unlock Docker, git deploys, kubectl, etc.
2. **No messaging bridge** — OpenClaw's killer feature is WhatsApp/Telegram access. dotBot is browser-only.
3. **No persistent daemon mode** — cron fires tasks, but there's no always-on agent loop watching for external events.

The security tradeoff is intentional. OpenClaw's "auto-accept everything" model is exactly what's getting it criticized. dotBot's sandbox (`~/.dotbot`, no shell escape, 10s timeout) is the right default — selectively open permissions per tool rather than go full OpenClaw.

## Lowest-Hanging Fruit

A `run_command` tool with an allowlist of safe binaries (`git`, `docker`, `curl`) would unlock the most new use cases with the least effort.

## See Also

- [DAEMON_PLAN.md](./DAEMON_PLAN.md) — Implementation plan for persistent daemon mode
