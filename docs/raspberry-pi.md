# Raspberry Pi: Codex credit-budget fork

This fork is distributed as a portable JavaScript archive, not a standalone native executable.
It has no runtime npm dependencies or native addons. Install **Node.js 20 or later** for your OS/CPU first;
64-bit Raspberry Pi OS (`aarch64`) is recommended. A 32-bit OS needs a compatible ARMv7 Node.js 20+ build;
ARMv6 systems and actual Raspberry Pi hardware have not been validated.

Check the installed runtime (a 64-bit CPU can still be running a 32-bit OS):

```sh
uname -m
node --version
node -p 'process.arch'
```

## Download and run

Use the fork's release asset, **not** `npm install -g @karpeleslab/teamclaude`, which installs upstream without this feature.
The archive contains a `package/` directory. No `npm install` or compilation is needed after extraction.

```sh
version=1.1.28-codex.1
mkdir -p "$HOME/.local/share/teamclaude-$version"
cd "$HOME/.local/share/teamclaude-$version"
base="https://github.com/5pecia1/teamclaude/releases/download/v$version"
curl -fLO "$base/teamclaude-$version.tgz"
curl -fLO "$base/SHA256SUMS"
sha256sum -c SHA256SUMS && tar -xzf "teamclaude-$version.tgz"
# Continue only if checksum verification and extraction succeeded.
export TEAMROUTER_DISABLE_AUTOUPDATE=1
node package/src/index.js --version
node package/src/index.js help
node package/src/index.js login --codex
node package/src/index.js server
```

Run as your normal user, not root. Headless OAuth login and existing Codex credentials are described in
[accounts](accounts.md#codex-accounts-experimental). The `TEAMROUTER_DISABLE_AUTOUPDATE=1` environment setting should also be present
in any shell or service that starts this fork. Set `"autoUpdate": false` in the config as an additional safeguard.
Do **not** run the built-in `update` command: it targets upstream npm, not this GitHub fork.
To upgrade, stop the server, download the next fork release into a new versioned directory, and start that copy.

For a service, use the absolute path to your Node.js executable and the extracted `package/src/index.js`;
do not rely on an interactive shell's NVM PATH. Keep the same config path across upgrades.

## Configure the budget

Merge these top-level settings into your existing config; do not replace your credentials or other settings:

```json
{
  "autoUpdate": false,
  "quotaProbeSeconds": 60
}
```

Add the following object to **each Codex OAuth account you want to limit** in `accounts`:

```json
"codexCredits": {
  "enabled": true,
  "maxUsage": 100,
  "budgetId": "rpi-budget-1"
}
```

The default config is normally `~/.config/teamclaude.json`; `teamrouter.json`, `XDG_CONFIG_HOME`, or an explicit
`TEAMROUTER_CONFIG` / `TEAMCLAUDE_CONFIG` can change it. Keep the adjacent state file: it stores consumed budgets.
Deleting it loses the budget history. A missing policy preserves legacy routing, so it is not a fleet-wide cap.

`maxUsage` counts observed credit-balance decreases, not dollars or monthly spend. The same `budgetId` preserves
usage across restarts and limit changes. Changing the ID starts a new budget. Included quota is preferred before
paid fallback; stale or unknown credit readings and state-save failures block paid dispatch.

Concurrent requests and other clients can cause overshoot; top-ups between readings can hide consumption.
This is not an upstream hard billing cap. See [Codex credit budget](quota.md#codex-credit-budget) for details.
