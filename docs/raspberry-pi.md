# TeamClaude on Raspberry Pi

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

## Install a GitHub release

Run this as the user who owns `teamclaude.service`. It checks the archive and points a stable `current`
symlink at the installed version. Future upgrades use the same block with the new version number.

```sh
(
  set -eu
  version=1.1.31-codex.2
  root="$HOME/.local/share/teamclaude"
  base="https://github.com/5pecia1/teamclaude/releases/download/v$version"
  mkdir -p "$root"
  stage=$(mktemp -d "$root/.install.XXXXXX")
  trap 'rm -rf -- "$stage"' EXIT
  cd "$stage"
  curl -fsSLO "$base/teamclaude-$version.tgz"
  curl -fsSLO "$base/SHA256SUMS"
  sha256sum -c SHA256SUMS
  mkdir "$version"
  tar -xzf "teamclaude-$version.tgz" -C "$version"
  if [ ! -e "$root/$version" ]; then
    mv -T "$version" "$root/$version"
  fi
  test "$(node "$root/$version/package/src/index.js" --version)" = "$version"
  ln -s "$version" "$stage/current"
  mv -Tf "$stage/current" "$root/current"
)
```

Use the fork's GitHub release archive for updates. The built-in `teamclaude update` points to the upstream
npm package.

## Point the existing systemd user service at the fork

Run these commands once to inspect the current unit and open its override file.

```sh
systemctl --user cat teamclaude.service
systemctl --user edit teamclaude.service
```

Add the following to the override. Keep the Node.js executable path from your current `ExecStart`; the
example uses `/usr/bin/node`. Carry over any custom server arguments. The config environment and other
service settings stay in the original unit.

```ini
[Service]
Environment=TEAMROUTER_DISABLE_AUTOUPDATE=1
ExecStart=
ExecStart=/usr/bin/node "%h/.local/share/teamclaude/current/package/src/index.js" server --headless
```

For a foreground start without systemd, run
`TEAMROUTER_DISABLE_AUTOUPDATE=1 node "$HOME/.local/share/teamclaude/current/package/src/index.js" server`.
See [Codex accounts](accounts.md#codex-accounts-experimental) for headless OAuth login.

## Turn on the automatic budget

Add this to each Codex OAuth account you want to enable in the existing config's `accounts` array:

```json
"codexCredits": true
```

The config usually lives at `~/.config/teamclaude.json`. An existing `teamrouter.json`, `XDG_CONFIG_HOME`,
or a service override via `TEAMROUTER_CONFIG` or `TEAMCLAUDE_CONFIG` can change the path. Keep the config and
its adjacent state file in place across upgrades.

The first verified positive balance sets the limit. Set `codexCredits` to `false` to allow only confirmed
included quota. The account keeps its automatic limit and accumulated usage when you turn it back on.
Existing manual limits remain available. See [Codex credit budget](quota.md#codex-credit-budget).

## Restart and verify

```sh
systemctl --user daemon-reload
systemctl --user restart teamclaude.service
systemctl --user status teamclaude.service --no-pager
node "$HOME/.local/share/teamclaude/current/package/src/index.js" status --json
```

Use the service's Node.js binary and config environment for the status command if they differ from your shell.
The response reports the running server version and the account's `codexCredits` settings, fixed limit, and
cumulative usage. For later upgrades, install the new release and run `systemctl --user restart teamclaude.service`.
