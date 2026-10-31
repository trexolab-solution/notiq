//! In-memory [`StorageProvider`] for tests, with fault injection.
//!
//! Every stored object keeps its full version history so tests can simulate a
//! stale or rolled-back server (`serve_stale`), which the engine's rollback
//! protection (P3) must detect.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;

use super::provider::{validate_name, Capabilities, ProviderError, RemoteObject, StorageProvider};

/// Default size limit, matching the Drive provider.
pub const DEFAULT_MAX_OBJECT_BYTES: u64 = 64 * 1024 * 1024;

/// Number of calls per operation (attempts, including failed ones).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CallCounts {
    pub list: u64,
    pub get: u64,
    pub put: u64,
    pub delete: u64,
}

impl CallCounts {
    pub fn total(&self) -> u64 {
        self.list + self.get + self.put + self.delete
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    List,
    Get,
    Put,
    Delete,
}

#[derive(Clone)]
struct Version {
    data: Arc<Vec<u8>>,
    rev: u64,
    modified_ms: i64,
}

#[derive(Default)]
struct State {
    /// name → versions, oldest first. The last one is the live content.
    objects: BTreeMap<String, Vec<Version>>,
    next_rev: u64,
    clock_ms: i64,
    counts: CallCounts,
    offline: bool,
    auth_expired: bool,
    rate_limited: Option<u64>,
    fail_next: VecDeque<ProviderError>,
    abort_puts: u32,
    /// name → how many versions back reads (get/list) are served from.
    stale: HashMap<String, usize>,
}

impl State {
    fn view(&self, name: &str) -> Option<&Version> {
        let versions = self.objects.get(name)?;
        let back = self.stale.get(name).copied().unwrap_or(0);
        versions.iter().rev().nth(back).or_else(|| versions.first())
    }
}

/// A [`StorageProvider`] that keeps everything in memory.
pub struct InMemoryProvider {
    caps: Capabilities,
    state: Mutex<State>,
}

impl Default for InMemoryProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemoryProvider {
    pub fn new() -> Self {
        Self::with_capabilities(Capabilities { overwrite: true, delete: true, max_object_bytes: DEFAULT_MAX_OBJECT_BYTES })
    }

    pub fn with_capabilities(caps: Capabilities) -> Self {
        Self { caps, state: Mutex::new(State { clock_ms: 1_700_000_000_000, ..State::default() }) }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    // ── fault injection ─────────────────────────────────────────────────────

    /// Every call fails with `Offline` until turned off.
    pub fn set_offline(&self, on: bool) {
        self.lock().offline = on;
    }

    /// Every call fails with `RateLimited { retry_after_s }` until `None`.
    pub fn set_rate_limited(&self, retry_after_s: Option<u64>) {
        self.lock().rate_limited = retry_after_s;
    }

    /// Every call fails with `Auth` until turned off (expired / revoked sign-in).
    pub fn set_auth_expired(&self, on: bool) {
        self.lock().auth_expired = on;
    }

    /// The next `n` calls (any operation) fail with `err`.
    pub fn fail_next(&self, n: usize, err: ProviderError) {
        let mut s = self.lock();
        for _ in 0..n {
            s.fail_next.push_back(err.clone());
        }
    }

    /// The next `n` puts are aborted mid-upload: they fail with `Offline` and the
    /// object keeps its previous content (or stays absent).
    pub fn abort_next_puts(&self, n: u32) {
        self.lock().abort_puts = n;
    }

    /// Reads of `name` (get and list) serve the version `versions_back` steps
    /// older than the live one (clamped to the oldest), simulating a stale cache
    /// or a server rolled back to an old copy. `0` clears it.
    pub fn serve_stale(&self, name: &str, versions_back: usize) {
        let mut s = self.lock();
        if versions_back == 0 {
            s.stale.remove(name);
        } else {
            s.stale.insert(name.to_string(), versions_back);
        }
    }

    /// Clear every injected fault (stored data is kept).
    pub fn clear_faults(&self) {
        let mut s = self.lock();
        s.offline = false;
        s.auth_expired = false;
        s.rate_limited = None;
        s.fail_next.clear();
        s.abort_puts = 0;
        s.stale.clear();
    }

    // ── inspection ──────────────────────────────────────────────────────────

    pub fn calls(&self) -> CallCounts {
        self.lock().counts
    }

    pub fn reset_calls(&self) {
        self.lock().counts = CallCounts::default();
    }

    /// Number of live objects.
    pub fn len(&self) -> usize {
        self.lock().objects.len()
    }

    /// Live content of `name`, bypassing faults and staleness.
    pub fn raw(&self, name: &str) -> Option<Vec<u8>> {
        self.lock().objects.get(name).and_then(|v| v.last()).map(|v| v.data.to_vec())
    }

    /// Number of versions ever written to `name` (live one included).
    pub fn version_count(&self, name: &str) -> usize {
        self.lock().objects.get(name).map_or(0, Vec::len)
    }

    // ── internals ───────────────────────────────────────────────────────────

    fn begin(&self, op: Op) -> Result<MutexGuard<'_, State>, ProviderError> {
        let mut s = self.lock();
        match op {
            Op::List => s.counts.list += 1,
            Op::Get => s.counts.get += 1,
            Op::Put => s.counts.put += 1,
            Op::Delete => s.counts.delete += 1,
        }
        if s.auth_expired {
            return Err(ProviderError::Auth);
        }
        if s.offline {
            return Err(ProviderError::Offline);
        }
        if let Some(retry_after_s) = s.rate_limited {
            return Err(ProviderError::RateLimited { retry_after_s });
        }
        if let Some(e) = s.fail_next.pop_front() {
            return Err(e);
        }
        Ok(s)
    }

