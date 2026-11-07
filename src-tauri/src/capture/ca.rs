//! The root certificate the phone trusts, and a certificate for each host minted from it as the phone's apps reach them.
//!
//! The root is kept in Lantern's capture folder (ca.pem, and ca-key.pem readable only by the user). When there's none yet
//! and Network Monitor's is on this Mac, that one is copied in, so a phone that already trusts Network Monitor's root
//! keeps working.

use rcgen::{BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair, KeyUsagePurpose, SerialNumber};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use time::{Duration, OffsetDateTime};

/// Past this many hosts the minted certificates are dropped and minted again as needed.
const MAX_CACHED: usize = 2000;

pub struct Authority {
    issuer: Issuer<'static, KeyPair>,
    /// The root, to hand to the phone.
    pub der: Vec<u8>,
    pub pem: String,
    /// One key for every host's certificate, as Network Monitor did: minting is then only a signature.
    leaf_key: KeyPair,
    configs: Mutex<HashMap<String, Arc<ServerConfig>>>,
}

impl Authority {
    /// The root in `dir`; else Network Monitor's from `legacy`, copied into `dir`; else a new one made there.
    pub fn load(dir: &Path, legacy: Option<&Path>) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("couldn't make {}: {e}", dir.display()))?;
        let (cert_path, key_path) = (dir.join("ca.pem"), dir.join("ca-key.pem"));
        let found = read_pair(dir).or_else(|| legacy.and_then(read_pair).inspect(|(pem, key)| write_pair(dir, pem, key).unwrap_or_default()));
        let (issuer, pem) = match found {
            Some((pem, key_pem)) => {
                let key = KeyPair::from_pem(&key_pem).map_err(|e| format!("{} doesn't read: {e}", key_path.display()))?;
                let issuer = Issuer::from_ca_cert_pem(&pem, key).map_err(|e| format!("{} doesn't read: {e}", cert_path.display()))?;
                (issuer, pem)
            }
            None => {
                let key = KeyPair::generate().map_err(|e| e.to_string())?;
                let params = root_params();
                let pem = params.self_signed(&key).map_err(|e| e.to_string())?.pem();
                write_pair(dir, &pem, &key.serialize_pem())?;
                (Issuer::new(params, key), pem)
            }
        };
        let der = CertificateDer::from_pem_slice(pem.as_bytes()).map_err(|e| format!("{} doesn't read: {e}", cert_path.display()))?.to_vec();
        Ok(Self { issuer, der, pem, leaf_key: KeyPair::generate().map_err(|e| e.to_string())?, configs: Mutex::new(HashMap::new()) })
    }

    /// The TLS setup that answers as `host` (a name or an IP address), minted the first time it's asked for.
    pub fn server_config(&self, host: &str) -> Result<Arc<ServerConfig>, String> {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        if let Some(config) = self.configs.lock().unwrap().get(&host) {
            return Ok(config.clone());
        }
        let cert = self.mint(&host)?;
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.leaf_key.serialize_der()));
        let mut config = ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(|e| e.to_string())?
            .with_no_client_auth()
            .with_single_cert(vec![cert, CertificateDer::from(self.der.clone())], key)
            .map_err(|e| e.to_string())?;
        // HTTP/1.1 only: what's read off the connection is served by an HTTP/1.1 server.
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let config = Arc::new(config);
        let mut configs = self.configs.lock().unwrap();
        if configs.len() >= MAX_CACHED {
            configs.clear();
        }
        configs.insert(host, config.clone());
        Ok(config)
    }

    fn mint(&self, host: &str) -> Result<CertificateDer<'static>, String> {
        let mut params = CertificateParams::new(vec![host.to_string()]).map_err(|e| format!("can't make a certificate for {host}: {e}"))?;
        params.distinguished_name = DistinguishedName::new();
        params.distinguished_name.push(DnType::CommonName, host);
        let now = OffsetDateTime::now_utc();
        params.not_before = now - Duration::hours(1);
        // Under the 825 days iOS allows a certificate from a root the user installed.
        params.not_after = now + Duration::days(397);
        params.serial_number = Some(serial());
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature, KeyUsagePurpose::KeyEncipherment];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.use_authority_key_identifier_extension = true;
        Ok(params.signed_by(&self.leaf_key, &self.issuer).map_err(|e| e.to_string())?.into())
    }
}

fn root_params() -> CertificateParams {
    let mut params = CertificateParams::default();
    params.distinguished_name = DistinguishedName::new();
    params.distinguished_name.push(DnType::CommonName, "Lantern Capture Root CA");
    params.distinguished_name.push(DnType::OrganizationName, "Lantern");
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let now = OffsetDateTime::now_utc();
    params.not_before = now - Duration::hours(1);
    params.not_after = now + Duration::days(10 * 365);
    params.serial_number = Some(serial());
    params
}

