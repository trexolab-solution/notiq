import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dices, SlidersHorizontal } from "lucide-react";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
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
 */
export function GeneratePasswordButton({ onGenerate }: { onGenerate: (password: string) => void }) {
  const [open, setOpen] = useState(false);
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

  useLayoutEffect(() => {
    if (!open || !trigger.current) { setPos(null); return; }
    const r = trigger.current.getBoundingClientRect();
    const M = 8;
    const left = Math.max(M, Math.min(r.right - POPUP_W, window.innerWidth - POPUP_W - M));
    const below = r.bottom + 6;
    const h = popup.current?.offsetHeight ?? 300;
    setPos({ left, top: below + h > window.innerHeight - M ? Math.max(M, r.top - h - 6) : below });
  }, [open]);

  useClickOutside(wrap, () => setOpen(false), open);
  useEscapeKey(() => setOpen(false), open);

  const openPopup = () => { setOpts(getPwOptions()); setRemember(!getPwAsk()); setOpen(true); };

  const generate = (o: PwOptions) => onGenerate(generateWithOptions(o));

  const confirm = () => {
    setPwOptions(opts);
    setPwAsk(!remember);
    setOpen(false);
    generate(opts);
  };

  return (
    <div className="relative flex items-center gap-1" ref={wrap}>
      <div ref={trigger} className="flex items-center gap-1">
        <Button
          size="sm"
          icon={<Dices size={12} />}
          title="Generate a strong password"
          aria-haspopup={ask ? "dialog" : undefined}
          aria-expanded={ask ? open : undefined}
          onClick={() => (ask ? (open ? setOpen(false) : openPopup()) : generate(getPwOptions()))}
        >
          Generate
        </Button>
        {!ask && (
          <Tooltip content="Password generator options">
            <Button size="sm" aria-label="Password generator options" aria-haspopup="dialog" aria-expanded={open}
                    icon={<SlidersHorizontal size={12} />} onClick={() => (open ? setOpen(false) : openPopup())} />
          </Tooltip>
        )}
      </div>

      {open && (
        <div
          ref={popup}
          role="dialog"
          aria-label="Password generator options"
          className="pw-pop"
          style={pos ? { left: pos.left, top: pos.top, width: POPUP_W } : { visibility: "hidden", width: POPUP_W }}
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
        </div>
      )}
    </div>
  );
}
