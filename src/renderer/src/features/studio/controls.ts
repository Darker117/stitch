// Imperative hooks the keyboard shortcuts use to reach into mounted panels.

/** Clip Viewer (source monitor). */
export const sourceControls = {
  toggle: (): void => {},
  markIn: (): void => {},
  markOut: (): void => {},
  step: (_frames: number): void => {},
  insert: (_overwrite: boolean): void => {},
  active: false
}

/** Timeline Viewer (program monitor). */
export const programControls = { fullscreen: (): void => {} }

/** Timeline zoom. */
export const timelineControls = { zoomBy: (_f: number): void => {}, fit: (): void => {} }
