//! The channel between Lantern and a paired phone, whatever carries it (see the transports): a Noise handshake, then
//! every message encrypted and authenticated end to end. A transport (the Wi-Fi now, a relay later) only ever carries
//! bytes it can't read or change.
//!
//! Pairing is `Noise_XXpsk3` with the one-time secret from the QR code the Mac shows: only the phone that read it can
//! finish, and the Mac learns the phone's key. Connecting again is `Noise_XX`: the phone checks the Mac's key against the
//! one it pinned from the QR code, and the Mac lets in only keys on its device list.

use snow::{Builder, HandshakeState, TransportState};

pub const PAIR_PATTERN: &str = "Noise_XXpsk3_25519_ChaChaPoly_SHA256";
pub const CONNECT_PATTERN: &str = "Noise_XX_25519_ChaChaPoly_SHA256";
/// Bound into every handshake: a handshake for anything else (another protocol, another version) fails.
pub const PROLOGUE: &[u8] = b"lantern-remote/1";
/// The longest Noise message, and what fits in one of ours after the tag and the frame's flag.
const NOISE_MAX: usize = 65535;
const CHUNK: usize = NOISE_MAX - 16 - 1;
/// The biggest message either side takes, put together from its frames.
pub const MAX_MESSAGE: usize = 8 << 20;

/// What the phone sends before its handshake, so the Mac knows which one it starts.
pub const PAIR: u8 = b'P';
pub const CONNECT: u8 = b'C';

#[derive(Clone, PartialEq, Eq)]
pub struct Keypair {
    pub private: Vec<u8>,
    pub public: Vec<u8>,
}

impl std::fmt::Debug for Keypair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keypair").field("public", &self.public).finish_non_exhaustive()
    }
}

pub fn generate_keypair() -> Result<Keypair, String> {
    let k = Builder::new(CONNECT_PATTERN.parse().map_err(err)?).generate_keypair().map_err(err)?;
    Ok(Keypair { private: k.private, public: k.public })
}

fn err(e: impl std::fmt::Display) -> String {
    format!("The secure channel failed: {e}")
}

fn builder<'a>(pattern: &str, key: &'a Keypair) -> Result<Builder<'a>, String> {
    Ok(Builder::new(pattern.parse().map_err(err)?).prologue(PROLOGUE).local_private_key(&key.private))
}

/// One side's handshake, a message at a time. The phone starts (`initiator`), the Mac answers (`responder`).
pub struct Handshake {
    hs: HandshakeState,
}

impl Handshake {
    /// The Mac's side of pairing with the QR code's one-time `secret`.
    pub fn pair_responder(mac: &Keypair, secret: &[u8; 32]) -> Result<Self, String> {
        Ok(Self { hs: builder(PAIR_PATTERN, mac)?.psk(3, secret).build_responder().map_err(err)? })
    }

    /// The Mac's side of a paired phone connecting again.
    pub fn connect_responder(mac: &Keypair) -> Result<Self, String> {
        Ok(Self { hs: builder(CONNECT_PATTERN, mac)?.build_responder().map_err(err)? })
    }

    /// The phone's side (Lantern's tests, and a test client, play it).
    pub fn pair_initiator(phone: &Keypair, secret: &[u8; 32]) -> Result<Self, String> {
        Ok(Self { hs: builder(PAIR_PATTERN, phone)?.psk(3, secret).build_initiator().map_err(err)? })
    }

    pub fn connect_initiator(phone: &Keypair) -> Result<Self, String> {
        Ok(Self { hs: builder(CONNECT_PATTERN, phone)?.build_initiator().map_err(err)? })
    }

    /// The next message to send.
    pub fn write(&mut self) -> Result<Vec<u8>, String> {
        let mut buf = vec![0u8; NOISE_MAX];
        let n = self.hs.write_message(&[], &mut buf).map_err(err)?;
        buf.truncate(n);
        Ok(buf)
    }

    /// Reads the other side's message: an error is a handshake that must stop (a wrong secret, a tampered message).
    pub fn read(&mut self, msg: &[u8]) -> Result<(), String> {
        let mut buf = vec![0u8; NOISE_MAX];
        self.hs.read_message(msg, &mut buf).map(|_| ()).map_err(err)
    }

    /// The other side's key, once the handshake has carried it.
    pub fn remote_key(&self) -> Option<Vec<u8>> {
        self.hs.get_remote_static().map(<[u8]>::to_vec)
    }

    pub fn is_done(&self) -> bool {
        self.hs.is_handshake_finished()
    }

