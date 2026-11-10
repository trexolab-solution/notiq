import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ExternalLink, Eye, EyeOff, KeyRound, Lock, TriangleAlert } from "lucide-react";
import { Avatar } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { DialogButton } from "../components/ui/DialogParts";
import { InlineLoading } from "../components/ui/Loading";
import { Tooltip } from "../components/ui/Tooltip";
import { TotpRing } from "../components/ui/TotpRing";
import { CopyIconButton } from "../components/vault/CopyIconButton";
import {
  listBoxClass, listRowHoverClass, RowActions, rowButtonClass, RowIconButton, RowIconSpacer,
} from "../components/vault/ListEditor";
import { kindLabel } from "../components/vault/sidebar/EntryIcon";
import { useAutoHide } from "../hooks/useAutoHide";
import { ERR_LOCKED } from "../lib/vault";
import type { EntryKind } from "../lib/vaultTree";
import { loadEntryDetails, type DetailRow, type EntryDetails, type DetailsDeps } from "../lib/entryDetails";
import { hostOf, totpCode, totpRemaining } from "../lib/loginEntry";
import { formatCode, NEAR_EXPIRY_SECONDS, TOTP_PERIOD } from "../quick/totp";

/** Fixed-length mask: never hints at how long the secret is. */
export const MASK = "••••••••";

type Load = { status: "loading" } | { status: "ready"; d: EntryDetails } | { status: "error"; locked: boolean };

export interface EntryDetailsViewProps {
  /** Full vault path of the entry; it is read when the view opens (not before). */
  path: string;
  /** The row's title from the list, shown in the header while the entry is read. */
  title?: string;
  onBack: () => void;
  /** "Open in Notiq"; omitted when the entry can't be opened (no vault-relative path). */
  onOpen?: () => void;
  /** "Fill this login": picks this row and allows, exactly like choosing it in the list. */
  onFill?: () => void;
  /** Text of the fill button ("Fill this login", "Fill this card"…). */
  fillLabel?: string;
  /** A fill is in progress (the fill button spins, the rest is disabled). */
  busy?: boolean;
  disabled?: boolean;
  /** Test seam for the vault read. */
  deps?: DetailsDeps;
}

/**
 * Read-only details of one entry inside the small autofill window (a sub-view, not a modal), laid out
 * like the vault entry form: a small label above each value and one fixed action column (reveal, copy)
 * so every row's buttons line up. Copies go through `secureCopy` (clipboard wiped per Settings → Vault);
 * secrets stay masked until revealed and hide again on their own. Everything it read lives only in this
 * component's state, so it is dropped when the view closes (Back, Esc, the prompt ending or the vault
 * locking, which ends the prompt). Nothing here is ever sent to the browser extension: "Fill this login"
 * releases the same reply as choosing the row in the list.
 */
export function EntryDetailsView({ path, title, onBack, onOpen, onFill, fillLabel = "Fill this login", busy, disabled, deps }: EntryDetailsViewProps) {
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

  const d = load.status === "ready" ? load.d : null;
  const name = d?.title || title || "Entry";
  const subtitle = d ? (d.sites[0] ? hostOf(d.sites[0]) || d.sites[0] : kindLabel(d.kind as EntryKind) ?? "") : "";
  const off = disabled || busy;

  return (
    <section className="af-details" aria-label={`Details of ${name}`}>
      <div className="af-details-head">
        <Tooltip content="Back to the list (Esc)">
          <button ref={backRef} type="button" className="af-back" onClick={onBack} aria-label="Back to the list" disabled={busy}>
            <ArrowLeft size={15} aria-hidden />
          </button>
        </Tooltip>
        <Avatar name={name} size={40} />
        <div className="af-details-id">
          <h2 className="af-details-title" title={name}>{name}</h2>
          {subtitle && <p className="af-details-sub" title={subtitle}>{subtitle}</p>}
        </div>
      </div>

      {load.status === "loading" && <InlineLoading label="Reading the entry…" className="af-state" />}
      {load.status === "error" && (
        <div className="af-state af-state--error" role="alert">
          {load.locked ? <Lock size={18} aria-hidden /> : <TriangleAlert size={18} aria-hidden />}
          <strong>{load.locked ? "The vault is locked" : "Couldn't read this entry"}</strong>
          <span>{load.locked ? "Unlock Notiq to see this entry." : "It may have been moved or deleted."}</span>
        </div>
      )}
      {d && <DetailsBody d={d} />}

      {(onOpen || onFill) && (
        <div className="af-details-actions">
          {onOpen && (
            <Tooltip content="Opens the entry in the main window. Nothing is filled.">
              <Button size="sm" icon={<ExternalLink size={13} />} onClick={onOpen} disabled={off}>Open in Notiq</Button>
            </Tooltip>
          )}
          {onFill && (
            <DialogButton variant="primary" className="af-fill-btn" icon={<KeyRound size={15} />} onClick={onFill} disabled={disabled} loading={busy}
                          loadingText="Filling…">
              {fillLabel}
            </DialogButton>
          )}
        </div>
      )}
    </section>
  );
}

