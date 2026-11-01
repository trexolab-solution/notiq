// ─── Breached-password check (Have I Been Pwned "Pwned Passwords", k-anonymity) ─
//
// The webview hashes each password locally and passes ONLY the first 5 hex characters of the SHA-1 here.
// We fetch https://api.pwnedpasswords.com/range/{prefix} (with `Add-Padding: true`) and hand the suffix list
// back; the comparison happens in the webview. Full hashes and passwords never reach this module.
//
use std::collections::HashSet;
use std::time::Duration;

use futures_util::{stream, StreamExt};
use serde::Serialize;

const RANGE_URL: &str = "https://api.pwnedpasswords.com/range/";
const MAX_PREFIXES: usize = 5000;
const CONCURRENCY: usize = 4;
const TIMEOUT: Duration = Duration::from_secs(10);

/// One breached-hash suffix (35 hex chars, upper-case) and how many times it was seen.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Hit {
    pub suffix: String,
    pub count: u64,
}

#[derive(Serialize, Debug)]
pub struct RangeResult {
    pub prefix: String,
    pub hits: Vec<Hit>,
}

/// Exactly 5 hex characters.
fn is_valid_prefix(p: &str) -> bool {
    p.len() == 5 && p.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Validates, upper-cases and de-duplicates prefixes (order preserved).
fn normalize_prefixes(prefixes: Vec<String>) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut list = Vec::new();
    for p in prefixes {
        if !is_valid_prefix(&p) {
            return Err("invalid-prefix".into());
        }
        let p = p.to_ascii_uppercase();
        if seen.insert(p.clone()) {
            list.push(p);
        }
    }
    if list.len() > MAX_PREFIXES {
        return Err("too-many-prefixes".into());
    }
    Ok(list)
}

/// Parses a range response (`SUFFIX:COUNT` lines). Padding lines (count 0) and malformed lines are ignored.
fn parse_range(body: &str) -> Vec<Hit> {
    body.lines()
        .filter_map(|line| {
            let (suffix, count) = line.trim().split_once(':')?;
            let count: u64 = count.trim().parse().ok()?;
            if count == 0 || suffix.len() != 35 || !suffix.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            Some(Hit { suffix: suffix.to_ascii_uppercase(), count })
        })
        .collect()
}

async fn fetch_range(client: &reqwest::Client, prefix: String) -> Result<RangeResult, String> {
    let resp = client
        .get(format!("{RANGE_URL}{prefix}"))
        .header("Add-Padding", "true")
        .send()
        .await
        .map_err(|_| "offline".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("service-error:{}", resp.status().as_u16()));
    }
    let body = resp.text().await.map_err(|_| "offline".to_string())?;
    Ok(RangeResult { prefix, hits: parse_range(&body) })
}

/// Looks up each distinct 5-hex-char prefix. Errors are `"offline"` (network/timeout) or `"service-error:<status>"`.
#[tauri::command]
pub async fn breach_check_ranges(prefixes: Vec<String>) -> Result<Vec<RangeResult>, String> {
    let list = normalize_prefixes(prefixes)?;
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent("Notiq")
        .build()
        .map_err(|_| "offline".to_string())?;
    let results: Vec<Result<RangeResult, String>> = stream::iter(list)
        .map(|p| fetch_range(&client, p))
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await;
    results.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0018A45C4D1DEF81644B54AB7F969B88D65";
    const B: &str = "00D4F6E8FA6EECAD2A3AA415EEC418D38EC";

    #[test]
    fn parses_hits_and_skips_padding() {
        let body = format!("{A}:21\r\n{B}:0\r\n{}:3\r\n", "1".repeat(35));
        let hits = parse_range(&body);
        assert_eq!(hits, vec![
            Hit { suffix: A.into(), count: 21 },
            Hit { suffix: "1".repeat(35), count: 3 },
        ]);
    }

    #[test]
    fn ignores_malformed_lines_and_uppercases() {
        let body = format!("garbage\n{}:5\nABC:7\n{A}:x\n", A.to_lowercase());
        let hits = parse_range(&body);
        assert_eq!(hits, vec![Hit { suffix: A.into(), count: 5 }]);
        assert!(parse_range("").is_empty());
    }

    #[test]
    fn prefix_validation() {
        assert!(is_valid_prefix("21BD1"));
        assert!(is_valid_prefix("abcdE"));
        assert!(!is_valid_prefix("21BD"));
        assert!(!is_valid_prefix("21BD12"));
        assert!(!is_valid_prefix("21BDG"));
        assert!(!is_valid_prefix(""));
        assert!(!is_valid_prefix("21BD/"));
    }

    #[test]
    fn normalizes_and_dedupes() {
        let r = normalize_prefixes(vec!["abcde".into(), "ABCDE".into(), "12345".into()]).unwrap();
        assert_eq!(r, vec!["ABCDE".to_string(), "12345".to_string()]);
        assert_eq!(normalize_prefixes(vec!["12345".into(), "zzzzz".into()]).err().as_deref(), Some("invalid-prefix"));
    }
}
