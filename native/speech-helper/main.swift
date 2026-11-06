// Hands-free speech input for Tidepool, using Apple's on-device speech recognition.
//
// The Electron main process spawns this helper for one utterance at a time. It listens to the
// microphone, reports what it hears as JSON lines on stdout, and exits once the user pauses.
// Audio never leaves the Mac: if on-device recognition isn't available for the locale, the
// helper fails instead of falling back to Apple's servers.
//
//   stdout  {"type":"listening"}                   audio engine is running
//           {"type":"level","value":0.42}          input level, 0...1, ~12 times a second
//           {"type":"partial","text":"..."}        transcript so far
//           {"type":"final","text":"..."}          the utterance; the helper then exits 0
//           {"type":"cancelled"}                   stopped without a result
//           {"type":"error","code":"...","message":"..."}   then exits 1
//   stdin   "stop"    finish now with whatever has been heard
//           "cancel"  discard and exit
//
//   speech-helper [--locale en-US] [--silence 1.6] [--no-speech 8] [--max 60]
//   speech-helper --status        report permission states without prompting
//   speech-helper --file a.aiff   transcribe a file (for testing without a microphone)

import AVFoundation
import Darwin
import Foundation
import Speech

// MARK: - Take responsibility for our own privacy access
//
// macOS attributes a child process's microphone and speech access to whoever launched it (the
// terminal running `npm run dev`, VS Code, the Electron app) and kills the child if *that* app's
// Info.plist lacks a usage description. Relaunch ourselves as our own responsible process, the
// way Chromium and VS Code launch their helpers, so macOS reads the Info.plist embedded in this
// binary and asks the user about "Tidepool Speech" by name. stdio is inherited as is.

@_silgen_name("responsibility_spawnattrs_setdisclaim")
func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

let disclaimedMarker = "TIDEPOOL_SPEECH_DISCLAIMED"
var childPid: pid_t = 0

if ProcessInfo.processInfo.environment[disclaimedMarker] == nil, let path = Bundle.main.executablePath {
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    _ = responsibility_spawnattrs_setdisclaim(&attr, 1)
    var env = ProcessInfo.processInfo.environment
    env[disclaimedMarker] = "1"
    let envp = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
    let argvp = CommandLine.arguments.map { strdup($0) } + [nil]
    if posix_spawn(&childPid, path, nil, &attr, argvp, envp) == 0 {
        // Pass on the app stopping us, then mirror how the real helper exited.
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig) { received in
                kill(childPid, received)
                exit(128 + received)
            }
        }
        var status: Int32 = 0
        while waitpid(childPid, &status, 0) == -1 && errno == EINTR {}
        let termSignal = status & 0x7f
        exit(termSignal == 0 ? (status >> 8) & 0xff : 128 + termSignal)
    }
    // If the relaunch fails, carry on in-process: it still works when launched from an app
    // that declares the usage descriptions itself (the packaged Tidepool does).
}

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["type": "error", "code": code, "message": message])
    exit(1)
}

// MARK: - Options

var localeId: String?
var silenceSeconds = 1.6
var noSpeechSeconds = 8.0
var maxSeconds = 60.0
var filePath: String?
var statusOnly = false

var argv = CommandLine.arguments.dropFirst().makeIterator()
while let arg = argv.next() {
    switch arg {
    case "--locale": localeId = argv.next()
    case "--silence": silenceSeconds = Double(argv.next() ?? "") ?? silenceSeconds
    case "--no-speech": noSpeechSeconds = Double(argv.next() ?? "") ?? noSpeechSeconds
    case "--max": maxSeconds = Double(argv.next() ?? "") ?? maxSeconds
    case "--file": filePath = argv.next()
    case "--status": statusOnly = true
    default: fail("usage", "Unknown argument \(arg)")
    }
}

