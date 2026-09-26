// Stages the native on-device runtimes for the Android app: llama.cpp (GGUF text models) and stable-diffusion.cpp
// (images from .safetensors / .ckpt / .gguf checkpoints), which Gradle builds with the NDK through externalNativeBuild
// (android/app/src/main/cpp/CMakeLists.txt). Everything lands in android/.native (gitignored):
//   src/llama.cpp                 llama.cpp at LLAMA (ggml + llama + common; docs/models/tests/tools dropped). Its
//                                 ggml-vulkan CMake is patched to take a prebuilt vulkan-shaders-gen (below).
//   src/stable-diffusion.cpp      stable-diffusion.cpp at SDCPP, built against llama.cpp's ggml (one shared ggml for
//                                 both runtimes); its 30 MB of non-CLIP tokenizer vocabularies are dropped.
//   src/kleidiai                  Arm KleidiAI (ggml's optional ARM micro-kernels; ggml would fetch it at configure time)
//   src/Vulkan-Headers, src/SPIRV-Headers     headers for ggml's Vulkan backend (the NDK's are too old)
//   host/                         build-machine tools for the Vulkan shaders: Khronos' glslang release, a glslc shim
//                                 (scripts/native/glslc-shim.cpp) and ggml's vulkan-shaders-gen, compiled with the
//                                 machine's C++ compiler (MSVC via vswhere on Windows, c++ elsewhere)
//   cache/                        downloads
//   build.json                    what was staged (Gradle reads it for the CMake arguments)
// The Vulkan backend needs a host C++ compiler; without one (or with STITCH_NATIVE_VULKAN=0) the runtimes are built
// CPU-only. `npm run apk` / `apk:release` run this before Gradle; it's incremental (`--force` redoes everything).
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ANDROID = join(MOBILE, 'android')
const OUT = join(ANDROID, '.native')
const SRC = join(OUT, 'src')
const HOST = join(OUT, 'host')
const CACHE = join(OUT, 'cache')
const SHIM = join(MOBILE, 'scripts', 'native', 'glslc-shim.cpp')

// ─── Pins ─────────────────────────────────────────────────────────────────────
// llama.cpp release v0.5.0 (2026-09-23) and stable-diffusion.cpp master-920-2f88688 (2026-09-25). stable-diffusion.cpp
// is compiled against llama.cpp's ggml in its upstream-ggml mode (SD_USE_UPSTREAM_GGML): bump the two together and
// check that stable-diffusion.cpp still builds. KleidiAI must match what llama.cpp's ggml-cpu CMake asks for.
const LLAMA = { tag: 'v0.5.0', commit: '7fe450e19305b828c199d602c23a8337aaa1f03b' }
const SDCPP = { tag: 'master-920-2f88688', commit: '2f886889e6e8b78738d6b87f7191f6018557c551' }
const KLEIDIAI = { version: 'v1.24.0', md5: '2f02ebe29573d45813e671eb304f2a00' }
const VULKAN_SDK = { tag: 'vulkan-sdk-1.4.357.0', headers: 'e87dce08116151f6b6d7de6b6faf41498e87e6cf848ff16fa3bd5402190ad4a3', spirv: '4d703067a7e06331ccb37bdfed3f9b7879cc61969a2689ae95c95db34a47ff07' }
const GLSLANG = {
  version: '16.6.0',
  assets: {
    win32: { os: 'windows-x86_64', sha256: '82bf434e69b9bb4829de7e2b4bc2c5e7a7861e53d66cf75e5cc70f5f694a8d9b' },
    linux: { os: 'linux-x86_64', sha256: 'a3fc4f083b1793eb53e55fa3577ac9649ffbe0340715e30d116290fb5382393f' },
    darwin: { os: 'macos-universal', sha256: '1086bc6c7ce8ff188e4e1d1a69078e9e38156a4c2c3f13e4f91b9289a1d90453' }
  }
}
/** Bump when the staged layout, trimming or patches change, so existing trees get redone. */
const FORMAT = 1

const log = (msg) => console.log(`[native] ${msg}`)
const force = process.argv.includes('--force')
const win = process.platform === 'win32'
const exe = win ? '.exe' : ''
const wantVulkan = process.env.STITCH_NATIVE_VULKAN !== '0'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