/// 16 random bytes, the top bit clear so it reads as a positive number.
fn serial() -> SerialNumber {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the system's random numbers");
    bytes[0] &= 0x7f;
    SerialNumber::from_slice(&bytes)
}

fn read_pair(dir: &Path) -> Option<(String, String)> {
    Some((std::fs::read_to_string(dir.join("ca.pem")).ok()?, std::fs::read_to_string(dir.join("ca-key.pem")).ok()?))
}

fn write_pair(dir: &Path, pem: &str, key: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::io::Write;
    let key_path = dir.join("ca-key.pem");
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&key_path).map_err(|e| format!("couldn't write {}: {e}", key_path.display()))?;
    file.write_all(key.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("ca.pem"), pem).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::ServerName;
    use std::path::PathBuf;

    /// A client that trusts only `root`.
    fn client(root: &[u8]) -> Arc<rustls::ClientConfig> {
        let mut roots = rustls::RootCertStore::empty();
        roots.add(CertificateDer::from(root.to_vec())).unwrap();
        Arc::new(rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider())).with_safe_default_protocol_versions().unwrap().with_root_certificates(roots).with_no_client_auth())
    }

    /// Runs a TLS handshake in memory: whether a client trusting the root accepts the certificate minted for `host`
    /// when it asks for `name`.
    fn handshake(ca: &Authority, host: &str, name: &str) -> Result<(), rustls::Error> {
        let mut server = rustls::ServerConnection::new(ca.server_config(host).unwrap()).unwrap();
        let mut client = rustls::ClientConnection::new(client(&ca.der), ServerName::try_from(name.to_string()).unwrap()).unwrap();
        for _ in 0..10 {
            let mut buf = Vec::new();
            client.write_tls(&mut buf).unwrap();
            server.read_tls(&mut &buf[..]).unwrap();
            server.process_new_packets()?;
            let mut buf = Vec::new();
            server.write_tls(&mut buf).unwrap();
            client.read_tls(&mut &buf[..]).unwrap();
            client.process_new_packets()?;
            if !client.is_handshaking() && !server.is_handshaking() {
                return Ok(());
            }
        }
        panic!("the handshake didn't finish");
    }

    #[test]
    fn a_minted_certificate_is_trusted_for_its_host_only() {
        let dir = tempfile::tempdir().unwrap();
        let ca = Authority::load(dir.path(), None).unwrap();
        handshake(&ca, "api.example.com", "api.example.com").unwrap();
        handshake(&ca, "10.1.2.3", "10.1.2.3").unwrap();
        assert!(handshake(&ca, "api.example.com", "other.example.com").is_err());
    }

    #[test]
    fn the_root_is_kept_and_its_key_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let first = Authority::load(dir.path(), None).unwrap();
        let again = Authority::load(dir.path(), None).unwrap();
        assert_eq!(first.der, again.der);
        handshake(&again, "example.com", "example.com").unwrap();
        assert_eq!(std::fs::metadata(dir.path().join("ca-key.pem")).unwrap().permissions().mode() & 0o777, 0o600);
    }

    /// The real Network Monitor root on this Mac (made by its Swift code), if there is one:
    /// `cargo test --lib capture::ca -- --ignored`.
    #[test]
    #[ignore]
    fn the_real_network_monitor_root_is_taken_over() {
        let legacy = PathBuf::from(std::env::var("HOME").unwrap()).join("Library/Application Support/NetworkMonitor");
        let dir = tempfile::tempdir().unwrap();
        let ours = Authority::load(dir.path(), Some(&legacy)).unwrap();
        let theirs = CertificateDer::from_pem_slice(&std::fs::read(legacy.join("ca.pem")).unwrap()).unwrap();
        assert_eq!(ours.der, theirs.to_vec());
        handshake(&ours, "api.rabbitmart.com", "api.rabbitmart.com").unwrap();
    }

    #[test]
    fn network_monitors_root_is_taken_over() {
        let legacy = tempfile::tempdir().unwrap();
        let theirs = Authority::load(legacy.path(), None).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let ours = Authority::load(dir.path(), Some(legacy.path())).unwrap();
        assert_eq!(ours.der, theirs.der);
        assert!(dir.path().join("ca-key.pem").exists());
        // Certificates minted by Lantern are trusted by a phone that trusts Network Monitor's root.
        let mut server = rustls::ServerConnection::new(ours.server_config("example.com").unwrap()).unwrap();
        let mut client = rustls::ClientConnection::new(client(&theirs.der), ServerName::try_from("example.com").unwrap()).unwrap();
        for _ in 0..10 {
            let mut buf = Vec::new();
            client.write_tls(&mut buf).unwrap();
            server.read_tls(&mut &buf[..]).unwrap();
            server.process_new_packets().unwrap();
            let mut buf = Vec::new();
            server.write_tls(&mut buf).unwrap();
            client.read_tls(&mut &buf[..]).unwrap();
            client.process_new_packets().unwrap();
        }
        assert!(!client.is_handshaking());
    }
}
