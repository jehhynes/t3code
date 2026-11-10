# Building and installing the fork

This fork (`jehhynes/t3code`, branch `switchboard`) is installed over the official T3 Code `.deb` on the
developer's Linux machine. Branch layout, merging from upstream, and the migration rule live in
[issue #1](https://github.com/jehhynes/t3code/issues/1) under "Fork workflow".

## Toolchain

- `vp` is not on the default `PATH`. Load it in each shell: `. ~/.config/vite-plus/env`, then `vp i`.
- The resource monitor needs Rust 1.95 or newer. If `rustc --version` is older, put the newer
  toolchain first: `export PATH=/usr/lib/rust-1.97/bin:$PATH`.

## Build

Pick a version above the installed one. Check it with `dpkg-query -W -f='${Version}\n' t3code`
(the packager prints `-` as `~`), then use the upstream release the base is on plus
`-switchboard.N`, raising `N` each build:

```bash
T3CODE_DESKTOP_VERSION=0.1.8-switchboard.2 \
  node scripts/build-desktop-artifact.ts --platform linux --target deb --arch x64
```

Without `T3CODE_DESKTOP_VERSION` the build takes the version in `apps/desktop/package.json`, which is
below the installed one, and apt refuses the downgrade. A local build has no update feed, so the
installed fork never auto-updates to an official release.

The `.deb` lands in `release/` (gitignored).

## Install

```bash
sudo -n /usr/local/sbin/t3code-install-dev
```

The root-owned script takes no arguments and installs the newest `release/T3-Code-*-amd64.deb`
whose package is `t3code`. It replaces the app in place; the running app keeps the old version
until it restarts. Settings and data in `~/.t3` and `~/.config/t3code-v2` are untouched.

## Before installing

Run `vp run check:changed`. Browser tests cannot run on Ubuntu 26.04 (Playwright ships no
Chromium for it), so CI covers them.