func describe(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func describe(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

let locale = localeId.map(Locale.init(identifier:)) ?? Locale.current
guard let recognizer = SFSpeechRecognizer(locale: locale) else {
    fail("unsupported-locale", "Speech recognition doesn't support \(locale.identifier).")
}

if statusOnly {
    emit([
        "type": "status",
        "speech": describe(SFSpeechRecognizer.authorizationStatus()),
        "microphone": describe(AVCaptureDevice.authorizationStatus(for: .audio)),
        "locale": locale.identifier,
        "onDevice": recognizer.supportsOnDeviceRecognition,
    ])
    exit(0)
}

// MARK: - Listening

let engine = AVAudioEngine()
var task: SFSpeechRecognitionTask?
var currentRequest: SFSpeechAudioBufferRecognitionRequest?
var transcript = ""
var lastChange = Date()
var startedAt = Date()
var ending = false
var finished = false
let endCheck = DispatchSource.makeTimerSource(queue: .main)

func finish(_ text: String) {
    guard !finished else { return }
    finished = true
    emit(["type": "final", "text": text])
    task?.cancel()
    exit(0)
}

/// Stop capturing and give the recognizer a moment to settle on its final wording.
func endUtterance() {
    guard !ending else { return }
    ending = true
    engine.stop()
    engine.inputNode.removeTap(onBus: 0)
    currentRequest?.endAudio()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { finish(transcript) }
}

func handle(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
    DispatchQueue.main.async {
        if let result {
            let text = result.bestTranscription.formattedString
            // The recognizer can hand back an empty result, notably the final one after the audio
            // ends; that must not wipe out what it already heard.
            if !text.isEmpty, text != transcript {
                transcript = text
                lastChange = Date()
                emit(["type": "partial", "text": text])
            }
            if result.isFinal { finish(transcript) }
        } else if error != nil {
            // "No speech detected" and similar arrive as errors once audio ends; either way the
            // utterance is over, so report what we have.
            finish(transcript)
        }
    }
}

/// RMS of the first channel, mapped from -50...0 dBFS onto 0...1 for a simple meter.
func level(of buffer: AVAudioPCMBuffer) -> Double {
    guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
    var sum: Float = 0
    for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
    let rms = sqrt(sum / Float(buffer.frameLength))
    let db = 20 * log10(max(rms, 0.000_001))
    return Double(min(max((db + 50) / 50, 0), 1))
}

func startListening() {
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    request.addsPunctuation = true
    currentRequest = request

    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
        fail("no-microphone", "No microphone is available.")
    }
    var lastLevel = Date.distantPast
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
        let now = Date()
        if now.timeIntervalSince(lastLevel) >= 0.08 {
            lastLevel = now
            let value = level(of: buffer)
            DispatchQueue.main.async { emit(["type": "level", "value": (value * 100).rounded() / 100]) }
        }
    }
    engine.prepare()
    do {
        try engine.start()
    } catch {
        fail("audio", "Couldn't start the microphone: \(error.localizedDescription)")
    }

    startedAt = Date()
    lastChange = startedAt
    task = recognizer.recognitionTask(with: request) { result, error in handle(result, error) }
    emit(["type": "listening"])

    // End of utterance: a pause after speech, a long silence before any, or the hard cap. A
    // dispatch timer, not a Timer: dispatchMain() never runs the run loop a Timer needs.
    endCheck.schedule(deadline: .now() + 0.1, repeating: 0.1)
    endCheck.setEventHandler {
        guard !ending else { return }
        let now = Date()
        if !transcript.isEmpty, now.timeIntervalSince(lastChange) >= silenceSeconds {
            endUtterance()
        } else if transcript.isEmpty, now.timeIntervalSince(startedAt) >= noSpeechSeconds {
            endUtterance()
        } else if now.timeIntervalSince(startedAt) >= maxSeconds {
            endUtterance()
        }
    }
    endCheck.resume()

    // Commands from the app. EOF means the app went away, so stop too.
    Thread.detachNewThread {
        while let line = readLine() {
            switch line.trimmingCharacters(in: .whitespaces) {
            case "stop": DispatchQueue.main.async { endUtterance() }
            case "cancel":
                emit(["type": "cancelled"])
                exit(0)
            default: break
            }
        }
        exit(0)
    }
}

func transcribeFile(_ path: String) {
    let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
    request.requiresOnDeviceRecognition = true
    request.addsPunctuation = true
    task = recognizer.recognitionTask(with: request) { result, error in
        DispatchQueue.main.async {
            if let result, result.isFinal { finish(result.bestTranscription.formattedString) }
            else if let error { fail("recognition", error.localizedDescription) }
        }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) { fail("timeout", "Transcription timed out.") }
}

// MARK: - Permissions, then go

SFSpeechRecognizer.requestAuthorization { status in
    DispatchQueue.main.async {
        guard status == .authorized else {
            fail("speech-denied", "Speech Recognition access is \(describe(status)).")
        }
        guard recognizer.supportsOnDeviceRecognition else {
            fail("no-on-device", "On-device speech recognition isn't available for \(locale.identifier).")
        }
        if let filePath {
            transcribeFile(filePath)
            return
        }
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DispatchQueue.main.async {
                guard granted else { fail("microphone-denied", "Microphone access is off.") }
                startListening()
            }
        }
    }
}

dispatchMain()