const hash = (algo, file) => createHash(algo).update(readFileSync(file)).digest('hex')
const rm = (p) => rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
const slash = (p) => p.replace(/\\/g, '/')

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, ...opts })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')}… exited with ${r.status}`)
  return r
}

async function download(url, dest, check) {
  const ok = () => existsSync(dest) && (!check || hash(check.algo, dest) === check.hex)
  if (ok()) return dest
  log(`downloading ${url}`)
  mkdirSync(dirname(dest), { recursive: true })
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'stitch-build' } })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer()))
      if (check && hash(check.algo, dest + '.part') !== check.hex) throw new Error(`${check.algo} mismatch for ${url}`)
      renameSync(dest + '.part', dest)
      return dest
    } catch (err) {
      lastErr = err
      log(`  attempt ${attempt} failed: ${err.message}`)
    }
  }
  throw lastErr
}

/** bsdtar (Windows' own tar.exe; GNU/BSD tar elsewhere) extracts both .tar.gz and .zip. */
function untar(archive, dest, args = []) {
  mkdirSync(dest, { recursive: true })
  const tar = win ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  run(tar, ['-xf', archive, '-C', dest, ...args])
}

/** Extract `archive` (one top-level folder `top`) to `dest`, keeping only `keep` (paths relative to `top`). */
function extractTree(archive, top, dest, keep) {
  const work = dest + '.work'
  rm(work)
  untar(archive, work, keep.map((k) => `${top}/${k}`))
  rm(dest)
  renameSync(join(work, top), dest)
  rm(work)
}

// ─── Android SDK / NDK ────────────────────────────────────────────────────────

function sdkDir() {
  const props = join(ANDROID, 'local.properties')
  if (existsSync(props)) {
    const m = /^sdk\.dir=(.*)$/m.exec(readFileSync(props, 'utf8'))
    if (m) return m[1].trim().replace(/\\\\/g, '\\').replace(/\\:/g, ':')
  }
  return process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
}

const byVersion = (a, b) => b.localeCompare(a, undefined, { numeric: true })

/** Newest NDK (≥ 27) and CMake (≥ 3.22) under the SDK; Gradle is told to use exactly these. */
function sdkTools() {
  const sdk = sdkDir()
  if (!sdk || !existsSync(sdk)) throw new Error('No Android SDK configured: set ANDROID_HOME or write android/local.properties (sdk.dir=…).')
  const ndks = existsSync(join(sdk, 'ndk')) ? readdirSync(join(sdk, 'ndk')).filter((v) => Number(v.split('.')[0]) >= 27).sort(byVersion) : []
  const override = process.env.ANDROID_NDK_HOME ?? process.env.ANDROID_NDK_ROOT
  const ndkVersion = override ? readFileSync(join(override, 'source.properties'), 'utf8').match(/Pkg\.Revision\s*=\s*(\S+)/)?.[1] : ndks[0]
  if (!ndkVersion) throw new Error('No Android NDK 27+ found: install one with the SDK manager (sdkmanager "ndk;29.0.14206865").')
  const cmakes = existsSync(join(sdk, 'cmake')) ? readdirSync(join(sdk, 'cmake')).filter((v) => /^3\.(2[2-9]|3\d)\./.test(v)).sort(byVersion) : []
  if (!cmakes[0]) throw new Error('No CMake 3.22+ in the Android SDK: install one with the SDK manager (sdkmanager "cmake;3.31.6").')
  return { ndkVersion, cmakeVersion: cmakes[0] }
}

// ─── Host C++ compiler (for the Vulkan shader tools) ──────────────────────────

/** Returns a function compiling one C++17 file to an executable, or null when no compiler is available. */
function hostCompiler() {
  if (win) {
    const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    if (!existsSync(vswhere)) return null
    const r = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' })
    const vs = r.stdout?.trim().split(/\r?\n/)[0]
    const vcvars = vs && join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
    if (!vcvars || !existsSync(vcvars)) return null
    return {
      name: `MSVC (${vs})`,
      compile(src, out, defines = []) {
        const bat = join(HOST, 'compile.bat')
        const defs = defines.map((d) => `/D${d}`).join(' ')
        writeFileSync(bat, `@echo off\r\nset "PATH=${dirname(vswhere)};%PATH%"\r\ncall "${vcvars}" >nul\r\ncd /d "${HOST}"\r\ncl /nologo /std:c++17 /O2 /EHsc /MT ${defs} "${src}" /Fe:"${out}" /Fo:"${out}.obj" /link /nologo\r\n`)
        run('cmd.exe', ['/d', '/c', bat], { stdio: ['ignore', 'ignore', 'inherit'] })
        rm(`${out}.obj`)
        rm(bat)
      }
    }
  }
  for (const cxx of [process.env.CXX, 'c++', 'clang++', 'g++'].filter(Boolean)) {
    if (spawnSync(cxx, ['--version'], { stdio: 'ignore' }).status === 0) {
      return {
        name: cxx,
        compile(src, out, defines = []) {
          run(cxx, ['-std=c++17', '-O2', '-pthread', ...defines.map((d) => `-D${d}`), src, '-o', out])
        }
      }
    }
  }
  return null
}

