---
description: Install the project's stack — PostgreSQL, Redis, Node.js, Python, Java — on the machine Sloth runs on, start the services and verify each tool answers
argument-hint: <tool-id…> (postgresql redis node python java)
allowed-tools: Bash, Read, Grep, Glob
---

# Install the stack on this machine

Install the tools in `$SLOTH_STACK_INSTALL` (the same list as `$ARGUMENTS`; ids out of `postgresql`,
`redis`, `node`, `python`, `java`) **on the machine you are running on**, leave their services running and
verify each one answers. Nothing else: no repository work, no `git`, no branch, no PR, no board, no comment.
You are not in a checkout's worktree — do not touch the repository you happen to be started in.

## Sudo

On Linux, exactly these run under sudo and only with `-n` (never a password prompt):

```bash
sudo -n apt-get update -q
sudo -n apt-get install -y -q <packages>
sudo -n service <name> start          # or sudo -n systemctl start <name>
sudo -n -u postgres createuser -s "$USER"
```

**Never** ask anyone for a password, never read one from a file or the environment, never run `sudo` without
`-n`, never run any other command through sudo. If `sudo -n` is refused, stop: report that the sudoers rule
is missing and that the Stack page can write it.

On macOS use `brew install …` / `brew services start …` with no sudo at all.

## What each tool is

| id | apt | brew | service | verify |
|---|---|---|---|---|
| `postgresql` | `postgresql` | `postgresql@17` (link it) | `postgresql` | `psql --version`, `psql -l` as `$USER` |
| `redis` | `redis-server` | `redis` | `redis-server` / `brew services start redis` | `redis-server --version`, `redis-cli ping` |
| `node` | `nodejs npm` | `node` | — | `node --version` |
| `python` | `python3 python3-pip python3-venv` | `python` | — | `python3 --version` |
| `java` | `default-jdk` | `openjdk` (link it) | — | `java --version` |

`DEBIAN_FRONTEND=noninteractive` on every apt call. With PostgreSQL, make the user Sloth runs as a superuser
(`createuser -s "$USER"`) so a session can `createdb` — it may already exist, which is fine.

## How to go about it

1. Check what is already there (`command -v`, then the version call) and skip it.
2. Install what is missing, one tool at a time, so one failure does not take the rest with it.
3. Start the services and verify: a tool counts as installed only when its version call answers.
4. A failure is reported, not worked around: no source builds, no third-party repositories, no `curl | sh`.

Finish with a short plain-text report: one line per tool — installed / already there / failed and why — and
nothing else. No preamble, no next steps.
