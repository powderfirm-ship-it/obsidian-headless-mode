# Headless Mode

An Obsidian plugin by **Meirakami**.

Run Obsidian **headless**: every window hidden, the app removed from the macOS Dock, alive only as a menu bar (tray) icon — until you uncheck **Headless** from the icon's menu.

Useful when Obsidian is doing background work (sync, automations, plugins that watch the vault) and you don't want it taking up the Dock or window switcher.

## How it works

A gem-shaped icon is added to the menu bar (system tray on Windows/Linux). Clicking it opens a menu:

- **Headless** (checkbox) — when checked, all Obsidian windows hide and the Dock icon disappears (macOS). Obsidian keeps running. Uncheck to bring the window and Dock icon back.
- **Open Obsidian** — shortcut to exit headless mode.
- **Quit Obsidian** — fully quits the app.

There are also command palette entries: **Toggle headless mode** and **Go headless**.

## Settings

- **Start headless** — launch Obsidian directly into headless mode.
- **Hide Dock icon while headless** (macOS) — on by default; turn off if you want the window hidden but the Dock icon kept.

## Install (manual)

1. Build: `npm install && npm run build`
2. Copy `main.js` and `manifest.json` into `<your-vault>/.obsidian/plugins/headless-mode/`
3. Reload Obsidian, then enable **Headless Mode** under Settings → Community plugins.

## Notes

- Desktop only (`isDesktopOnly: true`). Dock hiding is macOS-only; on Windows/Linux the tray toggle still hides/shows windows.
- The plugin always restores the window and Dock icon when it unloads, so disabling it can never strand a hidden app.
- Quitting from the tray is the reliable way to quit while headless; with the Dock icon hidden there's nothing else to click.
