import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as N from "./notifications";
import { toast } from "./toast";

const state = () => N.getState();
const shownMessages = () => state().toasts.map((t) => t.message);

beforeEach(() => {
  vi.useFakeTimers();
  N.__resetForTests();
});
afterEach(() => {
  N.__resetForTests();
  vi.useRealTimers();
});

describe("backward-compatible toast API", () => {
  it("accepts a bare message and returns an id", () => {
    const id = toast.info("Saved");
    expect(typeof id).toBe("string");
    expect(shownMessages()).toEqual(["Saved"]);
  });

  it("treats a number second arg as the duration", () => {
    toast.warning("Careful", 1500);
    vi.advanceTimersByTime(1499);
    expect(shownMessages()).toEqual(["Careful"]);
    vi.advanceTimersByTime(1);
    expect(shownMessages()).toEqual([]);
  });

  it("subscribe receives the on-screen list and unsubscribes", () => {
    const seen: number[] = [];
    const off = toast.subscribe((items) => seen.push(items.length));
    toast.success("a");
    off();
    toast.success("b");
    expect(seen).toEqual([0, 1]);
  });

  it("dismiss removes from screen but keeps the history entry", () => {
    const id = toast.error("Boom");
    toast.dismiss(id);
    expect(state().toasts).toHaveLength(0);
    expect(state().history.map((n) => n.message)).toEqual(["Boom"]);
  });

  it("remove drops it from history too", () => {
    const id = toast.info("Working…", 120000);
    toast.remove(id);
    expect(state().history).toHaveLength(0);
  });
});

