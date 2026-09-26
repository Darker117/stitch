// Wallpaper Engine source in Settings → Appearance: installed wallpapers, and
// Discover for finding new ones on the Steam Workshop.
import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Compass, Library } from 'lucide-react'
import { Segmented } from '@/components/ui/controls'
import { WallpaperDiscover } from './Discover'
import { WallpaperLibrary, segFull } from './Library'

type View = 'library' | 'discover'

export function WallpaperPicker({ current, applying, onApply }: { current?: string; applying?: string; onApply: (id: string) => void }): React.JSX.Element {
  const [view, setView] = useState<View>('library')
  return (
    <div>
      <Segmented
        size="sm"
        className={`mb-3 ${segFull}`}
        value={view}
        onChange={setView}
        items={[
          { value: 'library', label: 'My wallpapers', icon: <Library /> },
          { value: 'discover', label: 'Discover', icon: <Compass /> }
        ]}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={view} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.22 }}>
          {view === 'library' ? (
            <WallpaperLibrary current={current} applying={applying} onApply={onApply} onDiscover={() => setView('discover')} />
          ) : (
            <WallpaperDiscover current={current} applying={applying} onApply={onApply} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
