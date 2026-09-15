# pi-async-bash

`pi-async-bash` adds asynchronous Bash execution, task management, and event
watches to [Pi](https://github.com/badlogic/pi-mono).

It is a focused fork of
[`patty-io/pi-patty-bg-tasks`](https://github.com/patty-io/pi-patty-bg-tasks).
The fork retains the upstream Git history and MIT notice, removes background Pi
agent spawning and all keyboard shortcuts, and renames the public interface to
use `async` consistently. The unscoped name `pi-background-bash` was already
published, so this project uses `pi-async-bash`.

## Install

During development, add the local checkout to Pi settings:

```json
{
  "packages": [
    "/local/home/dustinfx/workplace/pi/pi-async-bash"
  ]
}
```

The repository will later be consumable from a pinned Git tag or commit. npm
publication is not yet configured.

## Agent tools

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `bash` | `command`; optional `timeout`, `run_async`, `description` | Overrides Pi's Bash tool. Commands start in the foreground by default. `run_async: true` starts detached work immediately. A long foreground command continues asynchronously after `timeout`. |
| `bash_async` | `command`; optional `name`, `timeout`, `notify` | Starts a command asynchronously, shows the command in the call row, and returns its job ID and `/tmp/pi-bg/<jobId>.log` path. It sends one terminal notification unless `notify: false`. |
| `bash_async_list` | `action`: `list`, `output`, `kill`, `attach`, `search`, `cleanup`, or `stats`; action-specific `jobId`, `pattern`, `wait` | Lists, reads, follows, searches, stops, cleans up, and reports on async jobs and watches. |
| `bash_async_watch` | exactly one of `command` or `ws`; `description`; optional `persistent`, `timeout_ms` | Returns immediately and delivers each stdout line or WebSocket text frame as an event. It stops on source exit, timeout, event-rate protection, or `bash_async_list` `kill`. |
| `bash_async_decide` | `jobId`; `decision`: `keep`, `kill`, or `check` | Resolves a `bash_async` command that has exceeded its optional timeout. |

`run_in_background` is not supported. Use `run_async` instead.

## Slash commands

| Command | Behavior |
| --- | --- |
| `/bash-async` | Send the currently running bash command to the background. Return control to the agent. |
| `/bash-async-list` | Open the interactive task manager. It reads the same registry as `bash_async_list` and lets a user inspect output or stop a task without a model tool call. |

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
npm install
npm test
npm run check
```

## License and attribution

Copyright (c) 2026 patty.io
Copyright (c) 2026 Dustin Fox (fork modifications)

Licensed under the MIT License. See [LICENSE](LICENSE). This fork retains the
upstream MIT permission notice and original project history.
