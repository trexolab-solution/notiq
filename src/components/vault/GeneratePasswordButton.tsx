import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dices, SlidersHorizontal } from "lucide-react";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { TypeToConfirmDialog } from "./TypeToConfirmDialog";
import { useClickOutside } from "../../hooks/useClickOutside";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { generateWithOptions, type PwOptions } from "../../lib/passwordGen";
import { PW_PREFS_EVENT, getPwAsk, getPwOptions, setPwAsk, setPwOptions } from "../../lib/vaultPrefs";
import { PasswordOptionsForm } from "./PasswordOptionsForm";

const POPUP_W = 288;

/**
 * "Generate" for a password field. By default it opens a small popup to pick what the
 * password contains; ticking "Remember my choice" makes later clicks generate instantly,
 * and a ⚙ button (plus Settings → Vault) brings the options back.
 * When the field already holds a password (`current`), replacing it takes a typed confirmation.
 */
export function GeneratePasswordButton({ onGenerate, current, compact }: {
  onGenerate: (password: string) => void;
  /** Icon-only, for inside an input's right edge. */
  compact?: boolean;
  /** The field's current value; a non-empty one asks before it is replaced. */
  current?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PwOptions | null>(null);
  const [ask, setAsk] = useState(getPwAsk);
  const [opts, setOpts] = useState<PwOptions>(getPwOptions);
  const [remember, setRemember] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLDivElement>(null);

  // Stay in sync with the Settings page.
  useEffect(() => {
    const sync = () => { setAsk(getPwAsk()); setOpts(getPwOptions()); };
    window.addEventListener(PW_PREFS_EVENT, sync);
    return () => window.removeEventListener(PW_PREFS_EVENT, sync);
  }, []);

  // Beside the button, inside the window: below it, else above it, else pinned to the top (the popup then
  // scrolls inside itself). Follows the button when the form scrolls or the window is resized.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      if (!trigger.current) return;
      const r = trigger.current.getBoundingClientRect();
      const M = 8;
      const left = Math.max(M, Math.min(r.right - POPUP_W, window.innerWidth - POPUP_W - M));
      const h = Math.min(popup.current?.scrollHeight ?? 300, window.innerHeight - 2 * M);
      const below = r.bottom + 6;
      const above = r.top - h - 6;
      const top = below + h <= window.innerHeight - M ? below : above >= M ? above : Math.max(M, window.innerHeight - h - M);
      setPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  useClickOutside([wrap, popup], () => setOpen(false), open);
  useEscapeKey(() => setOpen(false), open);

  const openPopup = () => { setOpts(getPwOptions()); setRemember(!getPwAsk()); setOpen(true); };

  const generate = (o: PwOptions) => {
    if (current) setPending(o);
    else onGenerate(generateWithOptions(o));
  };

  const confirm = () => {
    setPwOptions(opts);
    setPwAsk(!remember);
    setOpen(false);
    generate(opts);
  };

  return (
    <div className="relative flex items-center gap-1" ref={wrap}>
      <div ref={trigger} className="flex items-center gap-1">
        <Tooltip content="Generate a strong password"><Button
          size="sm"
          icon={<Dices size={compact ? 13 : 12} />}
          aria-label={compact ? "Generate a strong password" : undefined}
          className={compact ? "!p-0 h-7 w-7 justify-center shrink-0" : undefined}
          aria-haspopup={ask ? "dialog" : undefined}
          aria-expanded={ask ? open : undefined}
          onClick={() => (ask ? (open ? setOpen(false) : openPopup()) : generate(getPwOptions()))}
        >
          {compact ? null : "Generate"}
        </Button></Tooltip>
        {!ask && (
          <Tooltip content="Password generator options">
            <Button size="sm" aria-label="Password generator options" aria-haspopup="dialog" aria-expanded={open} className={compact ? "!p-0 h-7 w-7 justify-center shrink-0" : undefined}
                    icon={<SlidersHorizontal size={12} />} onClick={() => (open ? setOpen(false) : openPopup())} />
          </Tooltip>
        )}
      </div>

      {/* In the body: inside the form, a transformed or container-query parent would turn the popup's "fixed"
          position into one relative to that parent, putting it far off and making the form scroll. */}
      {open && createPortal(
        <div
          ref={popup}
          role="dialog"
          aria-label="Password generator options"
          className="pw-pop"
          style={{ width: POPUP_W, maxHeight: "calc(100vh - 16px)", overflowY: "auto", ...(pos ?? { left: 0, top: 0, visibility: "hidden" }) }}
        >
          <div className="pw-pop-title">Password options</div>
          <PasswordOptionsForm value={opts} onChange={setOpts} />

          <label className="pw-check pw-remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span>Remember my choice — don't show this next time</span>
          </label>
          <p className="pw-hint">
            Change it later with the <SlidersHorizontal size={10} style={{ display: "inline", verticalAlign: "-1px" }} /> button
            next to Generate, or in Settings → Vault → Password generator.
          </p>

          <div className="pw-actions">
            <Button size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" variant="primary" icon={<Dices size={12} />} onClick={confirm} autoFocus>Generate</Button>
          </div>
        </div>,
        document.body,
      )}

      {pending && (
        <TypeToConfirmDialog
          title="Replace the saved password?"
          message="This entry already has a password. After replacing it, change it on the website too, or you won't be able to sign in. The old one stays in this entry's History once you save."
          confirmLabel="Replace password"
          onConfirm={() => { onGenerate(generateWithOptions(pending)); setPending(null); }}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}
