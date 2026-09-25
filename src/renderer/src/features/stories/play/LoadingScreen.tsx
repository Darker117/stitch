import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ease } from '@/lib/motion'
import { FlameMark } from '../components/art'

const TIPS = [
  'When triggered, Story Cards will fill extra space in the context and help the AI remember the details that matter.',
  'Do to act, Say to speak, Story to narrate yourself, and See to paint the moment.',
  'Retry keeps every version of a passage — flip between them with the arrows.',
  'Link a story card to a locked Character and every scene keeps their face.',
  "The Author's Note steers tone and style right before the AI writes.",
  'Click any passage to edit it. The AI treats your edits as canon.',
  'Animate turns a still into a short clip — with sound.',
  'Send to Studio turns your images, clips and narration into an editable timeline.'
]

export function LoadingScreen({ title }: { title?: string }): React.JSX.Element {
  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length))
  useEffect(() => {
    const t = setInterval(() => setTip((i) => (i + 1) % TIPS.length), 3600)
    return () => clearInterval(t)
  }, [])
  return (
    <motion.div
      key="loading"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.03, filter: 'blur(8px)' }}
      transition={{ duration: 0.6, ease }}
      className="absolute inset-0 z-[70] grid place-items-center overflow-hidden"
      style={{ background: 'radial-gradient(60% 55% at 50% 45%, color-mix(in oklab, var(--accent) 22%, transparent) 0%, color-mix(in oklab, var(--accent-2) 12%, transparent) 38%, transparent 70%), var(--st-bg, #07060b)' }}
    >
      <motion.div
        className="absolute size-[70vmin] rounded-full opacity-40 blur-[90px]"
        style={{ background: 'radial-gradient(circle, var(--accent-2), transparent 65%)' }}
        animate={{ scale: [1, 1.15, 1], x: ['-6%', '6%', '-6%'] }}
        transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="relative flex w-[520px] max-w-[86vw] flex-col items-center text-center">
        <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 16, delay: 0.05 }} className="relative">
          <motion.div className="absolute inset-0 rounded-full blur-2xl" style={{ background: 'radial-gradient(circle, var(--accent), transparent 70%)' }} animate={{ opacity: [0.35, 0.7, 0.35], scale: [0.9, 1.2, 0.9] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }} />
          <motion.div animate={{ y: [0, -4, 0] }} transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}>
            <FlameMark size={76} animate />
          </motion.div>
        </motion.div>
        <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease, delay: 0.15 }} className="mt-7 font-serif text-[30px] font-semibold tracking-tight" style={{ color: 'var(--st-text, var(--fg))' }}>
          Loading the adventure
        </motion.h1>
        {title && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3, duration: 0.5 }} className="mt-1.5 text-[13px] text-fg-2">
            {title}
          </motion.div>
        )}
        <div className="mt-6 flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <motion.span key={i} className="size-1.5 rounded-full bg-accent" animate={{ opacity: [0.25, 1, 0.25], scale: [0.8, 1.15, 0.8] }} transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18, ease: 'easeInOut' }} />
          ))}
        </div>
        <div className="relative mt-8 h-[60px] w-full">
          <AnimatePresence mode="wait">
            <motion.p
              key={tip}
              initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
              transition={{ duration: 0.5, ease }}
              className="absolute inset-x-0 text-[13px] leading-relaxed text-fg-2"
            >
              <span className="label-caps mr-2 text-accent">Tip</span>
              {TIPS[tip]}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  )
}
