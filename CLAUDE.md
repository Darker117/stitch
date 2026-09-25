# Stitch

Local-first desktop studio: Higgsfield-style image/video/audio/voice generation on the user's own GPUs (ComfyUI from Stability Matrix + a local Qwen3-TTS voice engine) paired with an AI Dungeon-style story engine (OpenAI, Anthropic, OpenRouter, Gemini, Ollama, LM Studio). Characters stay consistent across stills, video and voice.

## Stack
- Electron 44 + electron-vite 5 + Vite 7, React 19, TypeScript 7 (`tsc` is tsgo — no `baseUrl`, paths must start with `./`).
- Tailwind CSS v4 (tokens in `src/renderer/src/styles.css` via `@theme inline`), `motion` (`motion/react`) for all animation, Radix primitives via the unified `radix-ui` package, `lucide-react` icons, `zustand` stores, `react-router` 7 (hash router).

## Layout
- `src/shared/` — types (`types.ts`), IPC contract (`ipc.ts`), colour maths/palette (`theme.ts`). Imported as `@shared/*`.
- `src/main/` — main process. `ipc.ts` (`handle`, `emit`), `store.ts` (JSON document store, `db(collection)`), `settings.ts` (settings + encrypted secrets), `protocol.ts` (`stitch://local/<path>` file serving with Range support; `stitch://wp-<id>/` for sandboxed Wallpaper Engine web wallpapers).
  - `services/comfy/` — ComfyUI client, built-in recipes (`recipes.ts`), job queue/routing (`jobs.ts`), managed ComfyUI processes per GPU (`process.ts`), GPU layout (`../gpu.ts`).
  - `services/llm/` — streaming chat for OpenAI-compatible, Anthropic and Ollama.
  - `services/voice/`, `services/editor.ts`, `services/wallpaper.ts`, `services/skills.ts`, `services/assets.ts`, `services/system.ts`, `services/connectors.ts`.
- `src/preload/` — exposes `window.stitch.{invoke,on,pathForFile}`.
- `src/renderer/src/` — UI. `@/` alias.
  - `lib/api.ts` — typed `invoke`, `on`, `streamLlm`, `fileUrl(path)` (use for every local media src), `parseJsonLoose`, `errorText`.
  - `lib/llm.ts` — model selection hooks (`useLlmConnectors`, `useModels`, `defaultLlm`).
  - `lib/characters.ts` — sheet slots, `characterRefs`, `sceneImageRequest`, `animateScene` (consistency pipeline).
  - `stores/db.ts` — `useCollection(name)`, `useDoc(name,id)`, `db.put/patch/update/remove` (optimistic, synced via `db:changed`).
  - `stores/gen.ts` — jobs, recipes, ComfyUI status, model lists; `submit`, `waitForJob`.
  - `stores/settings.ts`, `stores/toast.ts` (`toast.success/error/info`).
  - `components/ui/*` — the only UI kit to use: `button.tsx` (Button, IconButton, Chip), `input.tsx` (Input, Textarea autosize, SearchField), `overlay.tsx` (Dialog, Popover, Menu/MenuItem, Select, Tooltip), `controls.tsx` (Switch, Slider, SliderField, SwitchRow, Tabs, Segmented, RadioCards), `misc.tsx` (Badge, Spinner, ProgressRing, ProgressBar, Field, EmptyState, Avatar, Surface, SectionTitle, Skeleton, StatusDot), `orb.tsx`.
  - `components/media.tsx` — AssetThumb, AssetLightbox, AssetPicker, DropZone, MediaSlot, MediaList, `importFiles`, `pickAndImport`.
  - `components/shell/*` — Background, Sidebar, JobTray, Toaster, CommandPalette, `page.tsx` (Page, PageHeader, Hero).
  - `features/<area>/` — one folder per section; routes live in `App.tsx`.

