//! Pairing a phone and remembering it: the one-time offer the QR code carries, Remote control's settings, and the list
//! of paired devices (each by the key it proved it holds, see secure.rs). Kept in app data as remote.json, readable by
//! the user only. The Mac's own key is in the Keychain (see keys.rs).

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// How long a QR code can be used for.
pub const OFFER_TTL_MS: u64 = 5 * 60 * 1000;

/// What the QR code the Mac shows carries: everything a phone needs to find this Mac and pair with it, once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
    pub secret: [u8; 32],
    pub expires_at: u64,
}

pub fn random_secret() -> Result<[u8; 32], String> {
    let mut s = [0u8; 32];
    getrandom::fill(&mut s).map_err(|e| format!("Couldn't make a pairing code: {e}"))?;
    Ok(s)
}

/// The pairing link in the QR code. `hosts`: the Mac's addresses on its networks, which the phone dials when Bonjour
/// finds nothing (a network that keeps its devices apart).
pub fn pairing_link(mac_key: &[u8], offer: &Offer, hosts: &[String], port: u16, mac_name: &str) -> String {
    let enc = |s: &str| s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    format!("lantern://pair?v=1&k={}&s={}&h={}&p={port}&n={}&e={}", B64.encode(mac_key), B64.encode(offer.secret), enc(&hosts.join(",")), enc(mac_name), offer.expires_at)
}

/// The QR code for `link`, as an SVG.
pub fn qr_svg(link: &str) -> Result<String, String> {
    let code = qrcode::QrCode::with_error_correction_level(link.as_bytes(), qrcode::EcLevel::M).map_err(|e| e.to_string())?;
    Ok(code.render::<qrcode::render::svg::Color>().min_dimensions(240, 240).quiet_zone(true).build())
}

/// A paired phone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    /// Its Noise key (URL-safe base64): what it proves it holds each time it connects.
    pub key: String,
    pub paired_at: u64,
    pub last_seen: Option<u64>,
    /// Where its notifications go (Expo's push token), once it says.
    pub push_token: Option<String>,
}

/// Remote control's settings and its paired devices, as saved.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    /// Off until the user turns it on. While it is off nothing listens for phones.
    #[serde(default)]
    pub enabled: bool,
    /// Notifications name the chat (off: they only say a chat needs you, or finished).
    #[serde(default)]
    pub show_titles: bool,
    /// Paired phones may start chats on Auto, and put chats on Auto (off: they are on Ask, and a phone can't change that).
    /// It is only about what a phone may ask for: a chat already on Auto stays on it when this is turned off.
    #[serde(default)]
    pub allow_phone_auto: bool,
    #[serde(default)]
    pub devices: Vec<Device>,
}

pub struct RemoteStore {
    path: Option<PathBuf>,
    saved: Mutex<Saved>,
    offer: Mutex<Option<Offer>>,
}

impl RemoteStore {
    pub fn load(path: Option<PathBuf>) -> Self {
        let saved = path.as_deref().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { path, saved: Mutex::new(saved), offer: Mutex::new(None) }
    }

    pub fn saved(&self) -> Saved {
        self.saved.lock().unwrap().clone()
    }

    /// Changes what is saved. The change holds in memory either way (so turning Remote control off or removing a phone
    /// takes effect now); the error says it couldn't be saved, so it would come back after a restart.
    fn change<T>(&self, f: impl FnOnce(&mut Saved) -> T) -> Result<T, String> {
        let mut saved = self.saved.lock().unwrap();
        let out = f(&mut saved);
        match &self.path {
            Some(path) => write_private(path, &saved).map(|()| out).map_err(|e| format!("Done for now, but Lantern couldn't save it, so it won't last past a restart: {e}")),
            None => Ok(out),
        }
    }

    pub fn set_enabled(&self, on: bool) -> Result<(), String> {
        // Turning it off ends any pairing in progress.
        if !on {
            self.cancel_offer();
        }
        self.change(|s| s.enabled = on)
    }

    pub fn set_show_titles(&self, on: bool) -> Result<(), String> {
        self.change(|s| s.show_titles = on)
    }

    pub fn set_allow_phone_auto(&self, on: bool) -> Result<(), String> {
        self.change(|s| s.allow_phone_auto = on)
    }

