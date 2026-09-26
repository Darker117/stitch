// Dev only: fill a test PC profile with believable content (characters, stories, chats, media) so
// phone layouts can be checked against real data. Run `await window.__stitchSeed()` in the web build.
import { nanoid } from 'nanoid'
import type { Adventure, Asset, AssetKind, Character, Chat, Project, Scenario, Timeline } from '@shared/types'
import { invoke } from '@/lib/api'
import { db } from '@/stores/db'
import { action } from '@/features/stories/engine/adventure'
import { defaultSettings, emptyPlot, newCard, newScenario } from '@/features/stories/engine/defaults'

const PALETTES = [
  ['#1b1633', '#6d65b8', '#f08a6c'],
  ['#0e1a26', '#2f7a8f', '#e8c07d'],
  ['#1f0f19', '#aa3b51', '#f2c36b'],
  ['#0d1417', '#4f8a6f', '#c9e4a8'],
  ['#15111f', '#8f78b2', '#ad849d'],
  ['#1a1210', '#cc7b62', '#f5dcc0']
]

function art(w: number, h: number, seed: number, subject: 'portrait' | 'scene'): Promise<Blob> {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const [a, b, d] = PALETTES[seed % PALETTES.length]
  const bg = g.createLinearGradient(0, 0, w * 0.3, h)
  bg.addColorStop(0, a)
  bg.addColorStop(0.6, b)
  bg.addColorStop(1, d)
  g.fillStyle = bg
  g.fillRect(0, 0, w, h)
  let r = seed * 9301 + 49297
  const rnd = (): number => ((r = (r * 9301 + 49297) % 233280) / 233280)
  for (let i = 0; i < 40; i++) {
    g.globalAlpha = 0.08 + rnd() * 0.12
    g.fillStyle = rnd() > 0.5 ? d : '#ffffff'
    g.beginPath()
    g.arc(rnd() * w, rnd() * h, 10 + rnd() * w * 0.25, 0, Math.PI * 2)
    g.fill()
  }
  g.globalAlpha = 1
  if (subject === 'portrait') {
    g.fillStyle = 'rgba(8,6,12,0.82)'
    g.beginPath()
    g.ellipse(w / 2, h * 0.42, w * 0.17, h * 0.2, 0, 0, Math.PI * 2)
    g.fill()
    g.beginPath()
    g.ellipse(w / 2, h * 1.02, w * 0.38, h * 0.4, 0, 0, Math.PI * 2)
    g.fill()
  } else {
    g.fillStyle = 'rgba(8,6,12,0.75)'
    g.beginPath()
    g.moveTo(0, h)
    for (let x = 0; x <= w; x += w / 12) g.lineTo(x, h * (0.62 + rnd() * 0.18))
    g.lineTo(w, h)
    g.fill()
  }
  return new Promise((res) => c.toBlob((bl) => res(bl!), 'image/png'))
}

async function save(blob: Blob, kind: AssetKind, ext: string, meta: Partial<Asset>): Promise<Asset> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return invoke('assets:saveBytes', bytes, kind, ext, { source: 'generated', ...meta })
}

