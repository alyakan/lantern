import Foundation
import Security

/// Reads the key the app stored for this extension. The app writes it with expo-secure-store (key `push-key`, service
/// `lantern.push`, after first unlock, in the keychain group `<team>.com.alyakan.lantern.push`), and expo-secure-store names the
/// item its own way: the service gets ":no-auth" appended, and the account and generic attributes are the key's UTF-8 bytes (see
/// node_modules/expo-secure-store/ios/SecureStoreModule.swift `query`). This asks the same way. It names no access group, so
/// it looks only in the groups this extension was given in its entitlements: the one shared group.
enum PushKeychain {
    static let account = "push-key"
    static let service = "lantern.push"

    /// The key, or nil when there is none (the app has not stored one yet, or this phone was restored), or when it can't be read.
    static func key() -> Data? {
        // expo-secure-store looks under ":no-auth", then under the plain service (an older way of storing); so does this.
        for name in ["\(service):no-auth", service] {
            let encoded = Data(account.utf8)
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: name,
                kSecAttrGeneric as String: encoded,
                kSecAttrAccount as String: encoded,
                kSecMatchLimit as String: kSecMatchLimitOne,
                kSecReturnData as String: kCFBooleanTrue as Any,
            ]
            var item: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
                  let data = item as? Data,
                  let stored = String(data: data, encoding: .utf8),
                  let key = PushCrypto.key(fromStored: stored)
            else { continue }
            return key
        }
        return nil
    }
}
