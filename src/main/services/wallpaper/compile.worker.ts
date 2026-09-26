// Worker thread: decoding a scene's textures takes a few seconds for big 4K
// scenes, so it never runs on the main process's event loop.
import { parentPort, workerData } from 'node:worker_threads'
import { compileScene, type CompileInput } from './scene'

try {
  parentPort?.postMessage({ data: compileScene(workerData as CompileInput) })
} catch (err) {
  parentPort?.postMessage({ error: err instanceof Error ? err.message : String(err) })
}
