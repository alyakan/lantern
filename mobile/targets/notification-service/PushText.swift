import CryptoKit
import Foundation

/// What a push from the Mac says once it is opened: the words the notification shows in place of the general ones.
struct PushText: Equatable {
    var title: String
    var subtitle: String?
    var body: String
}

/// Opens the text a push carries. The Mac seals it (ChaCha20-Poly1305, RFC 8439) with a key only this phone has; Apple relays
/// scrambled bytes. `enc` is base64 of nonce (12) + ciphertext + tag (16), and the chat's slot and the prompt's request id (empty
/// when the push has none) are authenticated with it, so a text can't be moved to another chat's push, or to another prompt's
/// Allow button. Nothing here touches the Keychain or the network: it can be compiled and tested
/// alone (mobile/scripts/verify-push-text.sh). Neither the key nor the text is ever logged.
enum PushCrypto {
    /// Authenticated with the text: the Mac builds the same words (src-tauri/src/remote/notifier.rs).
    static let aadPrefix = "lantern.push.v1:"
    /// How much of each is put on the notification (in characters): the Mac cuts the text to fit a push already.
    static let maxTitle = 120
    static let maxSubtitle = 120
    static let maxBody = 2000

    enum Failure: Error {
        case badKey
        case badEnvelope
        case cannotOpen
        case badText
    }

    /// The key as the app stored it: base64 of 32 bytes.
    static func key(fromStored stored: String) -> Data? {
        guard let data = Data(base64Encoded: stored.trimmingCharacters(in: .whitespacesAndNewlines)), data.count == 32 else { return nil }
        return data
    }

    static func open(enc: String, slot: String, requestId: String, key: Data) throws -> PushText {
        guard key.count == 32 else { throw Failure.badKey }
        guard let combined = Data(base64Encoded: enc), combined.count > 12 + 16 else { throw Failure.badEnvelope }
        let plain: Data
        do {
            let box = try ChaChaPoly.SealedBox(combined: combined)
            plain = try ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: Data("\(aadPrefix)\(slot):\(requestId)".utf8))
        } catch {
            throw Failure.cannotOpen
        }
        guard let object = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
              let title = object["title"] as? String,
              let body = object["body"] as? String,
              !body.isEmpty
        else { throw Failure.badText }
        let subtitle = (object["subtitle"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return PushText(title: clip(title, maxTitle), subtitle: subtitle.map { clip($0, maxSubtitle) }, body: clip(body, maxBody))
    }

    private static func clip(_ text: String, _ max: Int) -> String {
        text.count <= max ? text : String(text.prefix(max - 1)) + "…"
    }
}
