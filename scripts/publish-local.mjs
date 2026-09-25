// Publish the current package.json version as a GitHub Release from this PC.
// Same result as .github/workflows/release.yml — use it when GitHub Actions
// can't run. Needs the GitHub CLI signed in (`gh auth login`) and the version
// tag already pushed (`npm run release` does that).
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const GH = process.env.GH_PATH ?? (existsSync('C:\\Program Files\\GitHub CLI\\gh.exe') ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh')
const out = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
const tryOut = (cmd, args) => {
  try {
    return out(cmd, args)
  } catch {
    return ''
  }
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${version}`

if (!tryOut('git', ['rev-parse', '--verify', `refs/tags/${tag}`])) throw new Error(`Tag ${tag} doesn't exist. Run "npm run release" first.`)
if (!tryOut('git', ['ls-remote', '--tags', 'origin', tag])) throw new Error(`Tag ${tag} isn't on GitHub yet. Push it: git push origin ${tag}`)
if (out('git', ['rev-parse', 'HEAD']) !== out('git', ['rev-parse', `${tag}^{commit}`])) throw new Error(`HEAD isn't at ${tag}. Check it out before publishing.`)

// Release notes from the commits since the previous tag.
const prev = tryOut('git', ['describe', '--tags', '--abbrev=0', `${tag}^`])
const log = tryOut('git', ['log', '--no-merges', '--pretty=- %s', prev ? `${prev}..${tag}` : tag])
const notes = log
  .split('\n')
  .filter((l) => l && !/^- (Release )?v?\d+\.\d+\.\d+$/.test(l))
  .join('\n') || '- Maintenance release'
const notesFile = join(tmpdir(), `stitch-notes-${version}.md`)
writeFileSync(notesFile, notes + '\n')

console.log(`\n▸ Drafting ${tag}`)
if (tryOut(GH, ['release', 'view', tag, '--json', 'tagName'])) run(GH, ['release', 'edit', tag, '--draft=true', '--title', `Stitch ${version}`, '--notes-file', notesFile])
else run(GH, ['release', 'create', tag, '--draft', '--verify-tag', '--title', `Stitch ${version}`, '--notes-file', notesFile])
rmSync(notesFile, { force: true })

console.log('\n▸ Building the installer and uploading it to the draft')
execSync('npm run dist:publish', { stdio: 'inherit', env: { ...process.env, GH_TOKEN: out(GH, ['auth', 'token']) } })

console.log(`\n▸ Publishing ${tag}`)
run(GH, ['release', 'edit', tag, '--draft=false', '--latest'])
console.log(`\n✓ Stitch ${version} is live — installed copies will offer it on their next check.`)
