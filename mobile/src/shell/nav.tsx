// Phone navigation model: five tabs, everything else in "More" and the drawer.
import type { ReactNode } from 'react'
import { BookOpen, Blocks, Boxes, Clapperboard, Cpu, FolderOpen, Layers, MessageSquare, ScanFace, Settings, Sparkles, Zap } from 'lucide-react'

export interface Tab {
  to: string
  label: string
  icon: ReactNode
  match: (path: string) => boolean
}

export const TABS: Tab[] = [
  { to: '/', label: 'Chat', icon: <MessageSquare />, match: (p) => p === '/' || p.startsWith('/chat') },
  { to: '/stories', label: 'Stories', icon: <BookOpen />, match: (p) => p.startsWith('/stories') },
  { to: '/generate/image', label: 'Create', icon: <Sparkles />, match: (p) => p.startsWith('/generate') },
  { to: '/characters', label: 'Cast', icon: <ScanFace />, match: (p) => p.startsWith('/characters') }
]

export const MORE: (Tab & { hint: string })[] = [
  { to: '/assets', label: 'Assets', hint: 'Everything you made', icon: <FolderOpen />, match: (p) => p.startsWith('/assets') },
  { to: '/studio', label: 'Studio', hint: 'Edit and cut video', icon: <Clapperboard />, match: (p) => p.startsWith('/studio') },
  { to: '/projects', label: 'Projects', hint: 'Worlds and styles', icon: <Layers />, match: (p) => p.startsWith('/projects') },
  { to: '/phone', label: 'This phone', hint: 'On-device models', icon: <Cpu />, match: (p) => p.startsWith('/phone') },
  { to: '/models', label: 'Models', hint: 'PC model library', icon: <Boxes />, match: (p) => p.startsWith('/models') },
  { to: '/skills', label: 'Skills', hint: 'Workflows, web search', icon: <Zap />, match: (p) => p.startsWith('/skills') },
  { to: '/connectors', label: 'Connectors', hint: 'Models and voices', icon: <Blocks />, match: (p) => p.startsWith('/connectors') },
  { to: '/settings', label: 'Settings', hint: 'Profile, theme, PC', icon: <Settings />, match: (p) => p.startsWith('/settings') }
]
