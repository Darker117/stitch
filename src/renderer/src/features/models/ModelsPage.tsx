// Models: the local library (Stability Matrix / ComfyUI folders) and a
// Civitai browser with downloads, sharing one "hide NSFW thumbnails" switch.
import { useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { BadgeCheck, EyeOff, Globe, HardDrive, KeyRound } from 'lucide-react'
import { formatBytes } from '@/lib/utils'
import { rise, stagger } from '@/lib/motion'
import { Page } from '@/components/shell/page'
import { Button } from '@/components/ui/button'
import { Switch, Tabs } from '@/components/ui/controls'
import { Tooltip } from '@/components/ui/overlay'
import { useHideNsfw } from '@/components/model-tags'
import { useLocalModels } from '@/components/model-library'
import { useSettings } from '@/stores/settings'
import { CivitaiBrowser } from './CivitaiBrowser'
import { LocalLibrary } from './LocalLibrary'
import { CivitaiKeyDialog, CivitaiMark, DownloadsButton } from './parts'
import { useCivitai } from './store'

export function ModelsPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'civitai' ? 'civitai' : 'local'
  const hide = useHideNsfw()
  const update = useSettings((s) => s.update)
  const status = useCivitai((s) => s.status)
  const loadStatus = useCivitai((s) => s.loadStatus)
  const initDownloads = useCivitai((s) => s.initDownloads)
  const setKeyDialog = useCivitai((s) => s.setKeyDialog)
  const { models } = useLocalModels()

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
        <div className="relative flex items-end justify-between gap-6 px-8 pt-7 pb-5">
          <div className="min-w-0">
            <h1 className="display text-[26px]">Models</h1>
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
          <div className="flex shrink-0 items-center gap-2">
            <Tooltip content="Blur thumbnails rated R and above — in your library, on Civitai and in every model picker">
              <label className="flex h-9 cursor-default items-center gap-2.5 rounded-[10px] border border-line bg-white/[0.035] pr-2 pl-3 text-[12px] font-medium text-fg-2 transition hover:border-line-strong">
                <EyeOff className="size-3.5 text-fg-3" />
                Hide NSFW thumbnails
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
        <div className="relative px-8">
          <Tabs
            value={tab}
            onChange={(t) => setParams(t === 'civitai' ? { tab: 'civitai' } : {}, { replace: true })}
            items={[
              { value: 'local', label: 'My models', icon: <HardDrive />, count: stats.files },
              { value: 'civitai', label: 'Browse Civitai', icon: <Globe /> }
            ]}
            className="border-b-0"
          />
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {tab === 'local' ? <LocalLibrary key="local" /> : <CivitaiBrowser key="civitai" />}
      </AnimatePresence>
      <CivitaiKeyDialog />
    </Page>
  )
}
