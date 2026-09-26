// Bottom sheet: glass panel that springs up, follows the finger and flicks away.
import { useEffect, type ReactNode } from 'react'
import { AnimatePresence, motion, useDragControls, type PanInfo } from 'motion/react'
import { cn } from '@/lib/utils'
import { ease } from '@/lib/motion'
import { pushBack } from './back'
import { tap } from './haptics'

export function Sheet({
  open,
  onClose,
  children,
  title,
  className,
  full
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  title?: ReactNode
  className?: string
  /** Tall sheet (lists, pickers). */
  full?: boolean
}): React.JSX.Element {
  const drag = useDragControls()
  useEffect(() => (open ? pushBack(onClose) : undefined), [open, onClose])
  const onDragEnd = (_: unknown, info: PanInfo): void => {
    if (info.offset.y > 110 || info.velocity.y > 600) {
      tap()
      onClose()
    }
  }
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80]">
          <motion.div
            className="absolute inset-0 bg-black/55 backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease }}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            data-state="open"
            className={cn(
              'glass-strong absolute inset-x-0 bottom-0 mx-auto flex max-h-[88vh] flex-col overflow-hidden rounded-t-[26px] border-b-0 pb-[var(--sab)] shadow-[0_-30px_80px_-20px_rgb(0_0_0/0.8)] min-[600px]:max-w-[680px]',
              full && 'h-[82vh]',
              className
            )}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 38, mass: 0.9 }}
            drag="y"
            dragListener={false}
            dragControls={drag}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.04, bottom: 0.9 }}
            onDragEnd={onDragEnd}
          >
            <div className="flex shrink-0 touch-none flex-col items-center pt-2.5 pb-1" onPointerDown={(e) => drag.start(e)}>
              <div className="h-1 w-10 rounded-full bg-white/20" />
              {title && <div className="mt-3 w-full px-5 text-[15px] font-semibold">{title}</div>}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
