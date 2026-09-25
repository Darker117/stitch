import { cloneElement, lazy, Suspense, useEffect, useState, type ComponentType, type ReactElement } from 'react'
import { createHashRouter, Outlet, RouterProvider, useLocation, useNavigate, useOutlet } from 'react-router'
import { AnimatePresence, motion } from 'motion/react'
import { Background } from '@/components/shell/background'
import { JobTray } from '@/components/shell/job-tray'
import { UpdatePrompt } from '@/components/shell/update-prompt'
import { Sidebar } from '@/components/shell/sidebar'
import { Toaster } from '@/components/shell/toaster'
import { TooltipProvider } from '@/components/ui/overlay'
import { CommandPalette } from '@/components/shell/command'
import { useAutoAccent } from '@/components/shell/live-accent'
import { applyTheme } from '@/lib/theme'
import { invoke } from '@/lib/api'
import type { Connector } from '@shared/types'
import { ease } from '@/lib/motion'
import { useGen } from '@/stores/gen'
import { useSettings } from '@/stores/settings'
import { CreatePage } from '@/features/create/CreatePage'
import { Onboarding } from '@/features/onboarding/Onboarding'

// Pages load on demand and are warmed in the background right after first paint.
const loaders: (() => Promise<unknown>)[] = []
function lazyPage<M extends Record<string, unknown>>(loader: () => Promise<M>, name: keyof M): ComponentType {
  loaders.push(loader)
  const C = lazy(() => loader().then((m) => ({ default: m[name] as ComponentType })))
  return function LazyPage() {
    return (
      <Suspense fallback={null}>
        <C />
      </Suspense>
    )
  }
}
const StoriesHome = lazyPage(() => import('@/features/stories/StoriesHome'), 'StoriesHome')
const TemplatesPage = lazyPage(() => import('@/features/stories/TemplatesPage'), 'TemplatesPage')
const ScenarioEditor = lazyPage(() => import('@/features/stories/ScenarioEditor'), 'ScenarioEditor')
const ComposerPage = lazyPage(() => import('@/features/stories/composer/ComposerPage'), 'ComposerPage')
const PlayScreen = lazyPage(() => import('@/features/stories/PlayScreen'), 'PlayScreen')
const CharactersPage = lazyPage(() => import('@/features/characters/CharactersPage'), 'CharactersPage')
const CharacterDetail = lazyPage(() => import('@/features/characters/CharacterDetail'), 'CharacterDetail')
const GeneratePage = lazyPage(() => import('@/features/generate/GeneratePage'), 'GeneratePage')
const StudioHome = lazyPage(() => import('@/features/studio/StudioHome'), 'StudioHome')
const EditorPage = lazyPage(() => import('@/features/studio/EditorPage'), 'EditorPage')
const AssetsPage = lazyPage(() => import('@/features/assets/AssetsPage'), 'AssetsPage')
const ProjectsPage = lazyPage(() => import('@/features/projects/ProjectsPage'), 'ProjectsPage')
const ModelsPage = lazyPage(() => import('@/features/models/ModelsPage'), 'ModelsPage')
const SkillsPage = lazyPage(() => import('@/features/skills/SkillsPage'), 'SkillsPage')
const ConnectorsPage = lazyPage(() => import('@/features/connectors/ConnectorsPage'), 'ConnectorsPage')
const SettingsPage = lazyPage(() => import('@/features/settings/SettingsPage'), 'SettingsPage')

/** Route group key: sub-pages that share chrome don't re-run the page transition. */
function groupKey(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] === 'generate') return '/generate'
  if (parts[0] === 'chat') return '/'
  return '/' + parts.slice(0, 2).join('/')
}

function AnimatedOutlet(): React.JSX.Element {
  const location = useLocation()
  const outlet = useOutlet()
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {outlet && cloneElement(outlet as ReactElement, { key: groupKey(location.pathname) })}
    </AnimatePresence>
  )
}