## Conventions
- Every IPC channel is declared in `src/shared/ipc.ts` (`IpcInvoke` / `IpcEvents`) and registered with `handle()` in main. Add channels with a small targeted edit; never rewrite the file.
- Persisted domain data goes through the document store collections in `CollectionMap` (`types.ts`); UI reads with `useCollection`/`useDoc` and writes with `db.*`.
- Generation always goes through `useGen().submit(GenRequest)` → main job queue. Set `origin` so results attach to their source (character sheet slot, adventure action) even if the UI is closed.
- Local media is referenced by asset id; render with `fileUrl(asset.path)`.
- Model "thinking" never reaches reply text: `services/llm/think.ts` splits `<think>` blocks and native reasoning fields in the main process; `streamLlm(req, onText, onReasoning)` / `LlmResult.reasoning` carry it separately. Show it only behind a collapsed "Show thinking" toggle (`ThinkingBlock` in `features/create/Messages.tsx`).
- Glass surfaces read `--panel`, `--panel-strong`, `--glass-blur` (set by `applyTheme` from `theme.glass`/`theme.glassBlur`, `-1` = automatic). Media backgrounds (wallpapers) get airier glass automatically and `html[data-bg='media']`; don't hard-code panel opacities on large surfaces.

## Visual language (non-negotiable)
- Sleek dark "AI chat" styling: near-black, glass panels (`glass`, `glass-strong`), 1px `border-line`, small type (12–13px body, `label-caps` for field labels), pill chips, generous rounding (10–20px).
- Accents come from the theme tokens (`--accent`, `--accent-2`, `bg-grad`, `text-grad`) — the sunset palette by default or colours picked from the user's wallpaper. Never hard-code other accent colours; `sunset-*` tokens are available for illustration.
- Motion everywhere, always smooth: use presets in `lib/motion.ts` (`spring`, `springSoft`, `page`, `pop`, `rise`, `stagger`), `layoutId` for moving highlights, `AnimatePresence` for enter/exit. Animate only transform/opacity/filter.
- Story reading surfaces use the serif (`font-serif`, IBM Plex Serif).

## Commands
- `npm run dev` — run the app with hot reload.
- `npm run typecheck` — typecheck main + renderer.
- Screenshots for visual checks (dev only): `STITCH_CAPTURE=<dir> STITCH_USERDATA=<dir>/profile STITCH_ROUTES="/,/stories" STITCH_CAPTURE_QUIT=1 npx electron-vite dev` writes `shot-N.png` per route (`STITCH_CAPTURE_DELAY` ms per route, default 2500). `STITCH_USERDATA` isolates the profile so test runs never touch real data; several capture runs can happen at once. **In Git Bash prefix the command with `MSYS_NO_PATHCONV=1`**, otherwise MSYS rewrites `STITCH_ROUTES="/"` into `C:/Program Files/Git/` and you get a bogus 404. `STITCH_DEBUG_JS="<expr>"` logs the expression's value (from the renderer) before and after each capture.
- `npm run dist` — build the Windows installer (electron-builder, NSIS). The wizard's dark theme lives in `resources/installer.nsh` (MUI2 defines + page hooks; warnings are errors) with art from `npm run icons`.
- `npm run release` — bump the patch version, tag and push; `.github/workflows/release.yml` builds and publishes the GitHub Release that installed apps update from (`services/updater.ts`, electron-updater, Settings → Updates). Never hand-edit the version or push tags that don't match package.json. Test the updater from a dev run with `STITCH_UPDATE_DEV=1` + a `dev-app-update.yml` (generic provider) — dev runs never install on quit.
- Brand: the source artwork is `resources/brand/stitch-logo.png` (unicorn mark + plum "stitch" wordmark). `scripts/trace-logo.py` (run with any Python that has opencv + pillow, e.g. ComfyUI's venv) regenerates `components/shell/logo-paths.ts`, `resources/logo-*.svg` and `resources/icon.svg`; then `npm run icons` rebuilds the PNG/ICO/installer art. Use `LogoMark` / `Wordmark` / `LogoLockup` from `components/shell/logo.tsx` — never an `<img>` of the PNG.

## Environment notes
- ComfyUI usually comes from Stability Matrix, e.g. `C:\Users\<you>\Documents\StabilityMatrix\Data\Packages\ComfyUI` (found by `sys:detect`). Stitch-managed instances use ports 8190+; 8188 is left for a ComfyUI the user runs themselves.
- Multi-GPU example: an RTX 4090 (24 GB) + RTX 3060 (12 GB). With `CUDA_DEVICE_ORDER=PCI_BUS_ID`, nvidia-smi indices match `--cuda-device`.
