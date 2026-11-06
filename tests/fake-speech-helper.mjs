#!/usr/bin/env node
// Stands in for native/speech-helper in the e2e test: the same JSON-lines protocol, with
// scripted "speech" instead of a microphone. The test picks the behaviour by writing to the
// file named in FAKE_SPEECH_CONTROL before each session:
//
//   speak:<sentence>   say the sentence word by word, then pause (the utterance ends)
//   endless            keep talking until told to stop or cancel
//   lose-final:<text>  say it, then end with an empty final (as Apple's recognizer can)
//   denied             fail as if microphone access were off

import { existsSync, readFileSync } from 'node:fs'

const control = process.env.FAKE_SPEECH_CONTROL
const mode = control && existsSync(control) ? readFileSync(control, 'utf8').trim() : 'speak:Hello there'
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n')

if (mode === 'denied') {
  out({ type: 'error', code: 'microphone-denied', message: 'Microphone access is off.' })
  process.exit(1)
}

const scripted = mode.match(/^(speak|lose-final):(.*)$/)
const words = scripted
  ? scripted[2].split(' ')
  : 'How long do I simmer the queso before adding the peppers'.split(' ')
const heard = []
let finished = false
const finish = () => {
  if (finished) return
  finished = true
  out({ type: 'final', text: mode.startsWith('lose-final:') ? '' : heard.join(' ') })
  process.exit(0)
}

out({ type: 'listening' })
setInterval(() => out({ type: 'level', value: Math.round(Math.random() * 100) / 100 }), 80)
let i = 0
const talk = setInterval(() => {
  if (i < words.length) {
    heard.push(words[i++])
    out({ type: 'partial', text: heard.join(' ') })
  } else if (mode === 'endless') {
    i = 0
  } else {
    clearInterval(talk)
    setTimeout(finish, 300) // the pause that ends the utterance
  }
}, 120)

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split('\n').map((l) => l.trim())) {
    if (line === 'stop') finish()
    if (line === 'cancel') {
      out({ type: 'cancelled' })
      process.exit(0)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
