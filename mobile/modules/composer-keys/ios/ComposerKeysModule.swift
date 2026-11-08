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
  /// The app's shortcuts on a hardware keyboard (see `setShortcuts`), and where they were put.
  private var shortcuts: (controller: UIViewController, commands: [UIKeyCommand])?

  public func definition() -> ModuleDefinition {
    Name("ComposerKeys")
    Events("onReturn", "onShortcut")

    OnCreate { Self.active = self }
    OnDestroy {
      DispatchQueue.main.async { [weak self] in
        self?.remove()
        self?.removeShortcuts()
      }
    }

    // The app's shortcuts on a hardware keyboard: Command-N, Command-F, Command-\ and Escape, each sent to JS by name
    // (`onShortcut`). Holding Command shows the ones with a title, as iPadOS lists any app's.
    Function("setShortcuts") { (enabled: Bool) in
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        if enabled { self.installShortcuts() } else { self.removeShortcuts() }
      }
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

  /// What each shortcut is called in JS, by its key and modifiers.
  private static let named: [(input: String, flags: UIKeyModifierFlags, name: String, title: String?)] = [
    ("n", .command, "newChat", "New Chat"),
    ("f", .command, "find", "Find in Chat"),
    ("\\", .command, "toggleChats", "Show or Hide Chats"),
    (UIKeyCommand.inputEscape, [], "escape", nil),
  ]

  private func installShortcuts() {
    guard shortcuts == nil, let controller = Self.rootController() else { return }
    let commands = Self.named.map { k -> UIKeyCommand in
      let command = UIKeyCommand(input: k.input, modifierFlags: k.flags, action: #selector(UIResponder.lanternShortcut(_:)))
      if let title = k.title { command.discoverabilityTitle = title }
      return command
    }
    commands.forEach(controller.addKeyCommand)
    shortcuts = (controller, commands)
  }

  private func removeShortcuts() {
    guard let shortcuts else { return }
    shortcuts.commands.forEach(shortcuts.controller.removeKeyCommand)
    self.shortcuts = nil
  }

  fileprivate func pressed(_ command: UIKeyCommand) {
    guard let name = Self.named.first(where: { $0.input == command.input && $0.flags == command.modifierFlags })?.name else { return }
    sendEvent("onShortcut", ["name": name])
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

  /// The action of the app's shortcuts: whoever has the keyboard answers it, and the module says which it was.
  @objc fileprivate func lanternShortcut(_ sender: UIKeyCommand) {
    ComposerKeysModule.active?.pressed(sender)
  }
}
