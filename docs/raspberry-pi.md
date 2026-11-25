# TeamClaude on Raspberry Pi

These commands replace an existing global npm installation in place. Use Node.js 20 or later and the same shell and npm installation you used for `teamclaude update`. The existing `teamclaude.service` keeps its executable and config paths.

## Install the fork

Record the installed version so you can restore it later.

```sh
teamclaude --version
```

In your existing config, set the top-level `"autoUpdate": false` so background updates leave the fork installed. To enable the automatic budget, set `"codexCredits": true` on the desired Codex OAuth account in `accounts`. Keep the adjacent state file to retain your budget history. [Codex credit budget](quota.md#codex-credit-budget)

```sh
npm install -g --ignore-scripts https://github.com/5pecia1/teamclaude/releases/download/v1.1.31-codex.3/teamclaude-1.1.31-codex.3.tgz &&
systemctl --user restart teamclaude.service
```

Run `teamclaude status --json` to check the running version and `teamclaude attach` to see the credit budget on the account row. For future fork updates, use the new release's archive URL and restart the same service. The built-in `teamclaude update` targets upstream npm.

## Roll back

Restore the account's previous `codexCredits` setting if you changed it. Reinstall the version you recorded before the update. This example uses upstream `1.1.31`.

```sh
npm install -g --ignore-scripts @karpeleslab/teamclaude@1.1.31 &&
systemctl --user restart teamclaude.service
```

If your previous version was a fork build such as `1.1.31-codex.1`, pass that version's archive URL from [GitHub Releases](https://github.com/5pecia1/teamclaude/releases) to `npm install -g --ignore-scripts`. Keep `autoUpdate` disabled while you want to stay on the selected version.

If you previously added a systemd override pointing at `~/.local/share/teamclaude/current`, locate the override file with `systemctl --user cat teamclaude.service`. If it contains only the fork settings, remove that file. If it also contains your other settings, remove only the two `ExecStart` lines and the auto-update environment line added for the fork. Run `systemctl --user daemon-reload` before restarting.
