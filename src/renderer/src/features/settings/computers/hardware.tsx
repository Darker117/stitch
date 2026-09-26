// Hardware cards for Settings → Computers: a PC with its GPUs (live VRAM, load, temperature).
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { Cpu, MemoryStick, Monitor, Server, Thermometer } from 'lucide-react'
import type { GpuLive, NodeService, PcHardware } from '@shared/ipc'
import { cn, formatBytes } from '@/lib/utils'
import { ease, rise } from '@/lib/motion'
import { Badge, StatusDot } from '@/components/ui/misc'

export const shortGpu = (name: string): string => name.replace(/NVIDIA GeForce /i, '').replace(/NVIDIA /i, '')

/** A horizontal meter that animates with transform only. */
export function Meter({ value, className, tone = 'grad' }: { value: number; className?: string; tone?: 'grad' | 'soft' }): React.JSX.Element {
  const v = Math.max(0, Math.min(1, value))
  return (
    <div className={cn('relative h-1.5 overflow-hidden rounded-full bg-white/[0.07]', className)}>
      <motion.div
        className={cn('absolute inset-0 origin-left rounded-full', tone === 'grad' ? 'bg-grad' : 'bg-white/35')}
        initial={false}
        animate={{ scaleX: Math.max(0.015, v) }}
        transition={{ duration: 0.6, ease }}
      />
    </div>
  )
}

function serviceLabel(s: NodeService): string {
  const what = s.kind === 'comfy' ? 'ComfyUI' : 'llama.cpp'
  if (s.state === 'installing') return `${what} · installing${s.progress !== undefined ? ` ${Math.round(s.progress * 100)}%` : ''}`
  return `${what} · ${s.state}`
}

export function GpuRow({ gpu, services = [], dim }: { gpu: GpuLive; services?: NodeService[]; dim?: boolean }): React.JSX.Element {
  const used = gpu.memTotal ? gpu.memUsed / gpu.memTotal : 0
  const mine = services.filter((s) => s.gpu === gpu.index && s.state !== 'stopped')
  return (
    <div className={cn('rounded-xl border border-line bg-white/[0.02] px-3 py-2.5', dim && 'opacity-55')}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] tracking-[0.16em] text-fg-3">GPU {gpu.index}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{shortGpu(gpu.name)}</span>
        {gpu.shared === false && <Badge tone="outline">Not shared</Badge>}
        {gpu.temp !== undefined && (
          <span className="flex items-center gap-0.5 text-[11px] text-fg-3 tabular-nums">
            <Thermometer className="size-3" />
            {gpu.temp}°
          </span>
        )}
      </div>
      <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5">
        <Meter value={used} />
        <span className="text-right text-[11px] text-fg-3 tabular-nums">
          {formatBytes(gpu.memUsed)} / {formatBytes(gpu.memTotal)}
        </span>
        <Meter value={(gpu.util ?? 0) / 100} tone="soft" className="h-1" />
        <span className="text-right text-[11px] text-fg-3 tabular-nums">{gpu.util ?? 0}% load</span>
      </div>
      {mine.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {mine.map((s) => (
            <Badge key={s.kind} tone={s.state === 'running' ? 'success' : s.state === 'crashed' || s.state === 'error' ? 'danger' : 'accent'}>
              {serviceLabel(s)}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

/** A PC with its hardware. `state` drives the status dot; `actions` sit in the header. */
export function PcCard({
  name,
  hardware,
  kind,
  state,
  subtitle,
  services,
  actions,
  children
}: {
  name: string
  hardware?: PcHardware
  kind: 'this' | 'node'
  state?: 'online' | 'offline' | 'busy' | 'warn'
  subtitle?: ReactNode
  services?: NodeService[]
  actions?: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  const hw = hardware
  return (
    <motion.div variants={rise} layout="position" className="glass hairline relative overflow-hidden rounded-2xl p-4 max-md:p-3.5">
      {kind === 'this' && <div className="pointer-events-none absolute -top-20 -right-16 size-48 rounded-full bg-grad opacity-[0.13] blur-3xl" />}
      <div className="relative flex items-start gap-3">
        <div className={cn('grid size-10 shrink-0 place-items-center rounded-xl border border-line', kind === 'this' || state === 'online' ? 'bg-grad text-white' : 'bg-white/[0.04] text-fg-2')}>
          {kind === 'this' ? <Monitor className="size-4.5" /> : <Server className="size-4.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {state && <StatusDot state={state} />}
            <span className="truncate text-[14px] font-semibold tracking-tight">{name}</span>
          </div>
          <div className="mt-0.5 truncate text-[11.5px] text-fg-3">{subtitle ?? (hw ? hw.os : '—')}</div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5 max-md:flex-col max-md:items-end">{actions}</div>}
      </div>
      {hw && (
        <>
          <div className="relative mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-fg-3">
            <span className="flex min-w-0 items-center gap-1.5">
              <Cpu className="size-3.5 shrink-0" />
              <span className="truncate">
                {hw.cpu.model} · {hw.cpu.cores} threads
              </span>
            </span>
            <span className="flex items-center gap-1.5 tabular-nums">
              <MemoryStick className="size-3.5" />
              {formatBytes(hw.ram.total - hw.ram.free)} / {formatBytes(hw.ram.total)} RAM
            </span>
          </div>
          <div className="relative mt-3 grid gap-2 sm:grid-cols-2">
            {hw.gpus.map((g) => (
              <GpuRow key={g.index} gpu={g} services={services} dim={g.shared === false} />
            ))}
            {!hw.gpus.length && <div className="rounded-xl border border-dashed border-line px-3 py-3 text-[12px] text-fg-3 sm:col-span-2">No NVIDIA GPU found (CPU only).</div>}
          </div>
          <div className="relative mt-3 flex flex-wrap gap-1.5">
            <Badge tone="outline">Stitch {hw.version}</Badge>
            <Badge tone={hw.comfy ? 'default' : 'warning'}>{hw.comfy ? 'ComfyUI found' : 'No ComfyUI'}</Badge>
            {hw.llama && <Badge tone="default">llama.cpp {hw.llama.tag}</Badge>}
          </div>
        </>
      )}
      {children}
    </motion.div>
  )
}
