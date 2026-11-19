import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVaultImageCache, formatVaultImageRef, isVaultImageSrc, parseVaultImageRef, vaultImageMarkdown,
  VAULT_ATTACHMENT_ID_RE,
} from "./vaultImages";
import { attachmentLimitError } from "./attachmentLimits";
import { VAULT_ATTACH_MAX_BYTES, VAULT_ATTACH_MAX_PER_NOTE, VAULT_ATTACH_MAX_TOTAL } from "./vault";

const ID = "0123456789abcdef0123456789abcdef";

describe("vault image references", () => {
  it("formats and parses round-trip", () => {
    expect(formatVaultImageRef(ID)).toBe(`vault-attachment:${ID}`);
    expect(parseVaultImageRef(formatVaultImageRef(ID))).toBe(ID);
    expect(vaultImageMarkdown(ID)).toBe(`![pasted-image](vault-attachment:${ID})`);
  });

  it("refuses to format an invalid id", () => {
    expect(() => formatVaultImageRef("../etc")).toThrow();
    expect(() => formatVaultImageRef(ID.toUpperCase())).toThrow();
  });

  it("rejects malformed or foreign sources", () => {
    for (const src of [
      "assets/img-1.png", "https://x.test/a.png", "data:image/png;base64,AA", `vault-attachment:${ID}x`,
      "vault-attachment:", `vault-attachment:${ID.slice(1)}`, `vault-attachment:${ID}/../x`, `javascript:${ID}`,
    ]) expect(parseVaultImageRef(src)).toBeNull();
  });

  it("recognises the scheme case-insensitively even when the id is bad", () => {
    expect(isVaultImageSrc("VAULT-ATTACHMENT:nope")).toBe(true);
    expect(isVaultImageSrc("assets/vault-attachment:x")).toBe(false);
  });

  it("id pattern is anchored and has no global flag (safe for repeated .test)", () => {
    expect(VAULT_ATTACHMENT_ID_RE.flags).not.toContain("g");
    expect(VAULT_ATTACHMENT_ID_RE.test(`x${ID}`)).toBe(false);
  });
});

describe("pasted image limits", () => {
  it("allows an image that fits", () => {
    expect(attachmentLimitError(1000, 0, 0)).toBeNull();
  });
  it("explains each limit", () => {
    expect(attachmentLimitError(1000, VAULT_ATTACH_MAX_PER_NOTE, 0)).toMatch(/at most 20 attachments/);
    expect(attachmentLimitError(VAULT_ATTACH_MAX_BYTES + 1, 0, 0)).toMatch(/at most 5 MB each/);
    expect(attachmentLimitError(1000, 0, VAULT_ATTACH_MAX_TOTAL - 10)).toMatch(/Not enough attachment space/);
  });
});

describe("createVaultImageCache", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const setup = (load = vi.fn(async () => new Blob(["x"]))) => {
    let n = 0;
    const revoked: string[] = [];
    const cache = createVaultImageCache({
      load, createUrl: () => `blob:${++n}`, revokeUrl: (u) => revoked.push(u), revokeDelay: 100,
    });
    return { cache, load, revoked };
  };

  it("decrypts once for several users and revokes after the last release", async () => {
    const { cache, load, revoked } = setup();
    const [a, b] = await Promise.all([cache.acquire("p", ID), cache.acquire("p", ID)]);
    expect(a).toBe("blob:1");
    expect(b).toBe("blob:1");
    expect(load).toHaveBeenCalledTimes(1);
    cache.release("p", ID);
    await vi.advanceTimersByTimeAsync(200);
    expect(revoked).toEqual([]);
    cache.release("p", ID);
    await vi.advanceTimersByTimeAsync(200);
    expect(revoked).toEqual(["blob:1"]);
    expect(cache.size()).toBe(0);
  });

  it("keeps the URL when re-acquired within the delay (remount)", async () => {
    const { cache, load, revoked } = setup();
    await cache.acquire("p", ID);
    cache.release("p", ID);
    await vi.advanceTimersByTimeAsync(50);
    expect(await cache.acquire("p", ID)).toBe("blob:1");
    await vi.advanceTimersByTimeAsync(500);
    expect(revoked).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed load", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("locked")).mockResolvedValue(new Blob(["x"]));
    const { cache } = setup(load);
    await expect(cache.acquire("p", ID)).rejects.toThrow("locked");
    await Promise.resolve();
    expect(await cache.acquire("p", ID)).toBe("blob:1");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys by entry path, and clear revokes everything", async () => {
    const { cache, revoked } = setup();
    await cache.acquire("a", ID);
    await cache.acquire("b", ID);
    expect(cache.size()).toBe(2);
    cache.clear();
    await Promise.resolve();
    expect(revoked.sort()).toEqual(["blob:1", "blob:2"]);
    expect(cache.size()).toBe(0);
  });
});
