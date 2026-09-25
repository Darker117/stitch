import { useState } from 'react'
import { useNavigate } from 'react-router'
import { motion } from 'motion/react'
import { ArrowLeft, ArrowUpRight } from 'lucide-react'
import { Page } from '@/components/shell/page'
import { IconButton } from '@/components/ui/button'
import { Spinner } from '@/components/ui/misc'
import { errorText } from '@/lib/api'
import { ease, rise, stagger } from '@/lib/motion'
import { toast } from '@/stores/toast'
import { TemplateArt } from './components/art'
import { StoryStyles } from './components/StoryStyles'
import { createFromTemplate, TEMPLATES, type TemplateId } from './templates'

export function TemplatesPage(): React.JSX.Element {
  const navigate = useNavigate()
  const [busy, setBusy] = useState<TemplateId | null>(null)

  const pick = async (id: TemplateId): Promise<void> => {
    if (busy) return
    setBusy(id)
    try {
      const s = await createFromTemplate(id)
      navigate(`/stories/scenario/${s.id}`)
    } catch (err) {
      toast.error('Could not create the scenario', errorText(err))
      setBusy(null)
    }
  }

  return (
    <Page>
      <StoryStyles />
      <div className="mx-auto max-w-[1180px] px-8 pt-7 pb-14">
        <div className="flex items-start gap-3">
          <IconButton label="Back to stories" variant="secondary" onClick={() => navigate('/stories')} className="mt-1">
            <ArrowLeft className="size-4" />
          </IconButton>
          <div>
            <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease }} className="font-serif text-[30px] font-semibold tracking-tight">
              Choose a template
            </motion.h1>
            <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease, delay: 0.06 }} className="mt-1 text-[13px] text-fg-2">
              These templates help you set up a scenario that you can play and share with others.
            </motion.p>
          </div>
        </div>

        <motion.div variants={stagger(0.05, 0.08)} initial="initial" animate="animate" className="mt-8 grid grid-cols-3 gap-4">
          {TEMPLATES.map((t) => (
            <motion.button
              key={t.id}
              variants={rise}
              whileHover={{ y: -4 }}
              whileTap={{ scale: 0.985 }}
              transition={{ type: 'spring', stiffness: 380, damping: 28 }}
              onClick={() => void pick(t.id)}
              className="group relative aspect-[16/9] overflow-hidden rounded-[18px] text-left ring-1 ring-line transition-shadow duration-300 hover:shadow-[0_24px_60px_-20px_color-mix(in_oklab,var(--accent)_45%,transparent)] hover:ring-line-strong"
            >
              <TemplateArt template={t.id} className="absolute inset-0" />
              <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 p-4">
                <div>
                  <div className="font-serif text-[19px] font-semibold text-white drop-shadow">{t.name}</div>
                  <div className="mt-0.5 text-[12px] text-white/65 transition-colors group-hover:text-white/85">{t.blurb}</div>
                </div>
                <span className="grid size-8 translate-y-1 place-items-center rounded-full bg-white/10 text-white opacity-0 backdrop-blur transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
                  <ArrowUpRight className="size-4" />
                </span>
              </div>
              {busy === t.id && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 grid place-items-center bg-black/50 backdrop-blur-sm">
                  <Spinner className="size-6 text-white" />
                </motion.div>
              )}
            </motion.button>
          ))}
        </motion.div>
      </div>
    </Page>
  )
}
