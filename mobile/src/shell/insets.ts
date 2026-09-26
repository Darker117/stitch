// Safe-area and keyboard insets → CSS variables (--sat/--sab/--sal/--sar/--kb). Android's WebView
// doesn't report env(safe-area-inset-*) reliably in edge-to-edge mode, so the native plugin measures
// them. --kb is only the part of the keyboard the WebView didn't already resize away.
import { Capacitor } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'
import { StatusBar, Style } from '@capacitor/status-bar'
import { create } from 'zustand'
import { StitchDevice } from '@mobile/device/plugin'

export const useKeyboard = create<{ open: boolean; height: number }>(() => ({ open: false, height: 0 }))

let fullHeight = window.innerHeight
let ime = 0

function applyKeyboard(): void {
  // If the layout viewport already shrank for the keyboard, don't pad twice.
  if (ime <= 0) fullHeight = Math.max(fullHeight, window.innerHeight)
  const resized = Math.max(0, fullHeight - window.innerHeight)
  const pad = Math.max(0, ime - resized)
  document.documentElement.style.setProperty('--kb', `${Math.round(pad)}px`)
  useKeyboard.setState({ open: ime > 80, height: ime })
}

function apply(i: { top: number; bottom: number; left: number; right: number; ime?: number }): void {
  const s = document.documentElement.style
  s.setProperty('--sat', `${Math.round(i.top)}px`)
  s.setProperty('--sab', `${Math.round(i.bottom)}px`)
  s.setProperty('--sal', `${Math.round(i.left)}px`)
  s.setProperty('--sar', `${Math.round(i.right)}px`)
  ime = Math.max(0, i.ime ?? 0)
  applyKeyboard()
}

export async function installInsets(): Promise<void> {
  window.addEventListener('resize', applyKeyboard)
  if (!Capacitor.isNativePlatform()) return
  void StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {})
  void StatusBar.setStyle({ style: Style.Dark }).catch(() => {})
  let native = false
  try {
    apply(await StitchDevice.insets())
    void StitchDevice.addListener('insets', apply)
    native = true
  } catch {
    // Older native build without insets: rely on env() and the keyboard plugin.
  }
  if (!native) {
    void Keyboard.addListener('keyboardWillShow', (e) => {
      ime = e.keyboardHeight
      applyKeyboard()
    })
    void Keyboard.addListener('keyboardWillHide', () => {
      ime = 0
      applyKeyboard()
    })
  }
}
