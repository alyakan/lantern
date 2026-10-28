import UserNotifications

/// Puts the full words on a notification from the Mac. The push carries general words ("A chat wants to run a command.") that
/// show if anything here goes wrong, and, when the Mac was asked to, the real ones sealed with a key only this phone has. This
/// opens them (PushText.swift) and swaps them in. Every failure (no key yet, nothing sealed, a text that doesn't open or read)
/// leaves the push exactly as it came, so the worst case is the notification Apple would have shown anyway.
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        original = request.content
        deliver(Self.opened(request.content))
    }

    /// The time is up: the general words go out as they came.
    override func serviceExtensionTimeWillExpire() {
        if let original { deliver(original) }
    }

    /// Delivers once, whichever of the above gets there first.
    private func deliver(_ content: UNNotificationContent) {
        guard let handler else { return }
        self.handler = nil
        handler(content)
    }

    /// The notification with the opened words in place of the general ones; as it came when it can't be opened.
    static func opened(_ content: UNNotificationContent) -> UNNotificationContent {
        guard let data = content.userInfo["body"] as? [String: Any],
              let enc = data["enc"] as? String,
              let slot = data["slot"] as? String,
              let key = PushKeychain.key(),
              let text = try? PushCrypto.open(enc: enc, slot: slot, requestId: data["request_id"] as? String ?? "", key: key),
              let out = content.mutableCopy() as? UNMutableNotificationContent
        else { return content }
        out.title = text.title
        out.subtitle = text.subtitle ?? ""
        out.body = text.body
        return out
    }
}
