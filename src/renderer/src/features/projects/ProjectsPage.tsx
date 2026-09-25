import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, BookOpen, Box, Clock, Layers, MessageSquare, MoreHorizontal, Plus, ScanFace, Trash2, UserRound } from 'lucide-react'
import { nanoid } from 'nanoid'
import type { Project } from '@shared/types'
import { fileUrl } from '@/lib/api'
import { characterRefs } from '@/lib/characters'
import { cn, timeAgo } from '@/lib/utils'
import { ease, rise, spring, stagger } from '@/lib/motion'
import { Page } from '@/components/shell/page'
import { AssetLightbox, AssetThumb } from '@/components/media'
import { Button, IconButton } from '@/components/ui/button'
import { Tabs } from '@/components/ui/controls'
import { Input, SearchField, Textarea } from '@/components/ui/input'
import { EmptyState, Field } from '@/components/ui/misc'
import { Dialog, Menu, MenuItem } from '@/components/ui/overlay'
import { db, useCollection, useDoc } from '@/stores/db'

function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [style, setStyle] = useState('')
  const create = async (): Promise<void> => {
    const now = Date.now()
    const p: Project = { id: nanoid(10), name: name.trim() || 'Untitled project', description: '', style: style.trim(), characterIds: [], createdAt: now, updatedAt: now }
    await db.put('projects', p)
    onClose()
    setName('')
    setStyle('')
    navigate(`/projects/${p.id}`)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="New project"
      description="Everything created in a project inherits its style and cast."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()}>
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-5">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="The Drowned Kingdom" onKeyDown={(e) => e.key === 'Enter' && void create()} />
        </Field>
        <Field label="Style notes" help="Appended to image and video prompts made inside this project.">
          <Textarea value={style} onChange={(e) => setStyle(e.target.value)} minRows={3} placeholder="Painterly dark fantasy, muted teal and rust palette, volumetric fog, 35mm film grain" />
        </Field>
      </div>
    </Dialog>
  )
}