    /// The finished handshake's channel, and the other side's key.
    pub fn finish(self) -> Result<(Vec<u8>, Channel), String> {
        let remote = self.remote_key().ok_or("The secure channel failed: the other side sent no key.")?;
        Ok((remote, Channel { t: self.hs.into_transport_mode().map_err(err)?, partial: Vec::new(), broken: false }))
    }
}

/// An open channel: messages in and out, each split into frames that fit a Noise message. Every frame is encrypted with
/// a flag inside it (more to come, or the last), so frames can't be cut, joined or reordered unnoticed. After its first
/// error it refuses everything: the connection it was on has to go.
pub struct Channel {
    t: TransportState,
    partial: Vec<u8>,
    broken: bool,
}

const BROKEN: &str = "The secure channel failed earlier and is closed.";

impl Channel {
    /// The frames that carry `plain`, to send in order. A message too big to send is refused without breaking the channel.
    pub fn seal(&mut self, plain: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        if self.broken {
            return Err(BROKEN.into());
        }
        if plain.len() > MAX_MESSAGE {
            return Err("That message is too big to send.".into());
        }
        let sealed = self.seal_chunks(plain);
        self.broken = sealed.is_err();
        sealed
    }

    fn seal_chunks(&mut self, plain: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        let chunks: Vec<&[u8]> = if plain.is_empty() { vec![&[]] } else { plain.chunks(CHUNK).collect() };
        let last = chunks.len() - 1;
        chunks
            .into_iter()
            .enumerate()
            .map(|(i, chunk)| {
                let mut framed = Vec::with_capacity(chunk.len() + 1);
                framed.push(u8::from(i == last));
                framed.extend_from_slice(chunk);
                let mut out = vec![0u8; framed.len() + 16];
                let n = self.t.write_message(&framed, &mut out).map_err(err)?;
                out.truncate(n);
                Ok(out)
            })
            .collect()
    }

    /// Reads a frame: the whole message once its last frame is in, None before. An error ends the channel: the frame was
    /// tampered with, came out of order, or the message grew past MAX_MESSAGE.
    pub fn open(&mut self, frame: &[u8]) -> Result<Option<Vec<u8>>, String> {
        if self.broken {
            return Err(BROKEN.into());
        }
        let opened = self.open_frame(frame);
        self.broken = opened.is_err();
        opened
    }

