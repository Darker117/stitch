// Android back button: closes the top-most sheet/dialog first, then walks back through pages.
import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

const stack: (() => void)[] = []

/** Register something the back button should close; returns the unregister function. */
export function pushBack(close: () => void): () => void {
  stack.push(close)
  return () => {
    const i = stack.lastIndexOf(close)
    if (i >= 0) stack.splice(i, 1)
  }
}

function openRadixLayer(): boolean {
  return !!document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [data-radix-popper-content-wrapper]')
}

export function installBackButton(): void {
  if (!Capacitor.isNativePlatform()) return
  void App.addListener('backButton', ({ canGoBack }) => {
    const top = stack[stack.length - 1]
    if (top) {
      top()
      return
    }
    // Radix dialogs/menus close on Escape.
    if (openRadixLayer()) {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return
    }
    const hash = location.hash.replace(/^#/, '') || '/'
    if (hash !== '/' && (canGoBack || history.length > 1)) history.back()
    else if (hash !== '/') location.hash = '#/'
    else void App.minimizeApp()
  })
}
