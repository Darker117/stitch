import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { spring } from '@/lib/motion'
import { useToasts } from '@/stores/toast'

export function Toaster(): React.JSX.Element {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed top-12 left-1/2 z-[70] flex w-[380px] -translate-x-1/2 flex-col items-center gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: -16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.97 }}
            transition={spring}
            className="glass-strong pointer-events-auto flex w-full items-start gap-3 rounded-2xl p-3 shadow-[var(--shadow-pop)]"
          >
            <span className={cn('mt-0.5', t.tone === 'error' ? 'text-danger' : t.tone === 'success' ? 'text-success' : 'text-accent')}>
              {t.tone === 'error' ? <AlertCircle className="size-4" /> : t.tone === 'success' ? <CheckCircle2 className="size-4" /> : <Info className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-semibold">{t.title}</div>
              {t.body && <div className="selectable mt-0.5 text-[12px] break-words text-fg-2">{t.body}</div>}
              {t.action && (
                <button onClick={t.action.run} className="mt-1.5 text-[12px] font-semibold text-accent">
                  {t.action.label}
                </button>
              )}
            </div>
            <button onClick={() => dismiss(t.id)} className="text-fg-3 hover:text-fg">
              <X className="size-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