    fn open_frame(&mut self, frame: &[u8]) -> Result<Option<Vec<u8>>, String> {
        if frame.len() > NOISE_MAX {
            return Err(err("a frame bigger than a Noise message"));
        }
        let mut out = vec![0u8; frame.len()];
        let n = self.t.read_message(frame, &mut out).map_err(err)?;
        let Some((&flag, data)) = out[..n].split_first() else { return Err(err("an empty frame")) };
        if self.partial.len() + data.len() > MAX_MESSAGE {
            return Err("The other side sent a message that is too big.".into());
        }
        self.partial.extend_from_slice(data);
        Ok(match flag {
            1 => Some(std::mem::take(&mut self.partial)),
            0 => None,
            _ => return Err(err("a frame with a bad flag")),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs a whole handshake between `phone` (initiator) and `mac` (responder): both channels and the keys each learned.
    /// A finished side: the key the other side proved, and the channel.
    pub(crate) type Side = (Vec<u8>, Channel);

    pub(crate) fn shake(mut phone: Handshake, mut mac: Handshake) -> Result<(Side, Side), String> {
        mac.read(&phone.write()?)?;
        phone.read(&mac.write()?)?;
        mac.read(&phone.write()?)?;
        assert!(phone.is_done() && mac.is_done());
        Ok((phone.finish()?, mac.finish()?))
    }

    fn pair() -> (Keypair, Keypair, [u8; 32]) {
        (generate_keypair().unwrap(), generate_keypair().unwrap(), [7u8; 32])
    }

    #[test]
    fn pairing_with_the_qr_secret_opens_a_channel_and_each_side_learns_the_others_key() {
        let (mac, phone, secret) = pair();
        let ((mac_key, mut to_mac), (phone_key, mut to_phone)) = shake(Handshake::pair_initiator(&phone, &secret).unwrap(), Handshake::pair_responder(&mac, &secret).unwrap()).unwrap();
        assert_eq!((mac_key, phone_key), (mac.public.clone(), phone.public.clone()));
        let frames = to_mac.seal(b"hello mac").unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(to_phone.open(&frames[0]).unwrap(), Some(b"hello mac".to_vec()));
        let back = to_phone.seal(b"hello phone").unwrap();
        assert_eq!(to_mac.open(&back[0]).unwrap(), Some(b"hello phone".to_vec()));
    }

    #[test]
    fn a_phone_without_the_secret_cannot_pair() {
        let (mac, phone, secret) = pair();
        let mut guess = secret;
        guess[0] ^= 1;
        assert!(shake(Handshake::pair_initiator(&phone, &guess).unwrap(), Handshake::pair_responder(&mac, &secret).unwrap()).is_err());
    }

    #[test]
    fn connecting_again_needs_no_secret_and_tells_the_mac_which_phone_it_is() {
        let (mac, phone, _) = pair();
        let ((mac_key, _), (phone_key, _)) = shake(Handshake::connect_initiator(&phone).unwrap(), Handshake::connect_responder(&mac).unwrap()).unwrap();
        assert_eq!((mac_key, phone_key), (mac.public, phone.public));
    }

    #[test]
    fn a_pairing_handshake_and_a_connecting_one_dont_mix() {
        let (mac, phone, secret) = pair();
        assert!(shake(Handshake::connect_initiator(&phone).unwrap(), Handshake::pair_responder(&mac, &secret).unwrap()).is_err());
    }

    #[test]
    fn a_big_message_goes_in_several_frames_and_comes_out_whole() {
        let (mac, phone, secret) = pair();
        let ((_, mut a), (_, mut b)) = shake(Handshake::pair_initiator(&phone, &secret).unwrap(), Handshake::pair_responder(&mac, &secret).unwrap()).unwrap();
        let big: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        let frames = a.seal(&big).unwrap();
        assert_eq!(frames.len(), 4);
        let mut got = None;
        for (i, f) in frames.iter().enumerate() {
            let out = b.open(f).unwrap();
            assert_eq!(out.is_some(), i == frames.len() - 1);
            got = out.or(got);
        }
        assert_eq!(got.unwrap(), big);
        // An empty message is a message too.
        let empty = a.seal(b"").unwrap();
        assert_eq!(b.open(&empty[0]).unwrap(), Some(vec![]));
    }

    #[test]
    fn a_tampered_dropped_or_replayed_frame_ends_the_channel() {
        let (mac, phone, secret) = pair();
        let ((_, mut a), (_, mut b)) = shake(Handshake::pair_initiator(&phone, &secret).unwrap(), Handshake::pair_responder(&mac, &secret).unwrap()).unwrap();
        let mut f = a.seal(b"allow").unwrap().remove(0);
        f[3] ^= 0x40;
        assert!(b.open(&f).is_err(), "tampered");
        let ((_, mut a), (_, mut b)) = shake(Handshake::pair_initiator(&phone, &secret).unwrap(), Handshake::pair_responder(&mac, &secret).unwrap()).unwrap();
        let first = a.seal(b"one").unwrap().remove(0);
        let second = a.seal(b"two").unwrap().remove(0);
        assert!(b.open(&second).is_err(), "out of order");
        let ((_, mut a), (_, mut b)) = shake(Handshake::pair_initiator(&phone, &secret).unwrap(), Handshake::pair_responder(&mac, &secret).unwrap()).unwrap();
        let once = a.seal(b"one").unwrap().remove(0);
        assert!(b.open(&once).is_ok());
        assert!(b.open(&once).is_err(), "replayed");
        let _ = first;
    }

    #[test]
    fn after_a_bad_frame_the_channel_refuses_even_good_ones() {
        let (mac, phone, secret) = pair();
        let ((_, mut a), (_, mut b)) = shake(Handshake::pair_initiator(&phone, &secret).unwrap(), Handshake::pair_responder(&mac, &secret).unwrap()).unwrap();
        let good = a.seal(b"one").unwrap().remove(0);
        let mut bad = good.clone();
        bad[0] ^= 1;
        assert!(b.open(&bad).is_err());
        assert!(b.open(&good).is_err(), "the frame that would have read now fails too");
        assert!(b.seal(b"x").is_err());
        assert!(b.open(&vec![0u8; NOISE_MAX + 1]).is_err());
    }

    #[test]
    fn a_message_bigger_than_the_limit_is_refused_both_ways() {
        let (mac, phone, secret) = pair();
        let ((_, mut a), (_, _)) = shake(Handshake::pair_initiator(&phone, &secret).unwrap(), Handshake::pair_responder(&mac, &secret).unwrap()).unwrap();
        assert!(a.seal(&vec![0u8; MAX_MESSAGE + 1]).is_err());
    }

    #[test]
    fn a_keypairs_private_half_never_shows_in_debug_output() {
        let k = generate_keypair().unwrap();
        let shown = format!("{k:?}");
        assert!(!shown.contains(&format!("{:?}", k.private)));
    }
}