    /// A new offer, in place of any other (an old QR code stops working).
    pub fn start_offer(&self, now: u64) -> Result<Offer, String> {
        let offer = Offer { secret: random_secret()?, expires_at: now + OFFER_TTL_MS };
        *self.offer.lock().unwrap() = Some(offer.clone());
        Ok(offer)
    }

    pub fn cancel_offer(&self) {
        *self.offer.lock().unwrap() = None;
    }

    /// The offer's secret for a phone starting to pair: used up by the attempt, whether it works or not, so a QR code can
    /// be tried once (and a guess can't be retried). None when there is no offer, or it expired.
    pub fn take_offer(&self, now: u64) -> Option<[u8; 32]> {
        let offer = self.offer.lock().unwrap().take()?;
        (now < offer.expires_at).then_some(offer.secret)
    }

    pub fn offer_open(&self, now: u64) -> bool {
        self.offer.lock().unwrap().as_ref().is_some_and(|o| now < o.expires_at)
    }

    /// Remembers a phone that just paired; the same key pairing again is the same device, renamed.
    pub fn add_device(&self, key: &[u8], name: &str, now: u64) -> Result<Device, String> {
        let key = B64.encode(key);
        let name: String = name.trim().chars().take(60).collect();
        let name = if name.is_empty() { "Phone".to_string() } else { name };
        self.change(|s| {
            if let Some(d) = s.devices.iter_mut().find(|d| d.key == key) {
                d.name = name;
                return d.clone();
            }
            let id = format!("phone-{}", &key[..12.min(key.len())]);
            let device = Device { id, name, key, paired_at: now, last_seen: Some(now), push_token: None };
            s.devices.push(device.clone());
            device
        })
    }

    /// The paired device with this key, if any: the only way a connecting phone gets in.
    pub fn device_by_key(&self, key: &[u8]) -> Option<Device> {
        let key = B64.encode(key);
        self.saved.lock().unwrap().devices.iter().find(|d| d.key == key).cloned()
    }

    /// Whether a device was removed (it is from memory either way; the error says it couldn't be saved).
    pub fn remove_device(&self, id: &str) -> Result<bool, String> {
        self.change(|s| {
            let before = s.devices.len();
            s.devices.retain(|d| d.id != id);
            s.devices.len() != before
        })
    }

    /// When a device last connected: only shown in Settings, so a save that fails is no matter.
    pub fn seen(&self, id: &str, now: u64) {
        let _ = self.change(|s| s.devices.iter_mut().filter(|d| d.id == id).for_each(|d| d.last_seen = Some(now)));
    }

    /// Expo push tokens look like `ExponentPushToken[…]`; anything else is refused.
    pub fn set_push_token(&self, id: &str, token: &str) -> Result<(), String> {
        let ok = token.len() <= 200 && token.starts_with("ExponentPushToken[") && token.ends_with(']') && token.chars().all(|c| c.is_ascii_graphic());
        if !ok {
            return Err("That isn't a push token.".into());
        }
        self.change(|s| s.devices.iter_mut().filter(|d| d.id == id).for_each(|d| d.push_token = Some(token.to_string())))
    }

    /// Forgets a device's push token (Expo says the phone no longer has the app); the device stays paired.
    pub fn clear_push_token(&self, id: &str) -> Result<(), String> {
        self.change(|s| s.devices.iter_mut().filter(|d| d.id == id).for_each(|d| d.push_token = None))
    }
}