function ProjectDetail({ id }: { id: string }): React.JSX.Element {
  const navigate = useNavigate()
  const p = useDoc('projects', id)
  const characters = useCollection('characters')
  const assets = useCollection('assets')
  const chats = useCollection('chats')
  const scenarios = useCollection('scenarios')
  const [tab, setTab] = useState<'assets' | 'cast' | 'stories' | 'chats'>('assets')
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [style, setStyle] = useState(p?.style ?? '')
  useEffect(() => setStyle(p?.style ?? ''), [p?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return <EmptyState className="h-full" title="Project not found" />

  const pAssets = assets.filter((a) => a.projectId === p.id)
  const cast = characters.filter((c) => p.characterIds.includes(c.id) || c.projectId === p.id)
  const pStories = scenarios.filter((s) => s.projectId === p.id && !s.parentId)
  const pChats = chats.filter((c) => c.projectId === p.id)

  return (
    <div>
      <div className="flex items-center gap-3 px-6 pt-5">
        <IconButton label="Back" onClick={() => navigate('/projects')}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <input value={p.name} onChange={(e) => void db.patch('projects', p.id, { name: e.target.value, updatedAt: Date.now() })} className="display flex-1 bg-transparent text-[26px] outline-none" />
        <Menu
          align="end"
          trigger={
            <IconButton label="More">
              <MoreHorizontal className="size-4" />
            </IconButton>
          }
        >
          <MenuItem
            danger
            icon={<Trash2 />}
            onSelect={async () => {
              await db.remove('projects', p.id)
              navigate('/projects')
            }}
          >
            Delete project
          </MenuItem>
        </Menu>
      </div>
      <div className="px-8 pt-4">
        <Field label="Style inherited by everything in this project">
          <Textarea value={style} onChange={(e) => setStyle(e.target.value)} onBlur={() => void db.patch('projects', p.id, { style, updatedAt: Date.now() })} minRows={2} />
        </Field>
      </div>
      <div className="px-8 pt-6">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'assets', label: 'Assets', icon: <Box />, count: pAssets.length },
            { value: 'cast', label: 'Cast', icon: <ScanFace />, count: cast.length },
            { value: 'stories', label: 'Stories', icon: <BookOpen />, count: pStories.length },
            { value: 'chats', label: 'Chats', icon: <MessageSquare />, count: pChats.length }
          ]}
        />
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }} className="py-6">
            {tab === 'assets' &&
              (pAssets.length ? (
                <div className="grid grid-cols-5 gap-3">
                  {pAssets.map((a) => (
                    <AssetThumb key={a.id} asset={a} className="aspect-square" onClick={() => setLightbox(a.id)} />
                  ))}
                </div>
              ) : (
                <EmptyState icon={<Box />} title="No assets yet" body="Pick this project in the New chat box, or add assets from the library." />
              ))}
            {tab === 'cast' && (
              <div className="grid grid-cols-6 gap-3">
                {characters.map((c) => {
                  const on = p.characterIds.includes(c.id)
                  const ref = db.get('assets', characterRefs(c, 1)[0] ?? '')
                  return (
                    <motion.button
                      key={c.id}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => void db.patch('projects', p.id, { characterIds: on ? p.characterIds.filter((x) => x !== c.id) : [...p.characterIds, c.id] })}
                      className={cn('overflow-hidden rounded-2xl border text-left transition', on ? 'border-[color-mix(in_oklab,var(--accent)_55%,transparent)]' : 'border-line opacity-60 hover:opacity-100')}
                    >
                      <div className="aspect-square bg-white/[0.03]">{ref ? <img src={fileUrl(ref.path)} className="size-full object-cover" /> : <UserRound className="m-auto mt-8 size-8 text-fg-3" />}</div>
                      <div className="p-2 text-[12px] font-medium">{c.name}</div>
                    </motion.button>
                  )
                })}
                {!characters.length && <EmptyState className="col-span-6" icon={<ScanFace />} title="No characters yet" />}
              </div>
            )}
            {tab === 'stories' && (
              <div className="grid grid-cols-3 gap-3">
                {pStories.map((s) => (
                  <button key={s.id} onClick={() => navigate(`/stories/scenario/${s.id}`)} className="glass hairline rounded-2xl p-4 text-left">
                    <div className="font-serif text-[16px] font-semibold">{s.title || 'Untitled'}</div>
                    <div className="mt-1 line-clamp-2 text-[12px] text-fg-3">{s.description}</div>
                  </button>
                ))}
                {!pStories.length && <EmptyState className="col-span-3" icon={<BookOpen />} title="No stories in this project" />}
              </div>
            )}
            {tab === 'chats' && (
              <div className="space-y-2">
                {pChats.map((c) => (
                  <button key={c.id} onClick={() => navigate(`/chat/${c.id}`)} className="glass hairline flex w-full items-center justify-between rounded-xl px-4 py-3 text-left">
                    <span className="text-[13px] font-medium">{c.title}</span>
                    <span className="text-[11.5px] text-fg-3">{timeAgo(c.updatedAt)}</span>
                  </button>
                ))}
                {!pChats.length && <EmptyState icon={<MessageSquare />} title="No chats in this project" />}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      <AssetLightbox assetId={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}

export function ProjectsPage(): React.JSX.Element {
  const { id } = useParams()
  const projects = useCollection('projects')
  const assets = useCollection('assets')
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [tab, setTab] = useState<'all' | 'recent'>('all')
  const list = useMemo(() => {
    const base = projects.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()))
    return tab === 'recent' ? base.filter((p) => Date.now() - p.updatedAt < 7 * 86400_000) : base
  }, [projects, q, tab])

  if (id) {
    return (
      <Page>
        <ProjectDetail id={id} />
      </Page>
    )
  }

  return (
    <Page>
      <div className="flex items-center justify-between px-8 pt-6">
        <h1 className="text-[15px] font-semibold">Projects</h1>
        <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
          New project
        </Button>
      </div>
      <div className="flex items-end justify-between px-8 pt-4">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'all', label: 'All', icon: <Layers /> },
            { value: 'recent', label: 'Recent', icon: <Clock /> }
          ]}
          className="flex-1"
        />
        <div className="border-b border-line pb-2 pl-4">
          <SearchField value={q} onChange={setQ} className="w-[260px]" />
        </div>
      </div>
      {list.length ? (
        <motion.div variants={stagger(0.04)} initial="initial" animate="animate" className="grid grid-cols-4 gap-4 px-8 py-6">
          {list.map((p) => {
            const cover = assets.find((a) => a.projectId === p.id && a.kind === 'image')
            const count = assets.filter((a) => a.projectId === p.id).length
            return (
              <motion.button key={p.id} variants={rise} whileHover={{ y: -4 }} transition={spring} onClick={() => navigate(`/projects/${p.id}`)} className="glass hairline group overflow-hidden rounded-2xl text-left">
                <div className="relative aspect-video overflow-hidden bg-grad-soft">
                  {cover && <img src={fileUrl(cover.path)} className="size-full object-cover transition-transform duration-700 group-hover:scale-105" />}
                </div>
                <div className="p-3.5">
                  <div className="text-[13.5px] font-semibold">{p.name}</div>
                  <div className="mt-0.5 text-[11.5px] text-fg-3">
                    {count} assets · {timeAgo(p.updatedAt)}
                  </div>
                </div>
              </motion.button>
            )
          })}
        </motion.div>
      ) : (
        <div className="grid h-[60vh] place-items-center">
          <EmptyState
            icon={<Layers />}
            title={<span className="uppercase">Create your first project</span>}
            body="Everything in a project inherits its style and cast."
            action={
              <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
                Create
              </Button>
            }
          />
        </div>
      )}
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </Page>
  )
}
