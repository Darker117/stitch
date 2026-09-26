# Developing Stitch

## Build and run
```bash
npm install
npm run dev        # hot-reloading app
npm run typecheck  # main + renderer
npm run icons      # regenerate icons + installer art from resources/icon.svg and the logo SVGs
npm run dist       # build the Windows installer into dist/
```
See [`CLAUDE.md`](../CLAUDE.md) for architecture and conventions.

## Phone app (Android)
The Android companion lives in [`mobile/`](../mobile) — a Capacitor app that reuses this renderer's pages. Needs the Android SDK (with NDK) and JDK 21.
```bash
cd mobile
npm install
npm run apk        # web build → cap sync → android/app/build/outputs/apk/debug/app-debug.apk
```
Point `android/local.properties` at your SDK (`sdk.dir=…`). See [`mobile/CLAUDE.md`](../mobile/CLAUDE.md) for how it connects to the PC and how to preview it in a browser.

## Releasing an update
Commit your changes, then:
```bash
npm run release          # 0.1.0 → 0.1.1 (release:minor / release:major for bigger bumps)
```
That bumps the version, tags it and pushes. GitHub Actions (`.github/workflows/release.yml`) then typechecks, builds the installer, drafts a release with notes from your commit messages, uploads the installer + `latest.yml`, and publishes it. Every installed copy picks it up on its next check.

To rebuild a release that failed, run the **Release** workflow manually from the Actions tab with the tag name.

**No GitHub Actions?** (e.g. the account's Actions are paused) — publish from your PC instead, right after `npm run release`:
```bash
npm run publish:local    # drafts the release, builds + uploads the installer, publishes it
```
It needs the GitHub CLI signed in (`gh auth login`).

## README art
`node scripts/make-readme-art.mjs` regenerates `docs/logo-*.png` and `docs/social-preview.png` from the logo SVGs.
