// Play-screen themes. Each theme overrides the colour tokens for the play
// subtree (so every kit component follows along) and restyles the command
// buttons (bevels, angles, glows) and the backdrop.
import type { CSSProperties } from 'react'
import type { PlayTheme, TextStyle } from '@shared/types'

export interface ThemeDef {
  id: PlayTheme
  name: string
  group: 'default' | 'styled'
  tagline: string
  light?: boolean
  /** Token overrides applied on the play root. */
  vars: Record<string, string>
  /** Full-screen backdrop layers. */
  backdrop: string
  /** Command button look. */
  button: { radius: string; clip?: string; primary: CSSProperties; secondary: CSSProperties }
}

const derived = {
  '--grad': 'linear-gradient(120deg, var(--accent-2) 0%, color-mix(in oklab, var(--accent-2) 45%, var(--accent)) 50%, var(--accent) 100%)',
  '--grad-soft': 'linear-gradient(120deg, color-mix(in oklab, var(--accent-2) 22%, transparent), color-mix(in oklab, var(--accent) 22%, transparent))',
  '--ring': '0 0 0 1px color-mix(in oklab, var(--accent) 55%, transparent), 0 0 0 4px color-mix(in oklab, var(--accent) 16%, transparent)'
}

export const THEMES: ThemeDef[] = [
  {
    id: 'dynamic',
    name: 'Dynamic',
    group: 'default',
    tagline: 'Colours change per adventure',
    vars: {
      ...derived,
      '--fg': '#eeebf5',
      '--fg-2': '#aaa4b9',
      '--fg-3': '#6d687c',
      '--line': 'rgb(255 255 255 / 0.075)',
      '--line-strong': 'rgb(255 255 255 / 0.13)',
      '--panel': 'rgb(17 15 25 / 0.8)',
      '--st-bg': '#07060b',
      '--st-text': '#eeebf5',
      '--st-muted': '#aaa4b9'
    },
    backdrop:
      'radial-gradient(120% 70% at 50% 118%, color-mix(in oklab, var(--accent) 26%, transparent) 0%, transparent 62%), radial-gradient(70% 55% at 0% 0%, color-mix(in oklab, var(--accent-2) 18%, transparent) 0%, transparent 70%), radial-gradient(60% 50% at 100% 10%, color-mix(in oklab, var(--accent) 10%, transparent) 0%, transparent 70%), #07060b',
    button: {
      radius: '12px',
      primary: {},
      secondary: {}
    }
  },
  {
    id: 'orcish',
    name: 'Orcish',
    group: 'styled',
    tagline: 'Black iron and ember glow',
    vars: {
      ...derived,
      '--accent': '#e4482c',
      '--accent-2': '#ff9340',
      '--accent-fg': '#140806',
      '--fg': '#f3e7dd',
      '--fg-2': '#bda391',
      '--fg-3': '#7c665a',
      '--line': 'rgb(255 96 60 / 0.13)',
      '--line-strong': 'rgb(255 110 70 / 0.24)',
      '--panel': 'rgb(18 9 7 / 0.86)',
      '--panel-solid': '#120907',
      '--st-bg': '#080404',
      '--st-text': '#f3e7dd',
      '--st-muted': '#bda391'
    },
    backdrop:
      'radial-gradient(90% 55% at 50% 115%, rgb(228 72 44 / 0.42) 0%, rgb(140 30 16 / 0.18) 40%, transparent 70%), radial-gradient(40% 30% at 15% 100%, rgb(255 147 64 / 0.22), transparent 70%), radial-gradient(40% 30% at 85% 100%, rgb(255 110 50 / 0.18), transparent 70%), linear-gradient(180deg, #050303 0%, #0b0504 60%, #140705 100%)',
    button: {
      radius: '4px',
      primary: {
        background: 'linear-gradient(180deg, #ff6a3d 0%, #c7321c 55%, #8e1f10 100%)',
        border: '1px solid rgb(255 150 90 / 0.55)',
        boxShadow: '0 0 22px -2px rgb(255 80 40 / 0.55), inset 0 1px 0 rgb(255 210 170 / 0.45), inset 0 -2px 0 rgb(0 0 0 / 0.35)',
        color: '#fff4ea'
      },
      secondary: {
        background: 'linear-gradient(180deg, #1d0f0b, #120806)',
        border: '1px solid rgb(255 96 60 / 0.28)',
        boxShadow: 'inset 0 1px 0 rgb(255 140 90 / 0.14), 0 0 14px -6px rgb(255 80 40 / 0.5)',
        color: '#f3e7dd'
      }
    }
  },
  {
    id: 'atlantis',
    name: 'Atlantis',
    group: 'styled',
    tagline: 'Deep teal with golden bevels',
    vars: {
      ...derived,
      '--accent': '#e0b862',
      '--accent-2': '#35c2b4',
      '--accent-fg': '#0b1a18',
      '--fg': '#e7f4f0',
      '--fg-2': '#9fc6bd',
      '--fg-3': '#5e8a83',
      '--line': 'rgb(224 184 98 / 0.16)',
      '--line-strong': 'rgb(224 184 98 / 0.3)',
      '--panel': 'rgb(4 30 33 / 0.86)',
      '--panel-solid': '#041e21',
      '--st-bg': '#031416',
      '--st-text': '#e7f4f0',
      '--st-muted': '#9fc6bd'
    },
    backdrop:
      'radial-gradient(80% 50% at 50% -10%, rgb(80 220 200 / 0.20), transparent 70%), radial-gradient(60% 40% at 80% 110%, rgb(224 184 98 / 0.14), transparent 70%), radial-gradient(50% 35% at 10% 90%, rgb(53 194 180 / 0.16), transparent 70%), linear-gradient(180deg, #04262a 0%, #03191c 50%, #020f11 100%)',
    button: {
      radius: '10px',
      primary: {
        background: 'linear-gradient(180deg, #f3d48a 0%, #d3a24a 50%, #9c7128 100%)',
        border: '1px solid #f7e2a8',
        boxShadow: 'inset 0 1px 0 rgb(255 245 210 / 0.8), inset 0 -2px 0 rgb(80 50 10 / 0.45), 0 6px 18px -6px rgb(224 184 98 / 0.55)',
        color: '#1b1406'
      },
      secondary: {
        background: 'linear-gradient(180deg, #0b3a3d, #062a2d)',
        border: '1px solid rgb(224 184 98 / 0.45)',
        boxShadow: 'inset 0 1px 0 rgb(255 230 170 / 0.25), inset 0 -2px 0 rgb(0 0 0 / 0.35)',
        color: '#e7f4f0'
      }
    }
  },
  {
    id: 'smores',
    name: "S'mores",
    group: 'styled',
    tagline: 'Toasted cream and cocoa',
    light: true,
    vars: {
      ...derived,
      '--accent': '#b3542a',
      '--accent-2': '#d99045',
      '--accent-fg': '#fff7ec',
      '--fg': '#3a2416',
      '--fg-2': '#6d4b33',
      '--fg-3': '#a0806a',
      '--line': 'rgb(90 55 30 / 0.14)',
      '--line-strong': 'rgb(90 55 30 / 0.26)',
      '--panel': 'rgb(255 249 239 / 0.9)',
      '--panel-solid': '#fbf2e3',
      '--st-bg': '#f3e6d1',
      '--st-text': '#3a2416',
      '--st-muted': '#6d4b33'
    },
    backdrop:
      'radial-gradient(90% 60% at 50% 120%, rgb(217 144 69 / 0.28), transparent 70%), radial-gradient(60% 45% at 0% 0%, rgb(255 255 255 / 0.7), transparent 70%), linear-gradient(180deg, #f8efe0 0%, #f1e2cb 100%)',
    button: {
      radius: '999px',
      primary: {
        background: 'linear-gradient(180deg, #7a4526 0%, #53301a 100%)',
        border: '1px solid #4a2a16',
        boxShadow: '0 6px 16px -8px rgb(83 48 26 / 0.7), inset 0 1px 0 rgb(255 220 190 / 0.25)',
        color: '#fff4e4'
      },
      secondary: {
        background: 'linear-gradient(180deg, #fffaf2, #f3e3cb)',
        border: '1px solid rgb(90 55 30 / 0.22)',
        boxShadow: '0 2px 6px -3px rgb(83 48 26 / 0.35), inset 0 1px 0 #fff',
        color: '#3a2416'
      }
    }
  },
  {
    id: 'cyber',
    name: 'Cyber',
    group: 'styled',
    tagline: 'Navy steel and cyan neon',
    vars: {
      ...derived,
      '--accent': '#22e1ff',
      '--accent-2': '#7a5cff',
      '--accent-fg': '#021018',
      '--fg': '#dbf6ff',
      '--fg-2': '#8fb6cc',
      '--fg-3': '#557289',
      '--line': 'rgb(34 225 255 / 0.16)',
      '--line-strong': 'rgb(34 225 255 / 0.32)',
      '--panel': 'rgb(5 12 30 / 0.88)',
      '--panel-solid': '#050c1e',
      '--st-bg': '#030817',
      '--st-text': '#dbf6ff',
      '--st-muted': '#8fb6cc'
    },
    backdrop:
      'linear-gradient(rgb(34 225 255 / 0.05) 1px, transparent 1px) 0 0 / 44px 44px, linear-gradient(90deg, rgb(34 225 255 / 0.05) 1px, transparent 1px) 0 0 / 44px 44px, radial-gradient(70% 50% at 50% 115%, rgb(34 225 255 / 0.22), transparent 70%), radial-gradient(50% 40% at 100% 0%, rgb(122 92 255 / 0.22), transparent 70%), linear-gradient(180deg, #040a1c 0%, #030817 100%)',
    button: {
      radius: '0px',
      clip: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)',
      primary: {
        background: 'linear-gradient(90deg, #22e1ff, #6c7bff)',
        boxShadow: '0 0 24px -4px rgb(34 225 255 / 0.7)',
        color: '#021018'
      },
      secondary: {
        background: 'linear-gradient(180deg, rgb(34 225 255 / 0.12), rgb(34 225 255 / 0.04))',
        boxShadow: 'inset 0 0 0 1px rgb(34 225 255 / 0.4)',
        color: '#dbf6ff'
      }
    }
  }
]

export function themeDef(id: PlayTheme | undefined): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

export const TEXT_STYLES: { value: TextStyle; label: string; font: string }[] = [
  { value: 'print', label: 'Print', font: 'var(--font-serif)' },
  { value: 'clean', label: 'Clean', font: 'var(--font-sans)' },
  { value: 'hacker', label: 'Hacker', font: 'var(--font-mono)' }
]

export function storyFont(style: TextStyle | undefined): string {
  return TEXT_STYLES.find((t) => t.value === style)?.font ?? 'var(--font-serif)'
}
