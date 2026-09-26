// Browse folders on the PC from the phone (answers `sys:pickFolder`).
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronLeft, ChevronRight, File, Folder, HardDrive } from 'lucide-react'
import type { RemoteDirListing } from '@shared/ipc'
import { errorText, invoke } from '@/lib/api'
import { ease } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/misc'
import { useFolderPicker } from '@mobile/bridge/system'
import { Sheet } from './Sheet'
import { tap } from './haptics'

export function FolderPickerSheet(): React.JSX.Element {
  const req = useFolderPicker((s) => s.req)
  const [listing, setListing] = useState<RemoteDirListing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const load = async (path?: string): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      setListing(await invoke('remote:listDir', path))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (req) void load(req.defaultPath)
    else setListing(null)
  }, [req])

  const finish = (path: string | null): void => {
    req?.resolve(path)
    useFolderPicker.setState({ req: null })
  }

  const dirs = listing?.entries.filter((e) => e.dir) ?? []
  const files = listing?.entries.filter((e) => !e.dir).length ?? 0

  return (
    <Sheet open={!!req} onClose={() => finish(null)} full title={req?.title ?? 'Choose a folder on your PC'}>
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          <button
            disabled={!listing?.path}
            onClick={() => void load(listing?.parent ?? undefined)}
            className="grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-white/[0.04] text-fg-2 disabled:opacity-30"
          >
            <ChevronLeft className="size-4" />
          </button>
          <div className="min-w-0 flex-1 truncate rounded-xl border border-line bg-white/[0.03] px-3 py-2 font-mono text-[11.5px] text-fg-2" dir="rtl">
            {listing?.path ?? 'This PC'}
          </div>
          {busy && <Spinner className="size-4" />}
        </div>
        {error && <div className="mx-4 rounded-xl border border-danger/25 bg-danger/10 p-3 text-[12px] text-danger">{error}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div key={listing?.path ?? 'root'} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.22, ease }}>
              {dirs.map((d) => (
                <button
                  key={d.path}
                  onClick={() => {
                    tap()
                    void load(d.path)
                  }}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] active:bg-white/[0.06]"
                >
                  {listing?.path ? <Folder className="size-4 shrink-0 text-accent" /> : <HardDrive className="size-4 shrink-0 text-accent" />}
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  <ChevronRight className="size-3.5 text-fg-3" />
                </button>
              ))}
              {listing?.path && files > 0 && (
                <div className="flex items-center gap-2 px-3 py-2 text-[11.5px] text-fg-3">
                  <File className="size-3.5" /> {files} file{files === 1 ? '' : 's'}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="flex gap-2 border-t border-line px-4 pt-3 pb-3">
          <Button size="lg" variant="ghost" className="flex-1" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button size="lg" variant="primary" className="flex-1" disabled={!listing?.path} onClick={() => finish(listing?.path ?? null)}>
            Use this folder
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