// ─── Stage ────────────────────────────────────────────────────────────────────

const tools = sdkTools()
const stamp = readJson(join(OUT, 'build.json'))
const want = { format: FORMAT, llama: LLAMA.commit, sdcpp: SDCPP.commit, kleidiai: KLEIDIAI.version, vulkanSdk: VULKAN_SDK.tag, glslang: GLSLANG.version }
const same = (k) => stamp?.[k] === want[k]
if (force) rm(SRC)

// 1. llama.cpp (ggml, llama, common + vendored headers).
const llamaDir = join(SRC, 'llama.cpp')
if (!same('format') || !same('llama') || !existsSync(join(llamaDir, 'CMakeLists.txt'))) {
  const tgz = await download(`https://codeload.github.com/ggml-org/llama.cpp/tar.gz/${LLAMA.commit}`, join(CACHE, `llama.cpp-${LLAMA.commit}.tar.gz`))
  log(`extracting llama.cpp ${LLAMA.tag}`)
  extractTree(tgz, `llama.cpp-${LLAMA.commit}`, llamaDir, ['CMakeLists.txt', 'LICENSE', 'cmake', 'common', 'ggml', 'include', 'licenses', 'src', 'vendor'])
  patchVulkanCmake(join(llamaDir, 'ggml', 'src', 'ggml-vulkan', 'CMakeLists.txt'))
}

// 2. stable-diffusion.cpp (library sources only).
const sdDir = join(SRC, 'stable-diffusion.cpp')
if (!same('format') || !same('sdcpp') || !existsSync(join(sdDir, 'include', 'stable-diffusion.h'))) {
  const tgz = await download(`https://codeload.github.com/leejet/stable-diffusion.cpp/tar.gz/${SDCPP.commit}`, join(CACHE, `stable-diffusion.cpp-${SDCPP.commit}.tar.gz`))
  log(`extracting stable-diffusion.cpp ${SDCPP.tag}`)
  extractTree(tgz, `stable-diffusion.cpp-${SDCPP.commit}`, sdDir, ['LICENSE', 'include', 'src', 'thirdparty'])
  // Only CLIP's BPE merges are bundled (android/app/src/main/cpp/sd_vocab.cpp replaces vocab.cpp).
  const vocab = join(sdDir, 'src', 'tokenizers', 'vocab')
  for (const f of readdirSync(vocab)) if (f.endsWith('.hpp') && f !== 'clip_merges.hpp') rm(join(vocab, f))
  rm(join(vocab, 'vocab.cpp'))
}

// 3. KleidiAI (what ggml-cpu's CMake would otherwise FetchContent at configure time).
const kaiDir = join(SRC, 'kleidiai')
if (!same('kleidiai') || !existsSync(join(kaiDir, 'CMakeLists.txt'))) {
  const tgz = await download(
    `https://github.com/ARM-software/kleidiai/releases/download/${KLEIDIAI.version}/kleidiai-${KLEIDIAI.version}-src.tar.gz`,
    join(CACHE, `kleidiai-${KLEIDIAI.version}-src.tar.gz`),
    { algo: 'md5', hex: KLEIDIAI.md5 }
  )
  const work = kaiDir + '.work'
  rm(work)
  untar(tgz, work)
  const inner = readdirSync(work).length === 1 && existsSync(join(work, readdirSync(work)[0], 'CMakeLists.txt')) ? join(work, readdirSync(work)[0]) : work
  rm(kaiDir)
  renameSync(inner, kaiDir)
  rm(work)
}

