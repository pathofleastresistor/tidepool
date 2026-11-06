#!/usr/bin/env node
// Builds native/speech-helper into resources/bin/speech-helper: a universal (arm64 + x86_64)
// binary with its Info.plist embedded. Voice input is macOS-only and optional, so anything
// missing here (another OS, no Swift toolchain) skips the build instead of failing it.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'native/speech-helper/main.swift')
const plist = join(root, 'native/speech-helper/Info.plist')
const out = join(root, 'resources/bin/speech-helper')
const MIN_MACOS = '13.0'

const log = (msg) => console.log(`[speech-helper] ${msg}`)

if (process.platform !== 'darwin') {
  log('skipped: voice input needs macOS')
  process.exit(0)
}

const newest = Math.max(statSync(src).mtimeMs, statSync(plist).mtimeMs)
if (existsSync(out) && statSync(out).mtimeMs >= newest && !process.argv.includes('--force')) {
  process.exit(0)
}

try {
  execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' })
} catch {
  log('skipped: no Swift compiler. Run `xcode-select --install` to enable voice input.')
  process.exit(0)
}

mkdirSync(dirname(out), { recursive: true })
const slices = []
for (const arch of ['arm64', 'x86_64']) {
  const slice = `${out}-${arch}`
  try {
    execFileSync(
      'xcrun',
      [
        'swiftc', src, '-O', '-swift-version', '5',
        '-target', `${arch}-apple-macos${MIN_MACOS}`,
        '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist,
        '-o', slice
      ],
      { stdio: 'inherit' }
    )
    slices.push(slice)
  } catch {
    log(`couldn't build the ${arch} slice`)
  }
}
if (slices.length === 0) {
  log('failed; voice input will be unavailable')
  process.exit(0)
}

execFileSync('lipo', ['-create', ...slices, '-output', out])
for (const slice of slices) rmSync(slice)
// Apple Silicon won't run unsigned code; an ad-hoc signature is enough for local builds.
execFileSync('codesign', ['--force', '--sign', '-', out])
log(`built ${out.replace(root + '/', '')} (${slices.length === 2 ? 'universal' : 'single arch'})`)
