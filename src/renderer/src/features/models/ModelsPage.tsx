// Models: the local library (Stability Matrix / ComfyUI folders), a Civitai
// browser with downloads and the model manager (every location, recipe
// models from Hugging Face, voice engines), sharing one "hide NSFW
// thumbnails" switch.
import { useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { BadgeCheck, Boxes, Ellipsis, EyeOff, Globe, HardDrive, KeyRound } from 'lucide-react'
import { formatBytes } from '@/lib/utils'
import { rise, stagger } from '@/lib/motion'
import { Page } from '@/components/shell/page'
import { Button, IconButton } from '@/components/ui/button'
import { Switch, Tabs } from '@/components/ui/controls'
import { Menu, MenuCheck, MenuItem, MenuSeparator, Tooltip } from '@/components/ui/overlay'
import { useHideNsfw } from '@/components/model-tags'
import { useCompact } from '@/lib/platform'
import { useLocalModels } from '@/components/model-library'
import { useSettings } from '@/stores/settings'
import { CivitaiBrowser } from './CivitaiBrowser'
import { LocalLibrary } from './LocalLibrary'
import { ModelManager } from './ModelManager'
import { CivitaiKeyDialog, CivitaiMark, DownloadsButton } from './parts'
import { useCivitai } from './store'

export function ModelsPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'civitai' ? 'civitai' : params.get('tab') === 'manage' ? 'manage' : 'local'
  const hide = useHideNsfw()
  const update = useSettings((s) => s.update)
  const status = useCivitai((s) => s.status)
  const loadStatus = useCivitai((s) => s.loadStatus)
  const initDownloads = useCivitai((s) => s.initDownloads)
  const setKeyDialog = useCivitai((s) => s.setKeyDialog)
  const { models } = useLocalModels()
  const compact = useCompact()

  useEffect(() => {
    void loadStatus()
    initDownloads()
  }, [loadStatus, initDownloads])

  const stats = useMemo(
    () => ({
      files: models.length,
      identified: models.filter((m) => m.meta?.source === 'civitai').length,
      bytes: models.reduce((n, m) => n + m.size, 0),
      bases: new Set(models.map((m) => m.meta?.baseModel).filter(Boolean)).size
    }),
    [models]
  )

  return (
    <Page>
      <div className="relative overflow-hidden">
        <div className="pointer-events-none absolute -top-24 right-[-8%] h-64 w-[46%] rounded-full bg-grad opacity-[0.13] blur-3xl" />
        {compact ? (
          // Phones: title, downloads and one "⋯" for the NSFW switch and the Civitai account; stats as one quiet line.
          <div className="relative px-4 pt-5 pb-3">
            <div className="flex items-center gap-2">
              <h1 className="display min-w-0 flex-1 truncate text-[23px]">Models</h1>
              <DownloadsButton />
              <Menu
                align="end"
                trigger={
                  <IconButton label="Model options" variant="secondary" className="size-10 rounded-xl">
                    <Ellipsis className="size-4" />
                  </IconButton>
                }
              >
                <MenuCheck checked={hide} onChange={(v) => void update({ civitai: { hideNsfw: v } })}>
                  Hide NSFW thumbnails
                </MenuCheck>
                <MenuSeparator />
                <MenuItem icon={status?.hasKey ? <BadgeCheck /> : <KeyRound />} onSelect={() => setKeyDialog(true)}>
                  {status?.hasKey ? `Civitai · ${status.username ?? 'connected'}` : 'Connect Civitai'}
                </MenuItem>
              </Menu>
            </div>
            <div className="mt-1.5 truncate text-[12px] text-fg-3">
              <b className="font-semibold text-fg-2 tabular-nums">{stats.files}</b> files · <b className="font-semibold text-fg-2 tabular-nums">{stats.identified}</b> identified ·{' '}
              <b className="font-semibold text-fg-2 tabular-nums">{stats.bases}</b> base models · <b className="font-semibold text-fg-2 tabular-nums">{formatBytes(stats.bytes)}</b>
            </div>
          </div>
        ) : (
        <div className="relative flex items-end justify-between gap-6 px-8 pt-7 pb-5 max-md:flex-col max-md:items-stretch max-md:gap-3.5 max-md:px-4 max-md:pt-5 max-md:pb-4">
          <div className="min-w-0">
            <h1 className="display text-[26px] max-md:text-[23px]">Models</h1>
            <p className="mt-1.5 max-w-xl text-[13px] text-fg-2">Checkpoints, LoRAs and everything else your GPUs run — plus all of Civitai, one click from your library.</p>
            <motion.div variants={stagger(0.05, 0.1)} initial="initial" animate="animate" className="mt-3.5 flex flex-wrap items-center gap-1.5">
              {[
                { label: 'files', value: String(stats.files) },
                { label: 'identified', value: String(stats.identified) },
                { label: 'base models', value: String(stats.bases) },
                { label: 'on disk', value: formatBytes(stats.bytes) }
              ].map((s) => (
                <motion.span key={s.label} variants={rise} className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-white/[0.04] px-2.5 text-[11px] text-fg-3">
                  <b className="font-semibold text-fg tabular-nums">{s.value}</b> {s.label}
                </motion.span>
              ))}
            </motion.div>
          </div>
          <div className="flex shrink-0 items-center gap-2 max-md:flex-wrap max-md:[&>button]:h-10 max-md:[&>button]:flex-1">
            <Tooltip content="Blur thumbnails rated R and above — in your library, on Civitai and in every model picker">
              <label className="flex h-9 cursor-default items-center gap-2.5 rounded-[10px] border border-line bg-white/[0.035] pr-2 pl-3 text-[12px] font-medium text-fg-2 transition hover:border-line-strong max-md:h-11 max-md:w-full max-md:rounded-xl max-md:pr-3">
                <EyeOff className="size-3.5 text-fg-3" />
                <span className="max-md:flex-1">Hide NSFW thumbnails</span>
                <Switch size="sm" checked={hide} onChange={(v) => void update({ civitai: { hideNsfw: v } })} />
              </label>
            </Tooltip>
            {status?.hasKey ? (
              <Button variant="secondary" icon={<CivitaiMark size={16} />} iconRight={<BadgeCheck className="size-3.5 text-success" />} onClick={() => setKeyDialog(true)}>
                {status.username ?? 'Civitai'}
              </Button>
            ) : (
              <Button variant="primary" icon={<KeyRound className="size-3.5" />} onClick={() => setKeyDialog(true)}>
                Connect Civitai
              </Button>
            )}
            <DownloadsButton />
          </div>
        </div>
        )}
        <div className="relative px-8 max-md:px-2">
          <Tabs
            value={tab}
            onChange={(t) => setParams(t === 'local' ? {} : { tab: t }, { replace: true })}
            items={[
              { value: 'local', label: 'My models', icon: <HardDrive />, count: stats.files },
              { value: 'civitai', label: compact ? 'Civitai' : 'Browse Civitai', icon: <Globe /> },
              { value: 'manage', label: compact ? 'Manage' : 'Manage & install', icon: <Boxes /> }
            ]}
            className="border-b-0 max-md:overflow-x-auto max-md:pb-px max-md:[&>button]:h-10 max-md:[&>button]:shrink-0 max-md:[&>button]:whitespace-nowrap"
          />
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {tab === 'local' ? <LocalLibrary key="local" /> : tab === 'civitai' ? <CivitaiBrowser key="civitai" /> : <ModelManager key="manage" />}
      </AnimatePresence>
      <CivitaiKeyDialog />
    </Page>
  )
}