// 4. Vulkan backend: headers + host shader tools.
let vulkan = null
if (wantVulkan) {
  const cxx = hostCompiler()
  const glslangAsset = GLSLANG.assets[process.platform]
  if (!cxx || !glslangAsset || (process.arch !== 'x64' && process.platform !== 'darwin')) {
    log(`WARNING: ${cxx ? `no glslang ${GLSLANG.version} release for ${process.platform}-${process.arch}` : 'no C++ compiler for the build machine (install Visual Studio Build Tools with C++ on Windows)'}; building the phone runtimes without the Vulkan GPU backend.`)
  } else {
    vulkan = await stageVulkan(cxx, glslangAsset)
  }
}

const build = {
  ...want,
  llamaTag: LLAMA.tag,
  sdcppTag: SDCPP.tag,
  ndkVersion: tools.ndkVersion,
  cmakeVersion: tools.cmakeVersion,
  llamaDir: slash(llamaDir),
  sdcppDir: slash(sdDir),
  kleidiaiDir: slash(kaiDir),
  vulkan: vulkan ?? false
}
writeFileSync(join(OUT, 'build.json'), JSON.stringify(build, null, 2) + '\n')
log(`ready: llama.cpp ${LLAMA.tag}, stable-diffusion.cpp ${SDCPP.tag}, NDK ${tools.ndkVersion}, CMake ${tools.cmakeVersion}, Vulkan ${vulkan ? 'on' : 'off'}`)

// ─── Vulkan ───────────────────────────────────────────────────────────────────

/**
 * ggml builds vulkan-shaders-gen for the build machine as an ExternalProject, which can't find MSVC from Gradle's
 * environment. Let it take a prebuilt executable instead (GGML_VULKAN_SHADERS_GEN_EXECUTABLE).
 */
function patchVulkanCmake(file) {
  let s = readFileSync(file, 'utf8')
  if (s.includes('GGML_VULKAN_SHADERS_GEN_EXECUTABLE')) return
  const start = s.indexOf('    # Set up toolchain for host compilation whether cross-compiling or not')
  const endMarker = '        INSTALL_COMMAND ${CMAKE_COMMAND} -E env --unset=DESTDIR\n                        ${CMAKE_COMMAND} --install . --config $<CONFIG>\n    )\n'
  const end = s.indexOf(endMarker)
  const cmdLine = '    set (_ggml_vk_genshaders_cmd "${_ggml_vk_genshaders_dir}/vulkan-shaders-gen${_ggml_vk_host_suffix}")\n'
  if (start < 0 || end < 0 || !s.includes(cmdLine)) throw new Error(`ggml-vulkan's CMakeLists.txt changed; update patchVulkanCmake in ${slash(fileURLToPath(import.meta.url))}`)
  s =
    s.slice(0, start) +
    '    if (GGML_VULKAN_SHADERS_GEN_EXECUTABLE)\n        # Stitch: vulkan-shaders-gen prebuilt for the build machine (mobile/scripts/native.mjs)\n        add_custom_target(vulkan-shaders-gen)\n    else()\n' +
    s.slice(start, end + endMarker.length) +
    '    endif()\n' +
    s.slice(end + endMarker.length)
  s = s.replace(cmdLine, cmdLine + '    if (GGML_VULKAN_SHADERS_GEN_EXECUTABLE)\n        set (_ggml_vk_genshaders_cmd "${GGML_VULKAN_SHADERS_GEN_EXECUTABLE}")\n    endif()\n')
  writeFileSync(file, s)
}

