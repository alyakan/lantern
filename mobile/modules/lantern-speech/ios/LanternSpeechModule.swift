@preconcurrency import AVFoundation
import ExpoModulesCore
import Foundation
@preconcurrency import Speech

/// Dictation with iOS 26's SpeechAnalyzer and its SpeechTranscriber: the newer on-device model, much better than the
/// recognizer behind expo-speech-recognition, and with no time limit, so a long stretch needs no restarts. Before iOS 26,
/// and for a language it can't do, `supportedLanguage` says null and the app keeps the older recognizer.
///
/// Events have the same shape as expo-speech-recognition's, so the hook treats both alike: `result` ({transcript,
/// isFinal}: a finished phrase, or the one in progress, which the next replaces), `end`, and `error` ({error}, one of
/// that module's codes).
public class LanternSpeechModule: Module {
  private let lock = NSLock()
  private var run: AnyObject?

  public func definition() -> ModuleDefinition {
    Name("LanternSpeech")
    Events("result", "end", "error")

    AsyncFunction("supportedLanguage") { (lang: String) async -> String? in
      guard #available(iOS 26.0, *) else { return nil }
      return await SpeechRun.language(for: lang)
    }

    AsyncFunction("start") { (lang: String) async in
      guard #available(iOS 26.0, *) else { return self.fail("language-not-supported") }
      self.lock.lock()
      let busy = self.run != nil
      self.lock.unlock()
      if busy { return self.fail("busy") }
      do {
        let run = try await SpeechRun.start(
          lang: lang,
          onResult: { [weak self] text, isFinal in self?.sendEvent("result", ["transcript": text, "isFinal": isFinal]) },
          onEnd: { [weak self] failure in self?.ended(failure) }
        )
        self.lock.lock()
        self.run = run
        self.lock.unlock()
      } catch let failure as SpeechFailure {
        self.fail(failure.rawValue)
      } catch {
        self.fail("audio-capture")
      }
    }

    Function("stop") {
      guard #available(iOS 26.0, *) else { return }
      self.current()?.finish()
    }

    Function("abort") {
      guard #available(iOS 26.0, *) else { return }
      self.current()?.cancel()
    }

    OnDestroy {
      if #available(iOS 26.0, *) { self.current()?.cancel() }
    }
  }

  @available(iOS 26.0, *)
  private func current() -> SpeechRun? {
    lock.lock()
    defer { lock.unlock() }
    return run as? SpeechRun
  }

  private func ended(_ failure: SpeechFailure?) {
    lock.lock()
    run = nil
    lock.unlock()
    if let failure { sendEvent("error", ["error": failure.rawValue]) }
    sendEvent("end", [:])
  }

  private func fail(_ code: String) {
    sendEvent("error", ["error": code])
    sendEvent("end", [:])
  }
}

/// Why a run could not start or stopped early, as expo-speech-recognition's codes.
enum SpeechFailure: String, Error {
  case unsupported = "language-not-supported"
  case download = "network"
  case microphone = "audio-capture"
}

/// One stretch of listening: the microphone's buffers go in, finished phrases and the one in progress come out.
@available(iOS 26.0, *)
final class SpeechRun: @unchecked Sendable {
  private let analyzer: SpeechAnalyzer
  private let input: AsyncStream<AnalyzerInput>.Continuation
  private let format: AVAudioFormat
  private let engine = AVAudioEngine()
  private let onEnd: @Sendable (SpeechFailure?) -> Void
  private let lock = NSLock()
  private var converter: AVAudioConverter?
  private var results: Task<Void, Never>?
  private var over = false

  private init(analyzer: SpeechAnalyzer, input: AsyncStream<AnalyzerInput>.Continuation, format: AVAudioFormat, onEnd: @escaping @Sendable (SpeechFailure?) -> Void) {
    self.analyzer = analyzer
    self.input = input
    self.format = format
    self.onEnd = onEnd
  }

  /// The transcriber's own locale for `lang` ("en-US", or "en_EG" when that has one of its own), or nil when it has none.
  static func language(for lang: String) async -> String? {
    guard SpeechTranscriber.isAvailable else { return nil }
    let wanted = Locale(identifier: lang.replacingOccurrences(of: "_", with: "-"))
    return await SpeechTranscriber.supportedLocale(equivalentTo: wanted)?.identifier(.bcp47)
  }

  static func start(
    lang: String,
    onResult: @escaping @Sendable (String, Bool) -> Void,
    onEnd: @escaping @Sendable (SpeechFailure?) -> Void
  ) async throws -> SpeechRun {
    guard SpeechTranscriber.isAvailable,
      let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: lang))
    else { throw SpeechFailure.unsupported }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
    // The language's model is fetched once, the first time.
    do {
      if let download = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await download.downloadAndInstall()
      }
    } catch {
      throw SpeechFailure.download
    }
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw SpeechFailure.unsupported
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let (stream, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
    let run = SpeechRun(analyzer: analyzer, input: input, format: format, onEnd: onEnd)
    run.results = Task {
      do {
        for try await result in transcriber.results {
          let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
          onResult(text, result.isFinal)
        }
        run.end(nil)
      } catch {
        run.end(Task.isCancelled ? nil : .microphone)
      }
    }
    do {
      try await analyzer.start(inputSequence: stream)
      try run.listen()
    } catch {
      // It never started, so it never says it ended: the throw does.
      run.end(nil, quietly: true)
      run.cancel()
      throw SpeechFailure.microphone
    }
    return run
  }

  /// Opens the microphone and feeds it to the analyzer.
  private func listen() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothHFP])
    try session.setActive(true, options: .notifyOthersOnDeactivation)
    let node = engine.inputNode
    node.installTap(onBus: 0, bufferSize: 4096, format: node.outputFormat(forBus: 0)) { [weak self] buffer, _ in
      self?.append(buffer)
    }
    engine.prepare()
    try engine.start()
  }

  /// Called on the audio thread with the microphone's buffers.
  private func append(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    defer { lock.unlock() }
    if converter?.inputFormat != buffer.format {
      converter = AVAudioConverter(from: buffer.format, to: format)
    }
    guard let converter else { return }
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1024
    guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
    var supplied = false
    var error: NSError?
    converter.convert(to: converted, error: &error) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    if error == nil, converted.frameLength > 0 {
      input.yield(AnalyzerInput(buffer: converted))
    }
  }

  private func closeMicrophone() {
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  /// No more audio; the words already heard are still written, then `end`.
  func finish() {
    closeMicrophone()
    input.finish()
    let analyzer = analyzer
    Task { try? await analyzer.finalizeAndFinishThroughEndOfInput() }
  }

  /// Drops it at once.
  func cancel() {
    closeMicrophone()
    input.finish()
    results?.cancel()
    let analyzer = analyzer
    Task { await analyzer.cancelAndFinishNow() }
    end(nil)
  }

  /// Says it is over, once.
  private func end(_ failure: SpeechFailure?, quietly: Bool = false) {
    lock.lock()
    let first = !over
    over = true
    lock.unlock()
    guard first else { return }
    closeMicrophone()
    if !quietly { onEnd(failure) }
  }
}
