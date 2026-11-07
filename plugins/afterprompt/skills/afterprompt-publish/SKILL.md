---
name: afterprompt-publish
description: Publish a web game (HTML, Phaser, Unity WebGL, Godot Web) to AfterPrompt and get a link anyone can play. Use when the user asks to publish, upload, host, share or list a game on AfterPrompt.
---

# Publish a game to AfterPrompt

1. Make sure the game folder has `index.html` at its root and uses only relative URLs (`game.js`, `assets/x.png`, never `/game.js`). Bundle every dependency: the game page cannot load scripts, fonts or APIs from other sites.
2. Add `afterprompt.json` to that folder if it is missing:

   ```json
   { "format": "afterprompt-package@1", "title": { "en": "Game title" }, "ageRating": "all" }
   ```

   `ageRating` is `"all"`, `"13"`, `"16"` or `"18"`; pick it from the game's content and say which you chose. An optional `"cover"` names an image in the package.
3. To use the AfterPrompt SDK, load it relative to `index.html`: `<script src="__afterprompt/sdk.js"></script>`, then `afterprompt.ready()` resolves with `{ player, game }`. Do not copy the SDK into the package.
4. Publish:

   ```bash
   node "${PLUGIN_ROOT}/scripts/afterprompt.mjs" publish <dir>
   ```

   If it says you are not signed in, run `node "${PLUGIN_ROOT}/scripts/afterprompt.mjs" login`. The user must sign in and approve **AfterPrompt CLI** themselves; tell them so and wait. On this machine it opens the browser. Over SSH, without a display, or with `--device`, it prints a link and a code such as `ABCD-EFGH`: give both to the user, who approves them on any device, and keep the command running until it says `Signed in`.
5. Give the user the play link the command prints. If the user wants the game in the public AfterPrompt catalog, run `node "${PLUGIN_ROOT}/scripts/afterprompt.mjs" submit <dir>`: an admin reviews it, and `afterprompt games` shows the decision and any reason. Only submit when the user asks. The game id is kept in `<dir>/.afterprompt/game.json`; later publishes from the same folder update the same game. Use `--new` only when the user wants a separate game.

Unity WebGL: build with Compression Format **Disabled**, or Gzip/Brotli with **Decompression Fallback** on. Godot Web: export with Thread Support off. Files up to 25 MB, packages up to 100 MB and 2,000 files, 10 versions a day.

`AFTERPROMPT_URL` points the command at another server, for example `http://localhost:8787` for local development.