describe("default durations per type", () => {
  it.each([
    ["success", 4000],
    ["info", 4000],
    ["warning", 7000],
    ["error", 9000],
  ] as const)("%s auto-dismisses after %i ms", (type, ms) => {
    toast[type]("x");
    vi.advanceTimersByTime(ms - 1);
    expect(state().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(state().toasts).toHaveLength(0);
  });

  it("duration 0 is sticky", () => {
    toast.info("Stay", { duration: 0 });
    vi.advanceTimersByTime(10 * 60_000);
    expect(shownMessages()).toEqual(["Stay"]);
  });
});

describe("dedupe", () => {
  it("folds an identical on-screen notification into a ×N counter and restarts its timer", () => {
    const a = toast.success("Copied");
    vi.advanceTimersByTime(3000);
    const b = toast.success("Copied");
    expect(b).toBe(a);
    expect(state().toasts).toHaveLength(1);
    expect(state().toasts[0].count).toBe(2);
    vi.advanceTimersByTime(3999);
    expect(state().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(state().toasts).toHaveLength(0);
  });

  it("does not fold different types or messages", () => {
    toast.success("Copied");
    toast.info("Copied");
    toast.success("Pasted");
    expect(state().toasts).toHaveLength(3);
  });

  it("does not fold into a dismissed one", () => {
    const a = toast.success("Copied");
    toast.dismiss(a);
    const b = toast.success("Copied");
    expect(b).not.toBe(a);
  });
});

describe("update by id", () => {
  it("same id updates in place instead of adding", () => {
    toast.info("Syncing 1/3", { id: "sync", duration: 0, progress: 0.33 });
    toast.info("Syncing 2/3", { id: "sync", duration: 0, progress: 0.66 });
    expect(state().history).toHaveLength(1);
    expect(state().toasts[0].message).toBe("Syncing 2/3");
    expect(state().toasts[0].progress).toBeCloseTo(0.66);
  });

  it("toast.update patches fields and can set a new duration", () => {
    const id = toast.info("Exporting…", { duration: 0, progress: 0 });
    toast.update(id, { progress: 1.5, message: "Exported", type: "success", duration: 2000 });
    const n = state().toasts[0];
    expect(n.message).toBe("Exported");
    expect(n.type).toBe("success");
    expect(n.progress).toBe(1); // clamped
    vi.advanceTimersByTime(2000);
    expect(state().toasts).toHaveLength(0);
  });

  it("update of an unknown id is a no-op", () => {
    expect(() => toast.update("nope", { message: "x" })).not.toThrow();
    expect(state().history).toHaveLength(0);
  });
});

describe("pause / resume", () => {
  it("freezes the countdown while hovered and resumes with the time left", () => {
    const id = toast.info("Hover me"); // 4000
    vi.advanceTimersByTime(3000);
    N.pause(id);
    vi.advanceTimersByTime(60_000);
    expect(state().toasts).toHaveLength(1);
    N.resume(id);
    vi.advanceTimersByTime(999);
    expect(state().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(state().toasts).toHaveLength(0);
  });

  it("notifications with actions or detail stay until hovered away, then 10 s", () => {
    const id = toast.warning("Pick a model", { actions: [{ label: "Open Settings", onClick: () => {} }] });
    vi.advanceTimersByTime(5 * 60_000);
    expect(state().toasts).toHaveLength(1);
    N.pause(id);
    N.resume(id);
    vi.advanceTimersByTime(N.KEEP_ALIVE_AFTER_LEAVE - 1);
    expect(state().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(state().toasts).toHaveLength(0);

    const d = toast.error("Backup failed", { detail: "EACCES: permission denied" });
    vi.advanceTimersByTime(60_000);
    expect(state().toasts.map((t) => t.id)).toEqual([d]);
  });

  it("an explicit duration overrides keep-alive", () => {
    toast.info("x", { duration: 1000, actions: [{ label: "Go", onClick: () => {} }] });
    vi.advanceTimersByTime(1000);
    expect(state().toasts).toHaveLength(0);
  });

  it("runAction calls the handler and dismisses", () => {
    const onClick = vi.fn();
    const id = toast.warning("x", { actions: [{ label: "Go", onClick }] });
    N.runAction(id, state().toasts[0].actions![0]);
    expect(onClick).toHaveBeenCalledOnce();
    expect(state().toasts).toHaveLength(0);
  });
});

describe("max visible + overflow", () => {
  it("shows at most 3 and counts the rest; overflowed ones do not count down", () => {
    for (const m of ["a", "b", "c", "d", "e"]) toast.info(m);
    expect(shownMessages()).toEqual(["c", "d", "e"]);
    expect(state().overflow).toBe(2);
    // The shown three expire; the waiting two get their full time once promoted.
    vi.advanceTimersByTime(4000);
    expect(shownMessages()).toEqual(["a", "b"]);
    expect(state().overflow).toBe(0);
    vi.advanceTimersByTime(3999);
    expect(shownMessages()).toEqual(["a", "b"]);
    vi.advanceTimersByTime(1);
    expect(shownMessages()).toEqual([]);
  });
});

describe("history + unread", () => {
  it("caps history at 100, newest first", () => {
    for (let i = 0; i < 130; i++) toast.info(`m${i}`, { silent: true });
    expect(state().history).toHaveLength(N.HISTORY_CAP);
    expect(state().history[0].message).toBe("m129");
    expect(state().history.at(-1)!.message).toBe("m30");
  });

  it("counts unread and opening the center marks all read", () => {
    toast.info("a");
    toast.error("b");
    expect(state().unread).toBe(2);
    N.setCenterOpen(true);
    expect(state().unread).toBe(0);
    toast.info("c"); // arrives while the center is open
    expect(state().unread).toBe(0);
    N.setCenterOpen(false);
    toast.info("d");
    expect(state().unread).toBe(1);
  });

  it("clear empties screen and history", () => {
    toast.info("a");
    toast.info("b", { silent: true });
    toast.clear();
    expect(state().history).toHaveLength(0);
    expect(state().toasts).toHaveLength(0);
    expect(state().unread).toBe(0);
  });
});

describe("silent + do not disturb", () => {
  it("silent records without popping up", () => {
    toast.success("Synced", { silent: true, source: "Vault" });
    expect(state().toasts).toHaveLength(0);
    expect(state().history[0]).toMatchObject({ message: "Synced", source: "Vault", read: false });
    expect(state().unread).toBe(1);
  });

  it("DND suppresses every pop-up (errors included) but still records and counts", () => {
    N.setDnd(true);
    toast.error("Failed");
    toast.info("Hi");
    expect(state().toasts).toHaveLength(0);
    expect(state().history).toHaveLength(2);
    expect(state().unread).toBe(2);
    expect(state().dnd).toBe(true);
    N.setDnd(false);
    toast.info("Back");
    expect(shownMessages()).toEqual(["Back"]);
  });
});

describe("formatRelative", () => {
  it("formats coarse relative times", () => {
    const now = 1_000_000_000;
    expect(N.formatRelative(now - 5_000, now)).toBe("just now");
    expect(N.formatRelative(now - 2 * 60_000, now)).toBe("2 min ago");
    expect(N.formatRelative(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(N.formatRelative(now - 26 * 3_600_000, now)).toBe("yesterday");
  });
});
