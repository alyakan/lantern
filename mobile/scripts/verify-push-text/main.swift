import Foundation

// Checks PushText.swift against the shared vector (src/protocol/push-vector.json, made with node's OpenSSL, so Rust and Swift are
// both held to a third implementation). Run by scripts/verify-push-text.sh. Exits non-zero on the first thing that is wrong.

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
    exit(1)
}

guard CommandLine.arguments.count == 2,
      let raw = FileManager.default.contents(atPath: CommandLine.arguments[1]),
      let vector = try? JSONSerialization.jsonObject(with: raw) as? [String: String],
      let keyB64 = vector["key_b64"], let slot = vector["slot"], let requestId = vector["request_id"], let plaintext = vector["plaintext"], let enc = vector["enc"],
      let key = PushCrypto.key(fromStored: keyB64),
      let expected = try? JSONSerialization.jsonObject(with: Data(plaintext.utf8)) as? [String: String]
else { fail("usage: verify <push-vector.json>, and the vector must have key_b64, slot, request_id, plaintext and enc") }

// 1. The vector opens to exactly the words it was made from (non-ASCII included).
guard let text = try? PushCrypto.open(enc: enc, slot: slot, requestId: requestId, key: key) else { fail("the vector did not open") }
guard text.title == expected["title"], text.subtitle == expected["subtitle"], text.body == expected["body"] else { fail("the vector opened to other words: \(text)") }

// 2. Another chat's slot in its place (the slot is authenticated): it does not open.
if (try? PushCrypto.open(enc: enc, slot: slot + "x", requestId: requestId, key: key)) != nil { fail("opened with the wrong slot") }

// 2b. Another prompt's request id, or none (the id is authenticated: words can't be moved to another prompt's Allow button).
if (try? PushCrypto.open(enc: enc, slot: slot, requestId: requestId + "x", key: key)) != nil { fail("opened with the wrong request id") }
if (try? PushCrypto.open(enc: enc, slot: slot, requestId: "", key: key)) != nil { fail("opened with no request id") }

// 3. A single flipped bit anywhere (nonce, text, tag) does not open.
let sealed = Data(base64Encoded: enc)!
for i in stride(from: 0, to: sealed.count, by: 5) {
    var bad = sealed
    bad[i] ^= 0x01
    if (try? PushCrypto.open(enc: bad.base64EncodedString(), slot: slot, requestId: requestId, key: key)) != nil { fail("opened with byte \(i) flipped") }
}

// 4. Another key, a short key, a cut envelope, and nonsense do not open (and do not crash).
if (try? PushCrypto.open(enc: enc, slot: slot, requestId: requestId, key: Data(repeating: 7, count: 32))) != nil { fail("opened with another key") }
if (try? PushCrypto.open(enc: enc, slot: slot, requestId: requestId, key: Data(repeating: 7, count: 16))) != nil { fail("opened with a short key") }
if (try? PushCrypto.open(enc: String(enc.prefix(20)), slot: slot, requestId: requestId, key: key)) != nil { fail("opened a cut envelope") }
if (try? PushCrypto.open(enc: "not base64 !!", slot: slot, requestId: requestId, key: key)) != nil { fail("opened nonsense") }
if (try? PushCrypto.open(enc: "", slot: slot, requestId: requestId, key: key)) != nil { fail("opened nothing") }

// 5. The stored key is base64 of exactly 32 bytes.
if PushCrypto.key(fromStored: Data(repeating: 1, count: 31).base64EncodedString()) != nil { fail("took a 31-byte key") }
if PushCrypto.key(fromStored: "%%%") != nil { fail("took a key that is not base64") }

print("ok: the vector opens, and every change to it is refused")