    fn object(name: &str, v: &Version) -> RemoteObject {
        RemoteObject {
            name: name.to_string(),
            size: v.data.len() as u64,
            revision: format!("r{}", v.rev),
            modified_ms: Some(v.modified_ms),
        }
    }
}

#[async_trait]
impl StorageProvider for InMemoryProvider {
    fn id(&self) -> &'static str {
        "memory"
    }

    fn capabilities(&self) -> Capabilities {
        self.caps
    }

    async fn list(&self, prefix: &str) -> Result<Vec<RemoteObject>, ProviderError> {
        let s = self.begin(Op::List)?;
        Ok(s.objects
            .keys()
            .filter(|n| n.starts_with(prefix))
            .filter_map(|n| s.view(n).map(|v| Self::object(n, v)))
            .collect())
    }

    async fn get(&self, name: &str) -> Result<Vec<u8>, ProviderError> {
        validate_name(name)?;
        let s = self.begin(Op::Get)?;
        s.view(name).map(|v| v.data.to_vec()).ok_or(ProviderError::NotFound)
    }

    async fn put(&self, name: &str, data: &[u8]) -> Result<RemoteObject, ProviderError> {
        validate_name(name)?;
        let mut s = self.begin(Op::Put)?;
        if data.len() as u64 > self.caps.max_object_bytes {
            return Err(ProviderError::TooLarge);
        }
        if !self.caps.overwrite && s.objects.contains_key(name) {
            return Err(ProviderError::Other("This storage can't overwrite objects".into()));
        }
        if s.abort_puts > 0 {
            s.abort_puts -= 1;
            return Err(ProviderError::Offline);
        }
        s.next_rev += 1;
        s.clock_ms += 1;
        let v = Version { data: Arc::new(data.to_vec()), rev: s.next_rev, modified_ms: s.clock_ms };
        let obj = Self::object(name, &v);
        s.objects.entry(name.to_string()).or_default().push(v);
        Ok(obj)
    }

