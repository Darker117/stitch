import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The phone app reuses the desktop renderer (every page, component and style) straight from the
// Stitch repo it lives in (`mobile/` next to `src/`), so features added on desktop show up here too.
const desktop = resolve(process.env.STITCH_DESKTOP ?? resolve(__dirname, '..'))
if (!existsSync(resolve(desktop, 'src/renderer/src/App.tsx'))) {
  throw new Error(`Stitch desktop sources not found at ${desktop} — set STITCH_DESKTOP to the Stitch repo folder.`)
}

// The phone app ships with each Stitch release and shares its version.
const version = (JSON.parse(readFileSync(resolve(desktop, 'package.json'), 'utf8')) as { version: string }).version

// Packages imported from both trees must resolve to one copy (this project's node_modules).
const shared = [
  'react',
  'react-dom',
  'react-router',
  'motion',
  'radix-ui',
  'lucide-react',
  'zustand',
  'clsx',
  'tailwind-merge',
  'nanoid',
  'react-markdown',
  'remark-gfm',
  '@codemirror/autocomplete',
  '@codemirror/commands',
  '@codemirror/lang-javascript',
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/highlight'
]

export default defineConfig({
  root: __dirname,
  base: './',
  resolve: {
    alias: {
      '@mobile': resolve(__dirname, 'src'),
      '@shared': resolve(desktop, 'src/shared'),
      '@': resolve(desktop, 'src/renderer/src')
    },
    dedupe: shared
  },
  plugins: [react(), tailwindcss()],
  define: { __STITCH_VERSION__: JSON.stringify(version) },
  server: {
    port: 5174,
    host: true,
    fs: { allow: [__dirname, desktop] },
    // Gradle output (the APK build, bundled Python) is not part of the web app.
    watch: { ignored: ['**/android/**'] }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    sourcemap: false
  },
  worker: { format: 'es' }
})
