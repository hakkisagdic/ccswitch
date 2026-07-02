# keyflip for VS Code

Status-bar companion for [keyflip](https://github.com/hakkisagdic/keyflip): shows
the active Claude account and switches accounts with two clicks.

> The VS Code **Claude Code extension shares the CLI's credential store**, so a
> keyflip switch already applies to it — this extension is just convenience UI.

## Requirements

- `keyflip` installed and on PATH (or set `keyflip.path` in settings)
- At least one account saved (`keyflip add`)

## Features

- **Status bar**: active account at a glance (hover for CLI + desktop-app detail)
- **Click / `keyflip: Switch Claude Account`**: QuickPick of saved accounts →
  confirm → switch (closes/reopens the desktop app if needed) → offers a window
  reload so the Claude extension picks up the new login

## Install (local, no marketplace)

```bash
cd vscode-keyflip
npx --yes @vscode/vsce package        # produces keyflip-vscode-<version>.vsix
code --install-extension keyflip-vscode-*.vsix
```

Marketplace publishing requires a publisher account and is not set up yet.
