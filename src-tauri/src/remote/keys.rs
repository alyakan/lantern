//! The Mac's own Noise key: made the first time remote control needs it, then kept in the login Keychain (never in a
//! file). A phone pins its public half when it pairs, so it is the same for as long as the Keychain keeps it.

use super::secure::{generate_keypair, Keypair};
use base64::Engine;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const SERVICE: &str = "Lantern Remote control";
const ACCOUNT: &str = "mac-key";

/// Where the key is kept: the Keychain in the app, memory in tests. `get` is Ok(None) only when there is no key yet;
/// any other failure (a locked Keychain, a prompt the user turned down) is an error, so the key is never replaced
/// because it couldn't be read: every paired phone would stop trusting this Mac.
pub trait KeyStore: Send + Sync {
    fn get(&self) -> Result<Option<Vec<u8>>, String>;
    fn set(&self, value: &[u8]) -> Result<(), String>;
}

pub struct Keychain;

/// The Keychain's "no such item".
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

impl KeyStore for Keychain {
    fn get(&self) -> Result<Option<Vec<u8>>, String> {
        match security_framework::passwords::get_generic_password(SERVICE, ACCOUNT) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(format!("Couldn't read the remote control key from the Keychain: {e}")),
        }
    }

    fn set(&self, value: &[u8]) -> Result<(), String> {
        security_framework::passwords::set_generic_password(SERVICE, ACCOUNT, value).map_err(|e| format!("Couldn't save the remote control key in the Keychain: {e}"))
    }
}

/// The Mac's key: the one kept, or a new one when there is none yet (or what is kept isn't a key at all).
pub fn mac_key(store: &dyn KeyStore) -> Result<Keypair, String> {
    if let Some(k) = store.get()?.and_then(|v| decode(&v)) {
        return Ok(k);
    }
    let k = generate_keypair()?;
    store.set(format!("{}:{}", B64.encode(&k.private), B64.encode(&k.public)).as_bytes())?;
    Ok(k)
}

fn decode(value: &[u8]) -> Option<Keypair> {
    let text = std::str::from_utf8(value).ok()?;
    let (private, public) = text.split_once(':')?;
    let (private, public) = (B64.decode(private).ok()?, B64.decode(public).ok()?);
    (private.len() == 32 && public.len() == 32).then_some(Keypair { private, public })
}

/// A key kept in memory only (tests, and a Remote made without the Keychain).
#[derive(Default)]
pub struct Memory(pub std::sync::Mutex<Option<Vec<u8>>>);

impl KeyStore for Memory {
    fn get(&self) -> Result<Option<Vec<u8>>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn set(&self, value: &[u8]) -> Result<(), String> {
        *self.0.lock().unwrap() = Some(value.to_vec());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn the_key_is_made_once_and_the_same_one_comes_back() {
        let store = Memory::default();
        let first = mac_key(&store).unwrap();
        assert_eq!(mac_key(&store).unwrap(), first);
    }

    #[test]
    fn a_damaged_entry_is_replaced_by_a_new_key() {
        let store = Memory(Mutex::new(Some(b"not a key".to_vec())));
        let k = mac_key(&store).unwrap();
        assert_eq!((k.private.len(), k.public.len()), (32, 32));
        assert_eq!(decode(&store.get().unwrap().unwrap()), Some(k));
    }

    /// A Keychain that can't be read right now (locked, or the user said no to its prompt).
    struct Locked(Mutex<bool>);

    impl KeyStore for Locked {
        fn get(&self) -> Result<Option<Vec<u8>>, String> {
            Err("locked".into())
        }
        fn set(&self, _: &[u8]) -> Result<(), String> {
            *self.0.lock().unwrap() = true;
            Ok(())
        }
    }

    #[test]
    fn a_key_that_cant_be_read_is_never_replaced() {
        let store = Locked(Mutex::new(false));
        assert!(mac_key(&store).is_err());
        assert!(!*store.0.lock().unwrap(), "no new key was written over the old one");
    }
}
