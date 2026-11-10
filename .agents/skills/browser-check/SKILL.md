---
name: browser-check
description: Drive T3 Code's web UI in a browser for UAT of the fork's work, reproductions or screenshots.
---

# Drive the web UI with the Playwright CLI

Each agent drives its own browser through `playwright-cli`, so UAT runs in any harness and several agents can run it at the same time. For sb workflow UAT this skill replaces the `test-t3-app` skill, and its rule against other automation systems; desktop renders the same web UI, and native mobile UAT has no route outside the `test-t3-mobile` skill, so report a mobile-only check as a blocker.

## Setup

- Install the CLI with `npm install -g @playwright/cli@latest` when the `playwright-cli` command is not found.
- Run `playwright-cli --help` for the command list and `playwright-cli --help <command>` for a command's options.
- Run every `playwright-cli` command from the repository root of the checkout, where it reads `.playwright/cli.config.json`, which writes its snapshot, console and screenshot files to `.wip/playwright-cli/`.

## Dev server

- Use the dev server of the current checkout, whose web URL and startup pairing URL are in `.wip/dev.log`, per the `worktrees` skill.
- When no dev server of the checkout answers, return that as a blocker to the agent that assigned the check, which starts it per the `environment-repair` skill.
- Never point a session at `~/.t3/userdata` or at another checkout's dev server.

## Sessions

- Pass `-s=<session>` on every command, because a command without it drives the `default` session that any other agent can also use.
- Use the session name the assigning agent gives; otherwise name the session after the issue or task, such as `i14-uat`, and give each parallel subagent its own suffix.
- Run `playwright-cli list` before `open`, and choose another name when the name is listed, because `open` on a listed session closes that browser.
- Close the session with `playwright-cli -s=<session> close` when the task that opened it finishes.
- Never run `close-all` or `kill-all`, because they close the browsers of other agents.

## Sign in

1. Mint a pairing URL with `node apps/server/src/bin.ts pair --base-dir .t3`; it prints the web origin, and each URL signs in one session.
2. Run `playwright-cli -s=<session> open "<pairing URL>"`.
3. Snapshot until the page shows the sidebar, because `open` returns while the pairing screen or the splash still shows.
4. Confirm the sign-in with `--raw eval "location.href"`, which no longer ends in `/pair`.

- Keep pairing URLs out of reports, screenshots and commits, because each one is a credential.

## Drive the page

- Read the snapshot file that each command's output links, or run `snapshot` or `find "<text>"`, to get element refs.
- Take a new snapshot or `find` after each state change, because refs change with the page state, and a stale ref fails with `Ref <ref> not found in the current page snapshot`.
- Close Settings, which opens as a dialog at `/settings/...` over the page that is still in the snapshot, with `press Escape`.
- Handle a `Modal state` section in the output before any other command: run `dialog-accept` or `dialog-dismiss` for a dialog, and `upload <files...>` for a file chooser.

## Agent turns

- Start a free turn with `--raw eval 'window.t3dev.replay("showcase")'`, which returns the new thread's ID, and list the scenarios with `--raw eval 'window.t3dev.replayScenarios()'`; use a real provider only per [AGENTS.md § Verifying](../../../AGENTS.md#verifying).
- Click the turn's **Approve** button when the scenario asks for approval.
- Treat a turn as finished only when `find "Stop generation"` matches nothing, because the reply's text can show before the turn ends, and never wait with a fixed sleep.

## Screenshots

- Save each screenshot with `screenshot --filename=<path>` to the path the task gives, and otherwise under `.wip/`.
- Pass a snapshot ref to capture one element; `--full-page` captures no more than the viewport, because the app's panes scroll inside the page.
- Expect one image pixel per CSS pixel on a 1280×720 viewport; run `resize <width> <height>` to change the viewport.
