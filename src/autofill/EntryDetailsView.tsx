import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Eye, EyeOff } from "lucide-react";
import { Button } from "../components/ui/Button";
import { Tooltip } from "../components/ui/Tooltip";
import { CopyIconButton } from "../components/vault/CopyIconButton";
import { useAutoHide } from "../hooks/useAutoHide";
import { ERR_LOCKED } from "../lib/vault";
import { loadEntryDetails, type DetailRow, type EntryDetails, type DetailsDeps } from "../lib/entryDetails";
import { totpCode, totpRemaining } from "../lib/loginEntry";

/** Fixed-length mask: never hints at how long the secret is. */
export const MASK = "••••••••";

type Load = { status: "loading" } | { status: "ready"; d: EntryDetails } | { status: "error"; locked: boolean };

export interface EntryDetailsViewProps {
  /** Full vault path of the entry; it is read when the view opens (not before). */
  path: string;
  onBack: () => void;
  /** "Open in Notiq"; omitted when the entry can't be opened (no vault-relative path). */
  onOpen?: () => void;
  /** Shown above the fields, e.g. which row Allow will actually use. */
  note?: string;
  disabled?: boolean;
  /** Test seam for the vault read. */
  deps?: DetailsDeps;
}

/**
 * Read-only details of one entry inside the small autofill window (a sub-view, not a modal): every
 * value has a copy button (clipboard cleared per Settings → Vault), secrets stay masked until revealed
 * and hide again on their own. Everything it read is dropped when the view closes (Back, Esc, or the
 * prompt ending), because it lives only in this component's state.
 */
export function EntryDetailsView({ path, onBack, onOpen, note, disabled, deps }: EntryDetailsViewProps) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    setLoad({ status: "loading" });
    loadEntryDetails(path, deps).then(
      (d) => { if (alive) setLoad({ status: "ready", d }); },
      (err) => { if (alive) setLoad({ status: "error", locked: err === ERR_LOCKED }); },
    );
    return () => { alive = false; };
  }, [path, deps]);

  // The row's details button is gone now: keep the keyboard focus inside the window.
  useEffect(() => { backRef.current?.focus({ preventScroll: true }); }, []);

  return (
    <section className="af-details" aria-label="Entry details">
      <div className="af-details-bar">
        <button ref={backRef} type="button" className="af-back" onClick={onBack} aria-label="Back to the list">
          <ArrowLeft size={14} aria-hidden /> Back
        </button>
        {load.status === "ready" && <h2 className="af-details-title" title={load.d.title}>{load.d.title}</h2>}
      </div>
      {note && <p className="af-note">{note}</p>}
      {load.status === "loading" && <p className="af-detail" role="status">Reading the entry…</p>}
      {load.status === "error" && (
        <p className="af-error" role="alert">
          {load.locked ? "The vault is locked. Unlock Notiq to see this entry." : "Couldn't read this entry."}
        </p>
      )}
      {load.status === "ready" && <DetailsBody d={load.d} />}
      {onOpen && (
        <Tooltip content="Opens the entry in the main window. Nothing is filled.">
          <Button size="sm" icon={<ExternalLink size={13} />} onClick={onOpen} disabled={disabled}>Open in Notiq</Button>
        </Tooltip>
      )}
    </section>
  );
}

function DetailsBody({ d }: { d: EntryDetails }) {
  return (
    <div className="af-drows">
      {d.sites.map((s, i) => (
        <ValueRow key={`site-${i}`} row={{ id: `site-${i}`, label: i === 0 ? "Website" : "Also on", value: s, secret: false }} />
      ))}
      {d.rows.map((r) => <ValueRow key={r.id} row={r} />)}
      {d.totp && <TotpRow secret={d.totp} />}
      {d.notes && <ValueRow row={{ id: "notes", label: "Notes", value: d.notes, secret: false, multiline: true }} />}
    </div>
  );
}

function ValueRow({ row }: { row: DetailRow }) {
  const [shown, setShown] = useState(false);
  useAutoHide(shown, setShown);
  const name = row.label;
  const visible = !row.secret || shown;
  const text = row.value ? (visible ? (row.display ?? row.value) : MASK) : "";
  return (
    <div className="af-drow">
      <span className="af-dlabel">{row.label}</span>
      <span className={`af-dval${row.multiline && visible ? " af-dval--multi" : ""}${row.secret ? " font-mono" : ""}`}
            data-testid={`af-dval-${row.id}`}>
        {text || <span className="af-muted">(empty)</span>}
      </span>
      <span className="af-dacts">
        {row.secret && row.value && (
          <Tooltip content={shown ? `Hide ${name}` : `Show ${name}`}>
            <Button size="sm" aria-label={shown ? `Hide ${name}` : `Show ${name}`} aria-pressed={shown}
                    icon={shown ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setShown((v) => !v)} />
          </Tooltip>
        )}
        <CopyIconButton value={row.value} label={name} />
      </span>
    </div>
  );
}

/** Live 2-step code (the secret itself is never shown), refreshed every 30-second step. */
function TotpRow({ secret }: { secret: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(() => totpRemaining());
  useEffect(() => {
    let alive = true;
    let step = -1;
    const tick = () => {
      const now = Date.now();
      setLeft(totpRemaining(now));
      const s = Math.floor(now / 30000);
      if (s === step) return;
      step = s;
      void totpCode(secret, now).then((c) => { if (alive) setCode(c); });
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [secret]);
  return (
    <div className="af-drow">
      <span className="af-dlabel">2-step code</span>
      <span className="af-dval font-mono" data-testid="af-dval-totp">
        {code ? <>{code.slice(0, 3)} {code.slice(3)} <span className="af-muted">· {left}s</span></>
          : <span className="af-muted">Invalid 2-step secret</span>}
      </span>
      <span className="af-dacts">
        <CopyIconButton value={code ?? ""} label="2-step code" />
      </span>
    </div>
  );
}