function Shell(): React.JSX.Element {
  const [collapsed, setCollapsed] = useState(false)
  const [palette, setPalette] = useState(false)
  const navigate = useNavigate()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette((p) => !p)
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setCollapsed((c) => !c)
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        navigate('/')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  return (
    <div className="relative flex h-full">
      <div className="drag absolute inset-x-0 top-0 h-[var(--titlebar)]" />
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} onSearch={() => setPalette(true)} />
      <main className="relative z-0 flex min-w-0 flex-1 flex-col pt-[var(--titlebar)] pr-2 pb-2">
        <div className="glass hairline relative min-h-0 flex-1 overflow-hidden rounded-[18px] shadow-[0_30px_80px_-30px_rgb(0_0_0/0.8)]">
          <AnimatedOutlet />
        </div>
      </main>
      <JobTray />
      <UpdatePrompt />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  )
}

/** Full-window routes (the story player) keep only the title-bar drag strip. */
function Immersive(): React.JSX.Element {
  return (
    <div className="relative h-full">
      <div className="drag absolute inset-x-0 top-0 z-50 h-[var(--titlebar)]" style={{ right: 140 }} />
      <Outlet />
      <JobTray />
      <UpdatePrompt />
    </div>
  )
}

const router = createHashRouter([
  {
    element: <Shell />,
    children: [
      { path: '/', element: <CreatePage /> },
      { path: '/chat/:id', element: <CreatePage /> },
      { path: '/stories', element: <StoriesHome /> },
      { path: '/stories/new', element: <TemplatesPage /> },
      { path: '/stories/scenario/:id', element: <ScenarioEditor /> },
      { path: '/stories/compose', element: <ComposerPage /> },
      { path: '/characters', element: <CharactersPage /> },
      { path: '/characters/:id', element: <CharacterDetail /> },
      { path: '/generate/:kind', element: <GeneratePage /> },
      { path: '/studio', element: <StudioHome /> },
      { path: '/studio/:id', element: <EditorPage /> },
      { path: '/assets', element: <AssetsPage /> },
      { path: '/projects', element: <ProjectsPage /> },
      { path: '/projects/:id', element: <ProjectsPage /> },
      { path: '/models', element: <ModelsPage /> },
      { path: '/skills', element: <SkillsPage /> },
      { path: '/connectors', element: <ConnectorsPage /> },
      { path: '/settings', element: <SettingsPage /> }
    ]
  },
  {
    element: <Immersive />,
    children: [{ path: '/play/:id', element: <PlayScreen /> }]
  }
])

export function App(): React.JSX.Element {
  const settings = useSettings((s) => s.settings)
  const load = useSettings((s) => s.load)
  const initGen = useGen((s) => s.init)

  useEffect(() => {
    void load()
    void initGen()
  }, [load, initGen])

  useEffect(() => {
    if (settings) applyTheme(settings.theme)
  }, [settings?.theme])
  useAutoAccent(settings?.theme)

  // Warm every page chunk once the first screen is up, so navigation stays instant.
  useEffect(() => {
    const warm = (): void => {
      for (const l of loaders) void l()
    }
    const id = window.requestIdleCallback ? window.requestIdleCallback(warm, { timeout: 2500 }) : window.setTimeout(warm, 1200)
    return () => (window.cancelIdleCallback ? window.cancelIdleCallback(id) : clearTimeout(id))
  }, [])

  // Warm model lists for text connectors so a default model is ready at once.
  useEffect(() => {
    void invoke('db:list', 'connectors').then((list) => {
      for (const c of list as Connector[]) {
        if (c.category === 'llm' && c.enabled && !c.models?.length) void invoke('llm:models', c.id, true).catch(() => {})
      }
    })
  }, [])

  return (
    <TooltipProvider>
      <AnimatePresence mode="wait">
        {!settings ? (
          <motion.div key="boot" className="grid h-full place-items-center" exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }} />
        ) : (
          <motion.div key="app" className="isolate h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, ease }}>
            <Background bg={settings.theme.background} />
            <RouterProvider router={router} />
            <AnimatePresence>{!settings.onboardingDone && <Onboarding key="onboarding" />}</AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
      <Toaster />
    </TooltipProvider>
  )
}
