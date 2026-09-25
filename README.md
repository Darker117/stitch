# Stitch

A local-first Windows studio that stitches together a **Higgsfield-style media generator** (images, MiniMax H3 video with native sound, music, voices, and locked characters) and an **AI Dungeon-style story engine**. Everything renders on your own GPUs through ComfyUI. Story text comes from OpenAI, Anthropic, OpenRouter, Gemini, Ollama, LM Studio or any OpenAI-compatible server.

## What's inside
- **New chat:** an assistant that plans and makes images, H3 videos, music, voice lines, characters and stories through tools. You can turn on "ask before generating", and model thinking stays behind a "Show thinking" toggle.
- **Generate:** Image, Video, Audio and Voice tabs, with live latent previews, prompt enhancement and locked characters as the cast.
- **Characters (Character lock):** one reference image becomes a full sheet (angles, expressions, lighting) plus a cloned voice. Stories and videos reuse it automatically.
- **Stories:** templates, the scenario editor (plot components, story cards, the three opening types), and the player. The player has themes, memory, auto-summaries and Inspect Input, and it can See / Animate / Narrate turns with your locked characters.
- **Studio:** a multi-track video editor for cutting generations, voice lines and music together, with ffmpeg export.
- **Skills:** built-in workflows, plus any ComfyUI workflow imported as a one-click skill.
- **Connectors:** local and cloud text models, ComfyUI instances, and voice providers (Stitch Voice / Qwen3-TTS, ElevenLabs, OpenAI, Azure).
- **Settings:**
  - GPU layout: choose which GPUs to use and which runs images, video, audio or voice.
  - Wallpaper Engine backgrounds, with accents that follow the wallpaper.
  - Models folder, library folder and ffmpeg.

## Requirements
- Windows 10/11, NVIDIA GPU(s).
- ComfyUI (Stability Matrix is detected automatically) with the models you want. The built-in presets cover Krea 2, Qwen Image 2.1 (+ Edit), Flux 2 Klein, Flux Kontext, Anima, SDXL/Illustrious, FastH3 / H3 Reference, ACE-Step 1.5 and Stable Audio 3. Presets whose files are missing show what they need.
- ffmpeg on PATH (`winget install Gyan.FFmpeg`) for video posters and Studio export.
- Optional: LM Studio / Ollama for local text, and API keys for cloud providers.

## Install
Download `Stitch-Setup-<version>.exe` from the [latest release](https://github.com/Darker117/stitch/releases/latest) and run it. Setup installs Stitch for your account (no admin rights), adds Start Menu and desktop shortcuts and launches it. The first-run welcome finds ComfyUI, your GPUs and your text models.

The installer isn't code-signed yet, so Windows SmartScreen may say "Windows protected your PC" the first time — choose **More info → Run anyway**.

## Updates
Stitch checks GitHub Releases when it starts and every few hours, downloads new versions in the background and shows **Update ready → Restart now / Later**. "Later" installs the update the next time you quit. **Settings → Updates** has the current version, a **Check for updates** button, release notes and the auto-download switch.

## Develop
```bash
npm install
npm run dev        # hot-reloading app
npm run typecheck  # main + renderer
npm run icons      # regenerate icons + installer art from resources/icon.svg and the logo SVGs
npm run dist       # build the Windows installer into dist/
```
See `CLAUDE.md` for architecture and conventions.

## Releasing an update
Commit your changes, then:
```bash
npm run release          # 0.1.0 → 0.1.1 (release:minor / release:major for bigger bumps)
```
That bumps the version, tags it and pushes. GitHub Actions (`.github/workflows/release.yml`) then typechecks, builds the installer, drafts a release with notes from your commit messages, uploads the installer + `latest.yml`, and publishes it. Every installed copy picks it up on its next check.

To rebuild a release that failed, run the **Release** workflow manually from the Actions tab with the tag name.