    async fn delete(&self, name: &str) -> Result<(), ProviderError> {
        validate_name(name)?;
        let mut s = self.begin(Op::Delete)?;
        if !self.caps.delete {
            return Err(ProviderError::Other("This storage can't delete objects".into()));
        }
        s.stale.remove(name);
        s.objects.remove(name).map(|_| ()).ok_or(ProviderError::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::contract_tests::{block_on, run_contract};

    #[test]
    fn in_memory_provider_passes_the_contract() {
        let p = InMemoryProvider::new();
        block_on(run_contract(&p, "ct/"));
        assert_eq!(p.len(), 0, "contract suite cleans up after itself");
        assert!(p.calls().total() > 20);
    }

    #[test]
    fn small_limit_reports_too_large() {
        let p = InMemoryProvider::with_capabilities(Capabilities { overwrite: true, delete: true, max_object_bytes: 4 });
        block_on(async {
            assert!(p.put("a", b"1234").await.is_ok());
            assert_eq!(p.put("a", b"12345").await, Err(ProviderError::TooLarge));
            assert_eq!(p.get("a").await.unwrap(), b"1234");
        });
    }

    #[test]
    fn offline_rate_limit_and_auth_faults() {
        let p = InMemoryProvider::new();
        block_on(async {
            p.put("a", b"x").await.unwrap();
            p.set_offline(true);
            assert_eq!(p.get("a").await, Err(ProviderError::Offline));
            assert_eq!(p.list("").await, Err(ProviderError::Offline));
            p.set_offline(false);
            p.set_rate_limited(Some(9));
            assert_eq!(p.put("a", b"y").await, Err(ProviderError::RateLimited { retry_after_s: 9 }));
            p.set_rate_limited(None);
            p.set_auth_expired(true);
            assert_eq!(p.delete("a").await, Err(ProviderError::Auth));
            p.clear_faults();
            assert_eq!(p.get("a").await.unwrap(), b"x");
        });
        assert_eq!(p.calls(), CallCounts { list: 1, get: 2, put: 2, delete: 1 });
        p.reset_calls();
        assert_eq!(p.calls().total(), 0);
    }

    #[test]
    fn fail_next_n_calls_then_recover() {
        let p = InMemoryProvider::new();
        p.fail_next(2, ProviderError::Other("boom".into()));
        block_on(async {
            assert!(p.put("a", b"1").await.is_err());
            assert!(p.list("").await.is_err());
            assert!(p.put("a", b"1").await.is_ok());
        });
        assert_eq!(p.version_count("a"), 1);
    }

    #[test]
    fn aborted_put_never_leaves_a_torn_object() {
        let p = InMemoryProvider::new();
        block_on(async {
            p.abort_next_puts(1);
            assert_eq!(p.put("new", b"data").await, Err(ProviderError::Offline));
            assert_eq!(p.get("new").await, Err(ProviderError::NotFound));

            p.put("old", b"v1").await.unwrap();
            p.abort_next_puts(1);
            assert!(p.put("old", b"v2-partial").await.is_err());
            assert_eq!(p.get("old").await.unwrap(), b"v1");
            assert_eq!(p.put("old", b"v2").await.unwrap().size, 2);
            assert_eq!(p.get("old").await.unwrap(), b"v2");
        });
    }

    #[test]
    fn stale_reads_serve_an_older_version() {
        let p = InMemoryProvider::new();
        block_on(async {
            let r1 = p.put("devices/a.nqs", b"gen1").await.unwrap();
            p.put("devices/a.nqs", b"gen2").await.unwrap();
            let r3 = p.put("devices/a.nqs", b"gen3").await.unwrap();
            p.serve_stale("devices/a.nqs", 1);
            assert_eq!(p.get("devices/a.nqs").await.unwrap(), b"gen2");
            p.serve_stale("devices/a.nqs", 99);
            assert_eq!(p.get("devices/a.nqs").await.unwrap(), b"gen1");
            assert_eq!(p.list("devices/").await.unwrap()[0].revision, r1.revision);
            p.serve_stale("devices/a.nqs", 0);
            assert_eq!(p.list("devices/").await.unwrap()[0].revision, r3.revision);
            assert_eq!(p.raw("devices/a.nqs").unwrap(), b"gen3");
        });
    }

    #[test]
    fn backup_only_capabilities_are_enforced() {
        let p = InMemoryProvider::with_capabilities(Capabilities { overwrite: false, delete: false, max_object_bytes: 1024 });
        block_on(async {
            p.put("a", b"1").await.unwrap();
            assert!(matches!(p.put("a", b"2").await, Err(ProviderError::Other(_))));
            assert!(matches!(p.delete("a").await, Err(ProviderError::Other(_))));
            assert_eq!(p.get("a").await.unwrap(), b"1");
        });
    }
}
