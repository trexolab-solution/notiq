import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { copySecret } from "../../lib/secureCopy";

const FEEDBACK_MS = 1500;

interface Props {
  /** What gets copied; the button is disabled while it's empty. */
  value: string;
  /** Names the field in the tooltip / accessible label, e.g. "password". */
  label: string;
}

/**
 * Icon-only copy button for vault secrets: tooltip on hover, and the icon turns
 * into a check mark for a moment once the value is on the clipboard (the clipboard
 * is still wiped after 20 s by `copySecret`).
 */
export function CopyIconButton({ value, label }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onClick = useCallback(async () => {
    if (!(await copySecret(value, label, { quiet: true }))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), FEEDBACK_MS);
  }, [value, label]);

  return (
    <Tooltip content={copied ? "Copied" : `Copy ${label}`}>
      <Button
        size="sm"
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        icon={copied ? <Check size={13} style={{ color: "var(--color-success)" }} /> : <Copy size={13} />}
        disabled={!value}
        onClick={() => { void onClick(); }}
      />
    </Tooltip>
  );
}
