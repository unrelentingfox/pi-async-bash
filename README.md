# pi-async-bash

[![npm version](https://img.shields.io/npm/v/pi-async-bash)](https://www.npmjs.com/package/pi-async-bash)
[![npm downloads](https://img.shields.io/npm/dm/pi-async-bash)](https://www.npmjs.com/package/pi-async-bash)
[![CI](https://img.shields.io/github/actions/workflow/status/unrelentingfox/pi-async-bash/ci.yml?branch=main&label=CI)](https://github.com/unrelentingfox/pi-async-bash/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/pi-async-bash)](https://www.npmjs.com/package/pi-async-bash)
[![License](https://img.shields.io/github/license/unrelentingfox/pi-async-bash)](https://github.com/unrelentingfox/pi-async-bash/blob/main/LICENSE)

`pi-async-bash` adds asynchronous Bash execution, task management, and event
watches to [Pi](https://github.com/badlogic/pi-mono).

## Install

Install from npm:

```bash
pi install npm:pi-async-bash
```

During development, add the local checkout to Pi settings:

```json
{
  "packages": [
    "/local/home/dustinfx/workplace/pi/pi-async-bash"
  ]
}
```

## Agent tools

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `bash` | `command`; optional `timeout`, `run_async`, `description` | Overrides Pi's Bash tool. Commands start in the foreground by default. `run_async: true` starts detached work immediately. A long foreground command continues asynchronously after `timeout`. |
| `bash_async` | `command`; optional `name`, `timeout`, `notify` | Starts a command asynchronously, shows the command in the call row, and returns its job ID and `/tmp/pi-bg/<jobId>.log` path. It sends one terminal notification unless `notify: false`. |
| `bash_async_list` | `action`: `list`, `output`, `kill`, `attach`, `search`, `cleanup`, or `stats`; action-specific `jobId`, `pattern`, `wait` | Lists, reads, follows, searches, stops, cleans up, and reports on async jobs and watches. |
| `bash_async_watch` | exactly one of `command` or `ws`; `description`; optional `persistent`, `timeout_ms` | Returns immediately and delivers each stdout line or WebSocket text frame as an event. It stops on source exit, timeout, event-rate protection, or `bash_async_list` `kill`. |
| `bash_async_decide` | `jobId`; `decision`: `keep`, `kill`, or `check` | Resolves a `bash_async` command that has exceeded its optional timeout. |

`run_in_background` is not supported. Use `run_async` instead.

## Configuration

Set `pi-async-bash.defaultTimeoutSeconds` in Pi's global
`~/.pi/agent/settings.json`. A trusted project's `.pi/settings.json` can
provide the same key and takes precedence.

```json
{
  "pi-async-bash": {
    "defaultTimeoutSeconds": 5
  }
}
```

The extension falls back to 120 seconds when this setting is absent or invalid.
The 2-second quick-completion window still returns fast commands inline. Values
at or below 2 seconds background commands immediately after that window; the
5-second setting above gives slower commands three more seconds to finish. A
`timeout` passed to an individual `bash` call overrides this setting. This
setting does not affect the separate decision timeout on `bash_async`.

## Slash commands

| Command | Behavior |
| --- | --- |
| `/bash-async` | Send the currently running bash command to the background. Return control to the agent. |
| `/bash-async-list` | Open the interactive task manager. `j`/`k` and arrow keys move the highlight, `Enter` opens the highlighted task's output, `Ctrl+x` starts kill confirmation, and `Escape` closes the root list, returns from output, or cancels confirmation. |

There are no keyboard shortcuts. While a foreground command runs, the editor
shows `/bash-async to run asynchronously`. Submitting a new user message also
hands active foreground Bash work to async execution and queues the message as
a follow-up.

## Behavior and safety

- Async commands use a detached process group and capture combined output in
  `/tmp/pi-bg`.
- `bash_async_list attach` streams output while it waits. Use `output` for a
  bounded non-blocking read.
- `bash_async_watch` is for many events. Use `bash` with `run_async: true` or
  `bash_async` when only the terminal result matters.
- The extension rejects naïve long `sleep` commands, warns about interactive
  prompts, caps non-persistent log growth at 100 MiB, limits concurrent jobs,
  and removes stale log files at startup.
- Same-process `/reload` restores compatible running job records. A fresh Pi
  process never adopts or signals an old process ID, preventing PID reuse bugs.

## Migration from upstream

| Upstream | pi-async-bash |
| --- | --- |
| `bash` with `run_in_background` | `bash` with `run_async` |
| `bash_bg` | `bash_async` |
| `jobs` | `bash_async_list` |
| `monitor` | `bash_async_watch` |
| `job_decide` | `bash_async_decide` |
| `/bg` | `/bash-async` |
| `/bg-list` | `/bash-async-list` |
| `/bg-version` | removed |
| `agent_bg` | removed; use Pi's own subagent tooling |
| keyboard shortcuts | removed |

## Development

```bash
pnpm install --frozen-lockfile
pnpm run check
```

## License and attribution

Copyright (c) 2026 patty.io
Copyright (c) 2026 Dustin Fox (fork modifications)

Licensed under the MIT License. See [LICENSE](LICENSE).

## Fork and attribution

`pi-async-bash` is based on Patrick Rho's
[`patty-io/pi-patty-bg-tasks`](https://github.com/patty-io/pi-patty-bg-tasks).
It retains the upstream Git history and MIT notice. This project removes
background Pi agent spawning and global keyboard shortcuts, and renames the
public interface to use `async` consistently. The unscoped name
`pi-background-bash` was already published, so this project uses
`pi-async-bash`.
