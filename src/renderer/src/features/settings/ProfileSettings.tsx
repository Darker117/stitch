// Settings → General → Your profile: the player's name, personality and avatar
// (uploaded or generated). Stories use it as the default player.
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ImagePlus, Trash2, WandSparkles } from 'lucide-react'
import { create } from 'zustand'
import { defaultLlm } from '@/lib/llm'
import { errorText, fileUrl, streamLlm } from '@/lib/api'
import { sceneImageRequest } from '@/lib/characters'
import { ease, spring } from '@/lib/motion'
import { pickAndImport } from '@/components/media'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Avatar, Field, ProgressRing, SectionTitle, Surface } from '@/components/ui/misc'
import { Popover } from '@/components/ui/overlay'
import { useDoc } from '@/stores/db'
import { useGen, waitForJob } from '@/stores/gen'
import { useAppSettings, useSettings } from '@/stores/settings'
import { toast } from '@/stores/toast'

/** The avatar job outlives the settings page, so its state lives here. */
const useAvatarJob = create<{ jobId?: string; running: boolean }>(() => ({ running: false }))

async function describeLook(name: string, personality: string): Promise<string> {
  const llm = defaultLlm()
  const fallback = `${name || 'an adventurer'}, ${personality || 'friendly and curious'}`
  if (!llm) return fallback
  try {
    const res = await streamLlm({
      ...llm,
      system: 'You write short visual descriptions for portrait avatars. Reply with one line: appearance, clothing, expression and mood. No names, no preamble.',
      messages: [{ role: 'user', content: `Name: ${name || 'unknown'}\nPersonality: ${personality || 'unspecified'}` }],
      maxTokens: 120,
      temperature: 0.8
    }).done
    return res.text.trim().split('\n')[0] || fallback
  } catch {
    return fallback
  }
}

async function generateAvatar(look: string, name: string, personality: string): Promise<void> {
  if (useAvatarJob.getState().running) return
  useAvatarJob.setState({ running: true, jobId: undefined })
  try {
    const subject = look.trim() || (await describeLook(name, personality))
    const req = sceneImageRequest({ prompt: `Portrait avatar of ${subject}. Head and shoulders, centred, looking at the camera, soft cinematic light, clean simple background.`, characters: [], aspect: '1:1' })
    req.label = 'Profile avatar'
    const [job] = await useGen.getState().submit(req)
    useAvatarJob.setState({ jobId: job.id })
    const done = await waitForJob(job.id)
    if (done.status !== 'done' || !done.outputs?.[0]) throw new Error(done.error ?? 'The image model returned nothing')
    await useSettings.getState().update({ persona: { avatarAssetId: done.outputs[0] } })
    toast.success('New avatar ready')
  } catch (err) {
    toast.error('Couldn’t generate an avatar', errorText(err))
  } finally {
    useAvatarJob.setState({ running: false, jobId: undefined })
  }
}

function GeneratePopover({ name, personality }: { name: string; personality: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [look, setLook] = useState('')
  const online = useGen((s) => s.comfy.some((c) => c.online))
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant="secondary" icon={<WandSparkles className="size-3.5" />}>
          Generate
        </Button>
      }
    >
      <div className="w-[300px] space-y-3 p-1">
        <Field label="How should your avatar look?" help={personality ? 'Leave empty to imagine it from your personality.' : undefined}>
          <Textarea value={look} onChange={(e) => setLook(e.target.value)} minRows={3} maxRows={6} placeholder="e.g. silver-haired ranger, green cloak, warm smile" autoFocus />
        </Field>
        {!online && <p className="text-[12px] text-warning">ComfyUI isn’t running — start it to generate images.</p>}
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="sm"
            disabled={!online}
            icon={<WandSparkles className="size-3.5" />}
            onClick={() => {
              setOpen(false)
              void generateAvatar(look, name, personality)
            }}
          >
            Generate avatar
          </Button>
        </div>
      </div>
    </Popover>
  )
}

export function ProfileSettings(): React.JSX.Element {
  const settings = useAppSettings()
  const update = useSettings((s) => s.update)
  const [name, setName] = useState(settings.userName)
  const [personality, setPersonality] = useState(settings.persona?.personality ?? '')
  useEffect(() => setName(settings.userName), [settings.userName])
  useEffect(() => setPersonality(settings.persona?.personality ?? ''), [settings.persona?.personality])
  const avatar = useDoc('assets', settings.persona?.avatarAssetId)
  const { running, jobId } = useAvatarJob()
  const job = useGen((s) => (jobId ? s.jobs[jobId] : undefined))
  const progress = job?.progress ? job.progress.value / Math.max(1, job.progress.max) : undefined

  const upload = async (): Promise<void> => {
    const [asset] = await pickAndImport('image', false, { name: 'Profile avatar' })
    if (asset) await update({ persona: { avatarAssetId: asset.id } })
  }

  return (
    <div className="space-y-4">
      <SectionTitle>Your profile</SectionTitle>
      <Surface className="relative overflow-hidden p-5">
        <div className="pointer-events-none absolute -top-24 -left-16 size-64 rounded-full bg-grad opacity-[0.12] blur-3xl" />
        <div className="relative flex gap-6">
          <div className="flex w-[132px] shrink-0 flex-col items-center gap-3">
            <div className="relative">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={avatar?.id ?? 'none'} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={spring}>
                  <Avatar src={avatar ? fileUrl(avatar.path) : undefined} name={name || 'Storyteller'} size={112} className="text-[34px] ring-2 ring-[color-mix(in_oklab,var(--accent)_45%,transparent)]" />
                </motion.div>
              </AnimatePresence>
              <AnimatePresence>
                {running && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} className="absolute inset-0 grid place-items-center rounded-full bg-black/55 backdrop-blur-sm">
                    <ProgressRing value={progress} size={40} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              <Button size="sm" variant="secondary" icon={<ImagePlus className="size-3.5" />} onClick={() => void upload()}>
                Upload
              </Button>
              <GeneratePopover name={name} personality={personality} />
            </div>
            {avatar && !running && (
              <button onClick={() => void update({ persona: { avatarAssetId: '' } })} className="flex items-center gap-1 text-[11.5px] text-fg-3 transition hover:text-danger">
                <Trash2 className="size-3" /> Remove photo
              </button>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            <Field label="Name" help="Shown in the sidebar and used as your player name in stories.">
              <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void update({ userName: name.trim() || 'Storyteller' })} placeholder="Storyteller" />
            </Field>
            <Field label="Personality" help="Who you are when you play — temperament, background, how you talk. Stories use it for your player character.">
              <Textarea
                value={personality}
                onChange={(e) => setPersonality(e.target.value)}
                onBlur={() => void update({ persona: { personality: personality.trim() } })}
                minRows={4}
                maxRows={10}
                placeholder="A dry-witted cartographer who trusts maps more than people, quick to joke and slow to anger…"
              />
            </Field>
          </div>
        </div>
      </Surface>
    </div>
  )
}
