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
