// Run the Android Gradle build (gradlew) from npm scripts on any OS.
//   node scripts/gradle.mjs assembleDebug
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const android = join(dirname(fileURLToPath(import.meta.url)), '../android')
if (!existsSync(join(android, 'local.properties')) && !process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) {
  console.error('No Android SDK configured: set ANDROID_HOME or write android/local.properties (sdk.dir=…).')
  process.exit(1)
}
const sdk = existsSync(join(android, 'local.properties')) ? /sdk\.dir=(.*)/.exec(readFileSync(join(android, 'local.properties'), 'utf8'))?.[1]?.trim() : undefined
// Absolute path: Windows may not search the current folder for executables (NoDefaultCurrentDirectoryInExePath).
const gradlew = join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
const r = spawnSync(process.platform === 'win32' ? `"${gradlew}"` : gradlew, [...process.argv.slice(2), '--console=plain'], {
  cwd: android,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, ...(sdk ? { ANDROID_HOME: sdk } : {}) }
})
if (r.status === 0 && process.argv.includes('assembleDebug')) console.log(`\nAPK: ${join(android, 'app/build/outputs/apk/debug/app-debug.apk')}`)
process.exit(r.status ?? 1)