function tone(seconds: number, freq: number): Blob {
  const rate = 22050
  const n = Math.floor(seconds * rate)
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const w = (o: number, s: string): void => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)))
  w(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  w(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 2000, (n - i) / 4000)
    v.setInt16(44 + i * 2, Math.sin((i / rate) * freq * Math.PI * 2) * 9000 * env * (0.6 + 0.4 * Math.sin(i / 3000)), true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

async function clip(seed: number): Promise<Blob | null> {
  if (typeof MediaRecorder === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = 480
  c.height = 270
  const g = c.getContext('2d')!
  const stream = c.captureStream(24)
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm' })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => chunks.push(e.data)
  const [a, b, d] = PALETTES[seed % PALETTES.length]
  let t = 0
  const timer = setInterval(() => {
    t++
    const bg = g.createLinearGradient(0, 0, 480, 270)
    bg.addColorStop(0, a)
    bg.addColorStop(0.5 + 0.3 * Math.sin(t / 10), b)
    bg.addColorStop(1, d)
    g.fillStyle = bg
    g.fillRect(0, 0, 480, 270)
    g.fillStyle = 'rgba(255,255,255,0.8)'
    g.beginPath()
    g.arc(240 + Math.sin(t / 8) * 150, 135 + Math.cos(t / 11) * 60, 24, 0, Math.PI * 2)
    g.fill()
  }, 1000 / 24)
  rec.start()
  await new Promise((r) => setTimeout(r, 2500))
  rec.stop()
  await new Promise((r) => (rec.onstop = r))
  clearInterval(timer)
  return new Blob(chunks, { type: 'video/webm' })
}

export async function seed(): Promise<string> {
  const now = Date.now()
  const project: Project = { id: nanoid(10), name: 'Ashfall Chronicles', description: 'A volcanic archipelago where sky-ships trade in ember glass.', style: 'painterly, warm rim light, cinematic haze', characterIds: [], createdAt: now, updatedAt: now }

  const people = [
    { name: 'Maren Vale', appearance: 'late 20s, copper braid, burn-scarred left hand, navigator coat', description: 'A sky-ship navigator who reads storms like maps.' },
    { name: 'Teodor Kest', appearance: 'tall, grey-streaked beard, glass monocle, ash-stained apron', description: 'Ember-glass smith with a debt to the wrong people.' },
    { name: 'Sable', appearance: 'young, short black hair, silver eyes, hooded courier cloak', description: 'A courier who never says who hired her.' },
    { name: 'The Warden', appearance: 'towering figure in obsidian armour, cracked visor glowing orange', description: 'Keeper of the caldera gate.' }
  ]
  const characters: Character[] = []
  for (const [i, p] of people.entries()) {
    const ref = await save(await art(768, 1024, i, 'portrait'), 'image', 'png', { name: `${p.name} reference`, prompt: p.appearance, projectId: project.id })
    const front = await save(await art(768, 1024, i + 1, 'portrait'), 'image', 'png', { name: `${p.name} front`, projectId: project.id })
    const c: Character = {
      id: nanoid(10),
      name: p.name,
      description: p.description,
      appearance: p.appearance,
      createdAt: now - i * 60_000,
      updatedAt: now - i * 60_000,
      projectId: project.id,
      referenceAssetId: ref.id,
      sheet: { front: front.id, 'three-quarter-left': ref.id },
      sheetDetail: 'compact',
      locked: i < 2,
      tags: ['ashfall']
    }
    characters.push(c)
    await db.put('characters', c)
  }
  project.characterIds = characters.map((c) => c.id)
  const cover = await save(await art(1344, 768, 2, 'scene'), 'image', 'png', { name: 'Caldera harbour at dusk', prompt: 'volcanic harbour, sky-ships, dusk', projectId: project.id })
  project.coverAssetId = cover.id
  await db.put('projects', project)

  for (let i = 0; i < 8; i++) await save(await art(i % 2 ? 1024 : 768, i % 2 ? 768 : 1024, i + 3, 'scene'), 'image', 'png', { name: `Scene study ${i + 1}`, prompt: 'ember-glass market, lanterns, rain of ash', projectId: project.id, favorite: i === 1 })
  await save(tone(4, 220), 'audio', 'wav', { name: 'Caldera ambience', source: 'generated' })
  await save(tone(3, 330), 'audio', 'wav', { name: 'Maren — line 1', source: 'voice', characterIds: [characters[0].id] })
  const vid = await clip(1)
  if (vid) await save(vid, 'video', 'webm', { name: 'Harbour flyover', projectId: project.id })

  const scenarios: Scenario[] = []
  const worlds = [
    { title: 'The Caldera Gate', description: 'Smuggle a crate of living ember-glass past the Warden before the eruption seals the harbour.', tags: ['fantasy', 'heist'] },
    { title: 'Neon Monsoon', description: 'A detective in a drowned megacity hunts the AI that forged her memories.', tags: ['cyberpunk', 'mystery'] },
    { title: 'Last Light at Harrow Farm', description: 'Survive the first night after the dead start walking.', tags: ['zombie', 'survival'] }
  ]
  for (const [i, w] of worlds.entries()) {
    const coverImg = await save(await art(1024, 1344, i + 7, 'scene'), 'image', 'png', { name: `${w.title} cover` })
    const s = newScenario({
      title: w.title,
      description: w.description,
      tags: w.tags,
      coverAssetId: coverImg.id,
      projectId: i === 0 ? project.id : undefined,
      opening: 'The ash falls like slow snow over the harbour. Somewhere below the docks, the crate in your hands begins to hum.',
      plot: emptyPlot({ plotEssentials: 'The eruption comes at dawn. The Warden cannot be bribed.' }),
      cards: characters.slice(0, 3).map((c) => newCard({ type: 'character', name: c.name, entry: c.description, triggers: c.name, characterId: c.id }))
    })
    scenarios.push(s)
    await db.put('scenarios', s)
  }

  const adv: Adventure = {
    id: nanoid(10),
    scenarioId: scenarios[0].id,
    title: scenarios[0].title,
    description: scenarios[0].description,
    tags: scenarios[0].tags,
    coverAssetId: scenarios[0].coverAssetId,
    projectId: project.id,
    createdAt: now - 3_600_000,
    updatedAt: now - 60_000,
    lastPlayedAt: now - 60_000,
    plot: scenarios[0].plot,
    cards: scenarios[0].cards,
    actions: [
      action('start', 'The ash falls like slow snow over the harbour. Somewhere below the docks, the crate in your hands begins to hum, a low note you feel in your teeth more than hear.'),
      action('do', 'You tuck the crate under your coat and head for the lantern market.'),
      action('story', 'The market is a maze of awnings and smoke. Teodor Kest waves you over from behind a table of cooling glass, his monocle flashing orange. "You brought it," he says, too loudly. Two figures in grey turn their heads.'),
      action('say', '"Not here," you whisper. "Is there a back way to the gate?"'),
      action('story', 'Teodor wipes his hands on his apron and nods toward a narrow stair cut into the rock. "Sable knows it. She owes me." Above you, the caldera rumbles — closer now, and impatient.')
    ],
    redo: [],
    memories: [],
    player: { name: 'Rook', choices: {} },
    settings: defaultSettings()
  }
  await db.put('adventures', adv)

  const chat: Chat = {
    id: nanoid(10),
    title: 'Sky-ship designs',
    createdAt: now - 7_200_000,
    updatedAt: now - 120_000,
    askBeforeGenerating: true,
    messages: [
      { id: nanoid(8), role: 'user', content: 'Give me three sky-ship designs for the Ashfall setting.', createdAt: now - 7_200_000 },
      {
        id: nanoid(8),
        role: 'assistant',
        content:
          'Here are three designs that fit the volcanic trade world:\n\n1. **The Cinder Moth** — a light courier with fabric wings stiffened by ember-glass ribs. Fast, fragile, loved by smugglers.\n2. **Harbour Ox** — a broad cargo barge lifted by heated-air bladders; slow but it can carry a whole market.\n3. **Warden-class cutter** — black-hulled patrol ship with an obsidian ram and a glowing orange keel.\n\nWant me to render any of them?',
        createdAt: now - 7_100_000
      }
    ]
  }
  await db.put('chats', chat)
  await db.put('chats', { ...chat, id: nanoid(10), title: 'Names for the harbour city', updatedAt: now - 86_400_000, messages: chat.messages.slice(0, 1) })

  const timeline: Timeline = {
    id: nanoid(10),
    name: 'Ashfall teaser',
    projectId: project.id,
    width: 1920,
    height: 1080,
    fps: 30,
    tracks: [
      { id: 'v1', kind: 'video', name: 'Video 1', muted: false, locked: false, hidden: false },
      { id: 'a1', kind: 'audio', name: 'Audio 1', muted: false, locked: false, hidden: false }
    ],
    clips: [],
    createdAt: now,
    updatedAt: now
  }
  await db.put('timelines', timeline)
  return `seeded ${characters.length} characters, ${scenarios.length} scenarios, 1 adventure, 2 chats`
}
