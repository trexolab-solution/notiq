//! HTTPS for WebDAV sharing: a self-signed certificate made by Notiq for this computer's address, so the connection
//! between the phone and this computer is encrypted. A self-signed certificate is not vouched for by anyone, so a
//! browser warns the first time: the sharing panel shows the certificate's SHA-256 fingerprint, and the phone's
//! certificate details should show the same one before continuing.
//!
//! The certificate and its key are kept in the app's data folder (so the phone is not warned again and again) and are
//! made anew when this computer's address changes or after 300 days. The key is only ever used by this server.

use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;

use base64::Engine as _;
use sha2::{Digest, Sha256};
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::rustls::ServerConfig;

/// How long a certificate is reused before a new one is made.
const KEEP_DAYS: i64 = 300;
/// How long a new certificate is valid.
const VALID_DAYS: i64 = 365;

/// The calendar date (year, month, day) of a Unix time, in UTC.
pub fn ymd(unix_secs: i64) -> (i32, u8, u8) {
    let z = unix_secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u8;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
    let y = (yoe + era * 400 + if m <= 2 { 1 } else { 0 }) as i32;
    (y, m, d)
}

/// A new self-signed certificate and its private key, as PEM, valid for `ip`, `localhost` and `127.0.0.1`.
pub fn make_cert(ip: IpAddr, now: i64) -> Result<(String, String), String> {
    let mut names = vec![ip.to_string(), "localhost".to_string(), "127.0.0.1".to_string()];
    names.dedup();
    let mut params = rcgen::CertificateParams::new(names).map_err(|e| format!("Couldn't make the certificate: {e}"))?;
    params.distinguished_name.push(rcgen::DnType::CommonName, "Notiq WebDAV");
    let (y, m, d) = ymd(now - 86_400);
    params.not_before = rcgen::date_time_ymd(y, m, d);
    let (y, m, d) = ymd(now + VALID_DAYS * 86_400);
    params.not_after = rcgen::date_time_ymd(y, m, d);
    let key = rcgen::KeyPair::generate().map_err(|e| format!("Couldn't make the certificate: {e}"))?;
    let cert = params.self_signed(&key).map_err(|e| format!("Couldn't make the certificate: {e}"))?;
    Ok((cert.pem(), key.serialize_pem()))
}

/// The bytes inside a PEM block (`-----BEGIN …-----` … `-----END …-----`).
pub fn pem_der(pem: &str) -> Option<Vec<u8>> {
    let body: String = pem.lines().filter(|l| !l.trim_start().starts_with("-----")).map(str::trim).collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok().filter(|d| !d.is_empty())
}

/// `AB:CD:…`: the SHA-256 of a certificate, the way browsers show it.
pub fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// The TLS settings for a certificate and key (PEM), and the certificate's fingerprint.
pub fn server_config(cert_pem: &str, key_pem: &str) -> Result<(Arc<ServerConfig>, String), String> {
    let cert = pem_der(cert_pem).ok_or("The saved certificate can't be read.")?;
    let key = pem_der(key_pem).ok_or("The saved key can't be read.")?;
    let fp = fingerprint(&cert);
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("HTTPS isn't available: {e}"))?
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(cert)], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)))
        .map_err(|e| format!("The certificate doesn't fit its key: {e}"))?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok((Arc::new(config), fp))
}

/// Whether the notes saved with a certificate say it is still good for `ip` at `now`.
fn meta_ok(meta: &str, ip: IpAddr, now: i64) -> bool {
    let mut lines = meta.lines();
    let same_ip = lines.next().map(str::trim) == Some(ip.to_string().as_str());
    let age_ok = lines.next().and_then(|l| l.trim().parse::<i64>().ok()).is_some_and(|made| now >= made && now - made < KEEP_DAYS * 86_400);
    same_ip && age_ok
}

