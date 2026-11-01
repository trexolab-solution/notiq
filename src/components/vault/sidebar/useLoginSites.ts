import { useEffect, useRef, useState } from "react";
import { LOGIN_EXT, parseLogin } from "../../../lib/loginEntry";
import { normRel, toFull } from "../../../lib/vaultTree";
import { siteInfoOf, type LoginSite } from "../../../lib/vaultSites";
import { vaultReadFile, type VaultItem } from "../../../lib/vault";

const BATCH = 8;

/**
 * Sites and usernames of the vault's logins, for sidebar search and grouping. The listing itself
 * only carries names/tags, so each login is decrypted once (the backend only answers while the
 * vault is unlocked) and reduced to hosts + username — the password never leaves the read call.
 * Results are cached per entry and only re-read when its modified time changes. Keyed by lower-case rel.
 */
export function useLoginSites(root: string, items: VaultItem[], unlocked: boolean): Map<string, LoginSite> {
  const [sites, setSites] = useState<Map<string, LoginSite>>(() => new Map());
  const cache = useRef(new Map<string, { updated: number; site: LoginSite | null }>());

  useEffect(() => {
    if (!unlocked || !root) {
      cache.current.clear();
      setSites((prev) => (prev.size ? new Map() : prev));
      return;
    }
    let cancelled = false;
    const logins = items.filter((i) => !i.dir && (i.ext || "").toLowerCase() === LOGIN_EXT);
    const live = new Set(logins.map((i) => normRel(i.rel).toLowerCase()));
    for (const k of [...cache.current.keys()]) if (!live.has(k)) cache.current.delete(k);

    const snapshot = () => {
      const m = new Map<string, LoginSite>();
      for (const [k, v] of cache.current) if (v.site) m.set(k, v.site);
      return m;
    };
    const stale = logins.filter((i) => cache.current.get(normRel(i.rel).toLowerCase())?.updated !== i.updated);

    void (async () => {
      for (let b = 0; b < stale.length && !cancelled; b += BATCH) {
        await Promise.all(stale.slice(b, b + BATCH).map(async (i) => {
          const key = normRel(i.rel).toLowerCase();
          try {
            const f = await vaultReadFile(toFull(root, i.rel));
            cache.current.set(key, { updated: i.updated, site: f.ext === LOGIN_EXT ? siteInfoOf(parseLogin(f.content)) : null });
          } catch { /* locked or unreadable: leave it out */ }
        }));
        if (!cancelled) setSites(snapshot());
      }
      if (!cancelled && stale.length === 0) setSites(snapshot());
    })();
    return () => { cancelled = true; };
  }, [root, items, unlocked]);

  return sites;
}