function DetailsBody({ d }: { d: EntryDetails }) {
  const core = d.rows.filter((r) => !r.id.startsWith("custom-"));
  const custom = d.rows.filter((r) => r.id.startsWith("custom-"));
  return (
    <div className="af-dgroups">
      {(core.length > 0 || d.totp) && (
        <ul aria-label="Fields" className={listBoxClass}>
          {core.map((r) => <ValueRow key={r.id} row={r} />)}
          {d.totp && <TotpRow secret={d.totp} />}
        </ul>
      )}
      {d.sites.length > 0 && (
        <Group title={d.sites.length > 1 ? `Websites · ${d.sites.length}` : "Website"}>
          <ul aria-label="Websites" className={listBoxClass}>
            {d.sites.map((s, i) => (
              <Field key={`site-${i}`} id={`site-${i}`} value={<span title={s}>{s}</span>}
                     actions={<><RowIconSpacer /><CopyIconButton value={s} label={`website ${hostOf(s) || s}`} className={rowButtonClass} /></>} />
            ))}
          </ul>
        </Group>
      )}
      {custom.length > 0 && (
        <Group title={`Custom fields · ${custom.length}`}>
          <ul aria-label="Custom fields" className={listBoxClass}>
            {custom.map((r) => <ValueRow key={r.id} row={r} />)}
          </ul>
        </Group>
      )}
      {d.notes && (
        <Group title="Notes">
          <div className="af-notes-wrap">
            <div className="af-notes" tabIndex={0} aria-label="Notes" data-testid="af-dval-notes">{d.notes}</div>
            <CopyIconButton value={d.notes} label="Notes" className={rowButtonClass} />
          </div>
        </Group>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="af-dgroup">
      <h3 className="af-dgroup-title">{title}</h3>
      {children}
    </div>
  );
}

/** One row: small muted label above the value, actions in the fixed column at the end. */
function Field({ id, label, value, actions, multiline }: {
  id: string; label?: string; value: ReactNode; actions: ReactNode; multiline?: boolean;
}) {
  return (
    <li className={`af-field ${listRowHoverClass}`}>
      <div className="af-field-main">
        {label && <span className="af-field-label">{label}</span>}
        <div className={`af-field-value${multiline ? " af-field-value--multi" : ""}`} data-testid={`af-dval-${id}`}>{value}</div>
      </div>
      <RowActions>{actions}</RowActions>
    </li>
  );
}

function ValueRow({ row }: { row: DetailRow }) {
  const [shown, setShown] = useState(false);
  useAutoHide(shown, setShown);
  const name = row.label;
  const visible = !row.secret || shown;
  const text = row.value ? (visible ? (row.display ?? row.value) : MASK) : "";
  return (
    <Field id={row.id} label={row.label} multiline={!!row.multiline && visible}
           value={text ? <span className={row.secret ? "font-mono" : undefined}>{text}</span> : <span className="af-muted">(empty)</span>}
           actions={<>
             {row.secret && row.value ? (
               <RowIconButton pressed={shown} label={shown ? `Hide ${name}` : `Show ${name}`}
                              icon={shown ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setShown((v) => !v)} />
             ) : <RowIconSpacer />}
             <CopyIconButton value={row.value} label={name} className={rowButtonClass} />
           </>} />
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
      const s = Math.floor(now / (TOTP_PERIOD * 1000));
      if (s === step) return;
      step = s;
      void totpCode(secret, now).then((c) => { if (alive) setCode(c); });
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [secret]);
  const low = left < NEAR_EXPIRY_SECONDS;
  return (
    <Field id="totp-row" label="2-step code"
           value={code ? (
             <span className="af-totp">
               <span className="af-totp-code" data-testid="af-dval-totp" data-low={low ? "" : undefined}>{formatCode(code)}</span>
               <TotpRing left={left} period={TOTP_PERIOD} size={18} low={low} />
               <span className="af-totp-left" data-testid="af-totp-left">{left}s</span>
             </span>
           ) : <span className="af-muted" data-testid="af-dval-totp">Invalid 2-step secret</span>}
           actions={<><RowIconSpacer /><CopyIconButton value={code ?? ""} label="2-step code" className={rowButtonClass} /></>} />
  );
}
