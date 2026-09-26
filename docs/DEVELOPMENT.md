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

## Web search (bundled SearXNG)
Text models search the web through a [SearXNG](https://github.com/searxng/searxng) that ships inside the installer. Build it once (needs network; downloads are cached in `node_modules/.cache/stitch-searxng`):
```bash
npm run searxng    # → resources/searxng/ (portable Python 3.13 + SearXNG + stitch_searx.py), ~94 MB, gitignored
```
`npm run dist` / `dist:publish` do this first, so installers always include it. Without it the app still runs; `web:status` reports `missing`.
- **Pinning:** the SearXNG commit is in `searxng/pin.json` (shared with the Android build); the Python build (`PY`) and `tzdata` versions are at the top of `scripts/searxng.mjs`. After bumping either, run `npm run searxng` (it notices and rebuilds; `--force` always rebuilds). The build ends with a smoke test that loads SearXNG and its engines.
- **Try it without the app:** `resources/searxng/python/python.exe resources/searxng/stitch_searx.py search "who wrote the hobbit" --data <scratch dir>` (also `page <url>`, `check`, and `serve [--port N]` for the HTTP API the app uses: `GET /stitch/health`, `POST /stitch/search`, `GET /stitch/page?url=&max=`).
- **At runtime** the app starts it on the first search, keeps settings/caches/bytecode in `<userData>/searxng`, logs to `<userData>/logs/searxng.log`, and stops it after 15 idle minutes.

## Phone app (Android)
The Android companion lives in [`mobile/`](../mobile) — a Capacitor app that reuses this renderer's pages. Needs the Android SDK (with NDK) and JDK 21.
```bash
cd mobile
npm install
npm run apk        # web build → cap sync → android/app/build/outputs/apk/debug/app-debug.apk
```
Point `android/local.properties` at your SDK (`sdk.dir=…`). See [`mobile/CLAUDE.md`](../mobile/CLAUDE.md) for how it connects to the PC and how to preview it in a browser.

The app's version comes from the root `package.json`, so it always matches the desktop release. For a release build, `npm run apk:release` signs with the key in `mobile/android/keystore.properties` (gitignored: `storeFile`, `storePassword`, `keyAlias`, `keyPassword`) and writes `android/app/build/outputs/apk/release/app-release.apk` — upload it to the release as `Stitch-Android-<version>.apk`. Keep the keystore safe: Android only installs updates signed with the same key.

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
