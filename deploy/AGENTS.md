# Deployment DOX

## Purpose
- Owns production deployment assets for running Poker Odds Lab in a Debian/Ubuntu Proxmox LXC.
- The supported production path is a Rust binary served by systemd, optionally behind nginx.

## Ownership
- `lxc/install.sh` owns OS package setup, Rust stable toolchain bootstrap, release build, app staging, build-info generation, systemd install, optional nginx setup, and update alias creation.
- `lxc/update.sh` owns pull-and-redeploy workflow for existing LXC installs.
- `lxc/systemd/odds.service` owns service defaults and runtime environment.
- `lxc/nginx/odds.conf` owns reverse proxy, static compression, timeout, and rate-limit behavior.

## Local Contracts
- Deployment must stage the Rust `odds` binary, root `index.html`, root `src/`, and generated `build-info.json`.
- Installer defaults must stay aligned with README runtime env docs and backend defaults.
- nginx and systemd changes must preserve `/api/` routing, static asset serving, and `/api/health`.
- Scripts may require root/sudo on target hosts; keep local syntax checks separate from live deployment.

## Work Guidance
- Keep shell scripts idempotent where practical and fail fast with clear errors.
- Prefer explicit option parsing and documented defaults.
- Do not bake user-specific hostnames, paths, credentials, or signing material into deployment assets.

## Verification
- Run `bash -n deploy/lxc/install.sh deploy/lxc/update.sh` after script edits.
- Run `systemd-analyze verify deploy/lxc/systemd/odds.service` where systemd tooling is available after service edits.
- Run `nginx -t -c` against an appropriate test config or document why local nginx validation was not possible after nginx config edits.

## Child DOX Index
- No child AGENTS.md files currently.