/// Written beside the file and renamed over it, readable by the user only.
fn write_private(path: &std::path::Path, saved: &Saved) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(saved).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);
    std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).and_then(|mut f| f.write_all(&json)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (RemoteStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (RemoteStore::load(Some(dir.path().join("remote.json"))), dir)
    }

    #[test]
    fn remote_control_starts_off_and_its_settings_and_devices_are_kept() {
        let (s, dir) = store();
        assert_eq!(s.saved(), Saved::default());
        s.set_enabled(true).unwrap();
        s.set_show_titles(true).unwrap();
        assert!(!s.saved().allow_phone_auto, "phones may not use Auto until the user says so");
        s.set_allow_phone_auto(true).unwrap();
        let d = s.add_device(&[1u8; 32], "Aly's iPhone", 10).unwrap();
        let again = RemoteStore::load(Some(dir.path().join("remote.json")));
        assert_eq!(again.saved(), Saved { enabled: true, show_titles: true, allow_phone_auto: true, devices: vec![d] });
    }

    #[test]
    fn a_change_that_cant_be_saved_still_holds_now_and_says_it_wont_last() {
        let dir = tempfile::tempdir().unwrap();
        // A file where the folder should be: nothing can be written under it.
        std::fs::write(dir.path().join("blocked"), "").unwrap();
        let s = RemoteStore::load(Some(dir.path().join("blocked").join("remote.json")));
        assert!(s.add_device(&[6u8; 32], "Pixel", 1).is_err());
        let id = s.saved().devices[0].id.clone();
        assert!(s.set_enabled(true).is_err());
        assert!(s.remove_device(&id).unwrap_err().contains("won't last past a restart"));
        assert!(s.device_by_key(&[6u8; 32]).is_none(), "removed from memory even so");
        assert!(s.set_enabled(false).is_err());
        assert!(!s.saved().enabled, "and turned off even so");
    }

    #[test]
    fn the_saved_file_is_readable_by_the_user_only() {
        use std::os::unix::fs::PermissionsExt;
        let (s, dir) = store();
        s.set_enabled(true).unwrap();
        let mode = std::fs::metadata(dir.path().join("remote.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn an_offer_can_be_used_once_and_not_after_it_expires_or_is_replaced() {
        let (s, _d) = store();
        assert!(s.take_offer(0).is_none());
        let offer = s.start_offer(1000).unwrap();
        assert!(s.offer_open(1000));
        assert_eq!(s.take_offer(1001), Some(offer.secret));
        assert!(s.take_offer(1002).is_none(), "used up");
        s.start_offer(0).unwrap();
        assert!(s.take_offer(OFFER_TTL_MS).is_none(), "expired");
        let old = s.start_offer(0).unwrap();
        let new = s.start_offer(0).unwrap();
        assert_ne!(old.secret, new.secret);
        assert_eq!(s.take_offer(1), Some(new.secret));
        s.start_offer(0).unwrap();
        s.set_enabled(false).unwrap();
        assert!(s.take_offer(1).is_none(), "turning remote control off ends the offer");
    }

    #[test]
    fn only_a_paired_key_is_known_and_removing_it_forgets_it() {
        let (s, _d) = store();
        let d = s.add_device(&[2u8; 32], "Pixel", 5).unwrap();
        assert_eq!(s.device_by_key(&[2u8; 32]).unwrap().id, d.id);
        assert!(s.device_by_key(&[3u8; 32]).is_none());
        // Pairing the same key again renames it rather than adding another.
        s.add_device(&[2u8; 32], "  Pixel 10  ", 6).unwrap();
        assert_eq!(s.saved().devices.len(), 1);
        assert_eq!(s.saved().devices[0].name, "Pixel 10");
        assert!(s.remove_device(&d.id).unwrap());
        assert!(s.device_by_key(&[2u8; 32]).is_none());
        assert!(!s.remove_device(&d.id).unwrap());
    }

    #[test]
    fn a_push_token_must_look_like_expos() {
        let (s, _d) = store();
        let d = s.add_device(&[4u8; 32], "", 1).unwrap();
        assert_eq!(d.name, "Phone");
        assert!(s.set_push_token(&d.id, "ExponentPushToken[abc123]").is_ok());
        assert!(s.set_push_token(&d.id, "https://evil.example/hook").is_err());
        assert!(s.set_push_token(&d.id, "ExponentPushToken[a b]").is_err());
        assert_eq!(s.saved().devices[0].push_token.as_deref(), Some("ExponentPushToken[abc123]"));
    }

    #[test]
    fn the_pairing_link_carries_the_key_secret_and_addresses_and_fits_a_qr_code() {
        let offer = Offer { secret: [9u8; 32], expires_at: 77 };
        let link = pairing_link(&[1u8; 32], &offer, &["192.168.1.20".into(), "10.0.0.5".into()], 47123, "Aly's MacBook Pro");
        assert!(link.starts_with("lantern://pair?v=1&k="));
        assert!(link.contains(&format!("s={}", B64.encode([9u8; 32]))));
        assert!(link.contains("h=192.168.1.20%2C10.0.0.5&p=47123&n=Aly%27s%20MacBook%20Pro&e=77"));
        let svg = qr_svg(&link).unwrap();
        assert!(svg.starts_with("<?xml") && svg.contains("<svg"));
    }
}