/// The saved certificate for `ip` (made anew when there is none, it is for another address or it is old).
pub fn load_or_make(dir: &Path, ip: IpAddr, now: i64) -> Result<(Arc<ServerConfig>, String), String> {
    let (cert_path, key_path, meta_path) = (dir.join("cert.pem"), dir.join("key.pem"), dir.join("meta.txt"));
    if let (Ok(cert), Ok(key), Ok(meta)) = (std::fs::read_to_string(&cert_path), std::fs::read_to_string(&key_path), std::fs::read_to_string(&meta_path)) {
        if meta_ok(&meta, ip, now) {
            if let Ok(found) = server_config(&cert, &key) { return Ok(found); }
        }
    }
    let (cert, key) = make_cert(ip, now)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't save the certificate: {e}"))?;
    write_private(&key_path, &key).map_err(|e| format!("Couldn't save the certificate: {e}"))?;
    std::fs::write(&cert_path, &cert).and_then(|_| std::fs::write(&meta_path, format!("{ip}\n{now}\n"))).map_err(|e| format!("Couldn't save the certificate: {e}"))?;
    server_config(&cert, &key)
}

/// Writes the key readable by this user only (on systems that have such permissions).
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
        return f.write_all(text.as_bytes());
    }
    #[cfg(not(unix))]
    std::fs::write(path, text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const IP: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(192, 168, 1, 15));

    #[test]
    fn dates_come_from_unix_time() {
        assert_eq!(ymd(0), (1970, 1, 1));
        assert_eq!(ymd(951_782_400), (2000, 2, 29));
        assert_eq!(ymd(1_700_000_000), (2023, 11, 14));
        assert_eq!(ymd(1_700_000_000 - 86_400 * 365), (2022, 11, 14));
        assert_eq!(ymd(-1), (1969, 12, 31));
    }

    #[test]
    fn a_made_certificate_has_a_fingerprint_and_a_working_config() {
        let (cert, key) = make_cert(IP, 1_700_000_000).unwrap();
        assert!(cert.contains("BEGIN CERTIFICATE") && key.contains("PRIVATE KEY"));
        let (_, fp) = server_config(&cert, &key).unwrap();
        assert_eq!(fp.len(), 32 * 3 - 1);
        assert!(fp.split(':').all(|b| b.len() == 2 && b.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase())));
        assert_eq!(fp, fingerprint(&pem_der(&cert).unwrap()));
    }

    #[test]
    fn a_certificate_does_not_fit_another_key() {
        let (cert, _) = make_cert(IP, 1_700_000_000).unwrap();
        let (_, other_key) = make_cert(IP, 1_700_000_000).unwrap();
        assert!(server_config(&cert, &other_key).is_err());
        assert!(server_config("junk", "junk").is_err());
    }

    #[test]
    fn a_saved_certificate_is_reused_until_the_address_changes_or_it_gets_old() {
        let dir = std::env::temp_dir().join(format!("notiq-tls-{}", rand::random::<u32>()));
        let now = 1_700_000_000;
        let (_, first) = load_or_make(&dir, IP, now).unwrap();
        assert_eq!(load_or_make(&dir, IP, now + 86_400).unwrap().1, first, "same address, young: reused");
        let other = IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 7));
        let (_, second) = load_or_make(&dir, other, now + 86_400).unwrap();
        assert_ne!(second, first, "another address: made anew");
        assert_ne!(load_or_make(&dir, other, now + 86_400 + 301 * 86_400).unwrap().1, second, "older than 300 days: made anew");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn notes_about_a_certificate_are_checked() {
        assert!(meta_ok("192.168.1.15\n100\n", IP, 200));
        assert!(!meta_ok("192.168.1.16\n100\n", IP, 200));
        assert!(!meta_ok("192.168.1.15\n100\n", IP, 100 + 301 * 86_400));
        assert!(!meta_ok("192.168.1.15\n999\n", IP, 200), "made in the future");
        assert!(!meta_ok("", IP, 200));
    }
}
