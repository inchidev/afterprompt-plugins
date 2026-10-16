# AfterPrompt for Claude Code and Codex

When your agent has been working for more than a minute, a small game window opens in the corner of your screen. When the agent finishes or needs your permission, the game shows a readiness signal and stays open. Return to your agent when you are ready; an active game with a friend is preserved.

Quick answers never open anything: if the agent is done within the delay, no window appears.

## Install

**Claude Code**

```
/plugin marketplace add inchidev/afterprompt-plugins
/plugin install afterprompt@inchidev
```

**Claude app on macOS: local Code sessions**

1. Open **Settings → Plugins → Add → Add marketplace**.
2. Choose **Add from a repository** and enter `https://github.com/inchidev/afterprompt-plugins`.
3. Select **Sync**, then **AfterPrompt → Install**. Start a **Local** session in the **Code** tab.

In current Claude Code Desktop, **+ → Plugins → Add plugin** opens the plugin browser. Hooks run where the agent runs; a cloud or SSH session does not open an app on your Mac. See the [Claude Code Desktop documentation](https://code.claude.com/docs/en/desktop#install-plugins).

**Codex macOS app**

1. Open **Plugins** in the Codex macOS app and select **Add Marketplace**.
2. Add `inchidev/afterprompt-plugins`, then open **AfterPrompt** and select **Install**.
3. When the app shows that setup needs attention, select **Finish**, review the five AfterPrompt hooks, and trust them.
4. Start a new task.

Codex lifecycle hooks require a manually installed desktop plugin and explicit hook trust. Plugins containing lifecycle hooks are not eligible for the public OpenAI plugin directory ([OpenAI documentation](https://developers.openai.com/plugins/build/plugins)).

For updates, Claude users can run `/plugin update afterprompt@inchidev` or enable auto-update for the `inchidev` marketplace under **Plugins → Marketplaces**. Codex users can upgrade the `inchidev` marketplace, restart the app, and accept the new plugin version.

The hooks are a plain shell script that uses only `sh`, `curl`, and `sed`, which come with macOS and Linux. The optional native macOS app is built for Apple Silicon and Intel; its signed public installer is still being prepared. The plugin uses its browser fallback until the app is installed. Windows is not supported yet.

## How it works

| Claude Code hook | Codex hook | What happens |
| --- | --- | --- |
| `UserPromptSubmit` | `UserPromptSubmit` | Starts a background timer (async hook: the agent is never delayed). |
| after the delay | after the delay | Creates a session for the selected game and opens the AfterPrompt macOS app when installed. Otherwise it uses a chromeless Chrome, Edge, Brave, or Chromium `--app` window, then a normal browser tab. |
| `Stop`, `Notification` (`permission_prompt`) | `Stop`, `PermissionRequest` | Completes the session. The window shows "claude is ready" or "codex is ready" and stays open. The native app receives a background readiness signal without stealing focus. |
| `SessionEnd` | `SessionEnd`, `Interrupt` | Completes any open session. |

State lives in `~/.afterprompt/`: one small file per agent and session, a log, and a separate browser profile that keeps your game progress. Your everyday browser profile is never touched.

**Privacy:** only the selected game ID, agent name (`claude` or `codex`), and timestamps are sent to `afterprompt.games`. Prompts, code, file paths, and transcripts never leave your machine.

## Settings

Set these environment variables, for example in the `env` block of `~/.claude/settings.json`, or in your shell profile for Codex:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AFTERPROMPT_DELAY` | `60` | Seconds of work before the window opens |
| `AFTERPROMPT_GAME` | `goo` | ID of the game to open |
| `AFTERPROMPT_DISABLE` | — | `1` turns the plugin off without uninstalling |
| `AFTERPROMPT_BROWSER` | auto | Path to a Chromium-family browser binary |
| `AFTERPROMPT_URL` | `https://afterprompt.games` | Game server (for local development) |
| `AFTERPROMPT_HOME` | `~/.afterprompt` | Where state, logs, and the browser profile live |

Ask Codex to “open the Goo AfterPrompt practice game” or “open 2K48” at any time. The installed game IDs remain `goo` and `tree2048` for protocol compatibility.
