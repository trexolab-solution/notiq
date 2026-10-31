//! The shared contract every [`StorageProvider`] must pass.
//!
//! `run_contract` works on any provider and only touches names under the given
//! namespace prefix, cleaning up after itself, so it can run against a real
//! account (see `gdrive::tests::drive_contract_live`).

use super::provider::{ProviderError, RemoteObject, StorageProvider};

/// Run a future to completion on a fresh single-threaded runtime.
pub fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(f)
}

fn names(objs: &[RemoteObject]) -> Vec<&str> {
    objs.iter().map(|o| o.name.as_str()).collect()
}

/// Deterministic pseudo-random bytes (xorshift), so large payloads aren't all zeros.
pub fn pattern(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

/// Exercise the full provider contract under `ns` (e.g. `"ct-1234/"`).
pub async fn run_contract<P: StorageProvider + ?Sized>(p: &P, ns: &str) {
    let caps = p.capabilities();
    let n = |s: &str| format!("{ns}{s}");
    assert!(p.list(ns).await.unwrap().is_empty(), "namespace {ns} must start empty");

    // put / get roundtrip
    let meta = n("vault.meta");
    let obj = p.put(&meta, b"hello").await.unwrap();
    assert_eq!((obj.name.as_str(), obj.size), (meta.as_str(), 5));
    assert!(!obj.revision.is_empty());
    assert_eq!(p.get(&meta).await.unwrap(), b"hello");

    // overwrite semantics
    if caps.overwrite {
        let obj2 = p.put(&meta, b"hello, again").await.unwrap();
        assert_eq!(obj2.size, 12);
        assert_ne!(obj2.revision, obj.revision, "revision changes on overwrite");
        assert_eq!(p.get(&meta).await.unwrap(), b"hello, again");
        let listed = p.list(&meta).await.unwrap();
        assert_eq!(listed.len(), 1, "overwrite never duplicates");
        assert_eq!((listed[0].size, listed[0].revision.as_str()), (12, obj2.revision.as_str()));
    }

    // list by prefix (names with `/`)
    let (da, db, blob) = (n("devices/a.nqs"), n("devices/b.nqs"), n("blobs/9f86d081884c7d65"));
    p.put(&db, b"B").await.unwrap();
    p.put(&da, b"A").await.unwrap();
    p.put(&blob, b"blob").await.unwrap();
    assert_eq!(names(&p.list(&n("devices/")).await.unwrap()), vec![da.as_str(), db.as_str()]);
    assert_eq!(names(&p.list(&n("blobs/")).await.unwrap()), vec![blob.as_str()]);
    assert_eq!(names(&p.list(&n("dev")).await.unwrap()).len(), 2, "plain string-prefix semantics");
    assert!(p.list(&n("nothing/")).await.unwrap().is_empty());
    let all = p.list(ns).await.unwrap();
    assert_eq!(names(&all), vec![blob.as_str(), da.as_str(), db.as_str(), meta.as_str()], "sorted by name");
    let a = all.iter().find(|o| o.name == da).unwrap();
    assert_eq!(a.size, 1);

    // missing objects
    let missing = n("devices/missing.nqs");
    assert_eq!(p.get(&missing).await, Err(ProviderError::NotFound));
    if caps.delete {
        assert_eq!(p.delete(&missing).await, Err(ProviderError::NotFound));
    }

    // delete, then list
    if caps.delete {
        p.delete(&da).await.unwrap();
        assert_eq!(names(&p.list(&n("devices/")).await.unwrap()), vec![db.as_str()]);
        assert_eq!(p.get(&da).await, Err(ProviderError::NotFound));
        assert_eq!(p.delete(&da).await, Err(ProviderError::NotFound));
    }

    // empty and binary payloads
    let empty = n("blobs/empty");
    assert_eq!(p.put(&empty, b"").await.unwrap().size, 0);
    assert_eq!(p.get(&empty).await.unwrap(), Vec::<u8>::new());
    let bin = n("blobs/binary");
    let all_bytes: Vec<u8> = (0..=255u8).chain((0..=255u8).rev()).collect();
    p.put(&bin, &all_bytes).await.unwrap();
    assert_eq!(p.get(&bin).await.unwrap(), all_bytes);

    // deep names
    let deep = n("a/b/c/d.e-f_g");
    p.put(&deep, b"deep").await.unwrap();
    assert_eq!(p.get(&deep).await.unwrap(), b"deep");

    // large-ish object (crosses the Drive resumable-upload threshold)
    let big_len = (6 * 1024 * 1024 + 123).min(caps.max_object_bytes as usize);
    let big = pattern(big_len, 0x5eed);
    let big_name = n("blobs/large");
    assert_eq!(p.put(&big_name, &big).await.unwrap().size, big_len as u64);
    assert!(p.get(&big_name).await.unwrap() == big, "large object roundtrips intact");

    // size limit
    let too_big = vec![0u8; caps.max_object_bytes as usize + 1];
    assert_eq!(p.put(&n("blobs/too-big"), &too_big).await, Err(ProviderError::TooLarge));
    drop(too_big);
    assert_eq!(p.get(&n("blobs/too-big")).await, Err(ProviderError::NotFound));

    // invalid names are rejected, not mangled
    for bad in ["", "/abs", "a//b", "../x", "with space"] {
        assert!(matches!(p.put(bad, b"x").await, Err(ProviderError::Other(_))), "{bad:?}");
        assert!(matches!(p.get(bad).await, Err(ProviderError::Other(_))), "{bad:?}");
    }

    // clean up
    if caps.delete {
        for o in p.list(ns).await.unwrap() {
            p.delete(&o.name).await.unwrap();
        }
        assert!(p.list(ns).await.unwrap().is_empty());
    }
}