async function stageVulkan(cxx, asset) {
  // Headers.
  const headers = join(SRC, 'Vulkan-Headers')
  const spirv = join(SRC, 'SPIRV-Headers')
  if (!same('vulkanSdk') || !existsSync(join(headers, 'include', 'vulkan', 'vulkan.hpp'))) {
    const tgz = await download(`https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/${VULKAN_SDK.tag}.tar.gz`, join(CACHE, `Vulkan-Headers-${VULKAN_SDK.tag}.tar.gz`), { algo: 'sha256', hex: VULKAN_SDK.headers })
    extractTree(tgz, `Vulkan-Headers-${VULKAN_SDK.tag}`, headers, ['LICENSE.md', 'include'])
  }
  if (!same('vulkanSdk') || !existsSync(join(spirv, 'include', 'spirv', 'unified1', 'spirv.hpp'))) {
    const tgz = await download(`https://github.com/KhronosGroup/SPIRV-Headers/archive/refs/tags/${VULKAN_SDK.tag}.tar.gz`, join(CACHE, `SPIRV-Headers-${VULKAN_SDK.tag}.tar.gz`), { algo: 'sha256', hex: VULKAN_SDK.spirv })
    extractTree(tgz, `SPIRV-Headers-${VULKAN_SDK.tag}`, spirv, ['LICENSE', 'include'])
    // ggml-vulkan asks for find_package(SPIRV-Headers CONFIG); a minimal package config pointing at the headers.
    mkdirSync(join(spirv, 'cmake'), { recursive: true })
    writeFileSync(
      join(spirv, 'cmake', 'SPIRV-HeadersConfig.cmake'),
      'if (NOT TARGET SPIRV-Headers::SPIRV-Headers)\n  add_library(SPIRV-Headers::SPIRV-Headers INTERFACE IMPORTED)\n  set_target_properties(SPIRV-Headers::SPIRV-Headers PROPERTIES INTERFACE_INCLUDE_DIRECTORIES "${CMAKE_CURRENT_LIST_DIR}/../include")\nendif()\nset(SPIRV-Headers_FOUND TRUE)\n'
    )
  }

  // glslang (Khronos release binary) + the glslc shim next to it.
  const glslang = join(HOST, `glslang${exe}`)
  const glslc = join(HOST, `glslc${exe}`)
  const shimHash = hash('sha256', SHIM).slice(0, 16)
  const hostStamp = readJson(join(HOST, 'host.json'))
  if (!same('glslang') || !existsSync(glslang)) {
    const zip = await download(
      `https://github.com/KhronosGroup/glslang/releases/download/${GLSLANG.version}/glslang-${GLSLANG.version}-${asset.os}-release.zip`,
      join(CACHE, `glslang-${GLSLANG.version}-${asset.os}-release.zip`),
      { algo: 'sha256', hex: asset.sha256 }
    )
    const work = join(OUT, 'glslang.work')
    rm(work)
    untar(zip, work)
    mkdirSync(HOST, { recursive: true })
    copyFileSync(join(work, 'bin', `glslang${exe}`), glslang)
    if (!win) chmodSync(glslang, 0o755)
    rm(work)
  }
  if (hostStamp?.shim !== shimHash || hostStamp?.compiler !== cxx.name || !existsSync(glslc)) {
    log(`building the glslc shim with ${cxx.name}`)
    cxx.compile(SHIM, glslc)
  }

  // ggml's shader-extension feature tests, run with our glslc exactly as its CMake does, decide the defines
  // vulkan-shaders-gen is compiled with (they must match what ggml-vulkan.cpp gets at configure time).
  const vkDir = join(llamaDir, 'ggml', 'src', 'ggml-vulkan')
  const cmake = readFileSync(join(vkDir, 'CMakeLists.txt'), 'utf8')
  const tests = [...cmake.matchAll(/test_shader_extension_support\(\s*"([^"]+)"\s*"[^"]*\/(feature-tests\/[^"]+)"\s*"([^"]+)"\s*\)/g)]
  if (!tests.length) throw new Error('No shader feature tests found in ggml-vulkan/CMakeLists.txt')
  const defines = []
  for (const [, ext, test, define] of tests) {
    const r = spawnSync(glslc, ['-o', '-', '-fshader-stage=compute', '--target-env=vulkan1.3', join(vkDir, 'vulkan-shaders', test)], { encoding: 'latin1' })
    if (!new RegExp(`extension not supported: ${ext}`).test(r.stderr ?? '')) defines.push(define)
  }
  const gen = join(HOST, `vulkan-shaders-gen${exe}`)
  const genKey = `${LLAMA.commit}:${defines.join(',')}:${cxx.name}`
  if (hostStamp?.gen !== genKey || !existsSync(gen)) {
    log(`building vulkan-shaders-gen with ${cxx.name} (${defines.length}/${tests.length} shader extensions)`)
    cxx.compile(join(vkDir, 'vulkan-shaders', 'vulkan-shaders-gen.cpp'), gen, defines)
  }
  writeFileSync(join(HOST, 'host.json'), JSON.stringify({ shim: shimHash, compiler: cxx.name, gen: genKey }, null, 2) + '\n')
  return {
    headers: slash(join(headers, 'include')),
    spirvHeaders: slash(join(spirv, 'include')),
    spirvConfig: slash(join(spirv, 'cmake')),
    glslc: slash(glslc),
    shadersGen: slash(gen)
  }
}
