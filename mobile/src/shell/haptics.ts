// Light haptic ticks on taps and toggles (no-ops in the browser).
import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle } from '@capacitor/haptics'

const native = Capacitor.isNativePlatform()

export function tap(): void {
  if (native) void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {})
}

export function thud(): void {
  if (native) void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {})
}

export function success(): void {
  if (native) void Haptics.notification({ type: 'SUCCESS' as never }).catch(() => {})
}
