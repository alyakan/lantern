import ExpoModulesCore
import UIKit

/// Return on a hardware keyboard, for the message box: while it is on, a plain Return is sent to JS (`onReturn`) instead of
/// putting a new line in the box. Shift+Return is not registered, so the box handles it as it always did and it stays a new
/// line. The on-screen keyboard doesn't go through key commands, so its Return key is untouched.
///
/// A key command can't call a closure: UIKit looks up its selector along the responder chain from whatever is typing. So the
/// selector lives on UIResponder (below), and finds the module through `ComposerKeysModule.active`.
public class ComposerKeysModule: Module {
  fileprivate static weak var active: ComposerKeysModule?
  private var installed: (controller: UIViewController, command: UIKeyCommand)?

  public func definition() -> ModuleDefinition {
    Name("ComposerKeys")
    Events("onReturn")

    OnCreate { Self.active = self }
    OnDestroy {
      DispatchQueue.main.async { [weak self] in self?.remove() }
    }

    // The message box has the keyboard (true) or no longer does (false).
    Function("setEnabled") { (enabled: Bool) in
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        if enabled { self.install() } else { self.remove() }
      }
    }
  }

  private func install() {
    guard installed == nil, let controller = Self.rootController() else { return }
    let command = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(UIResponder.lanternComposerReturn))
    // Over the text view's own Return, which would insert the new line.
    command.wantsPriorityOverSystemBehavior = true
    controller.addKeyCommand(command)
    installed = (controller, command)
  }

  private func remove() {
    guard let installed else { return }
    installed.controller.removeKeyCommand(installed.command)
    self.installed = nil
  }

  fileprivate func returned() {
    sendEvent("onReturn", [:])
  }

  private static func rootController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.flatMap { $0.windows }.first
    return window?.rootViewController
  }
}

extension UIResponder {
  /// The action of the Return key command: whoever is typing answers it.
  @objc fileprivate func lanternComposerReturn() {
    // Return that confirms a word being composed (Japanese, Chinese, accents) is not a send.
    if let input = self as? UITextInput, input.markedTextRange != nil {
      input.unmarkText()
      return
    }
    ComposerKeysModule.active?.returned()
  }
}
