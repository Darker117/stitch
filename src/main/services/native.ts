// Native Windows touches: taskbar progress and toast notifications for jobs.
import { BrowserWindow, Notification } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GenJob } from '@shared/types'

let lastProgress = -2

/** Aggregate progress of active jobs on the taskbar button. */
export function updateTaskbar(jobs: GenJob[]): void {
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running')
  let value = -1
  if (active.length) {
    const running = active.filter((j) => j.progress?.max)
    value = running.length ? running.reduce((s, j) => s + j.progress!.value / j.progress!.max, 0) / active.length : 2 // 2 = indeterminate
  }
  const rounded = value === 2 || value === -1 ? value : Math.round(value * 50) / 50
  if (rounded === lastProgress) return
  lastProgress = rounded
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    if (rounded === 2) w.setProgressBar(2, { mode: 'indeterminate' })
    else w.setProgressBar(rounded)
  }
}

function icon(): string | undefined {
  return [join(process.resourcesPath ?? '', 'icon.png'), join(__dirname, '../../resources/icon.png')].find((p) => existsSync(p))
}

/** Tell the user a long job finished while Stitch wasn't in front. */
export function notifyFinished(job: GenJob, name: string): void {
  const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused())
  const long = job.startedAt && job.finishedAt ? job.finishedAt - job.startedAt > 20_000 : false
  if (focused || !long || !Notification.isSupported()) return
  const ok = job.status === 'done'
  const n = new Notification({
    title: ok ? `${name} is ready` : `${name} failed`,
    body: ok ? (typeof job.params.prompt === 'string' ? job.params.prompt.slice(0, 120) : 'Your generation finished.') : (job.error ?? 'Something went wrong.'),
    icon: icon(),
    silent: false
  })
  n.on('click', () => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w) {
      if (w.isMinimized()) w.restore()
      w.focus()
    }
  })
  n.show()
}
