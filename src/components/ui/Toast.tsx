import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, CheckCircle, AlertTriangle, XCircle, Info } from "lucide-react";
import { toast, type ToastItem } from "../../lib/toast";

const ICONS: Record<ToastItem["type"], React.ReactNode> = {
  success: <CheckCircle  size={14} strokeWidth={2} />,
  warning: <AlertTriangle size={14} strokeWidth={2} />,
  error:   <XCircle      size={14} strokeWidth={2} />,
  info:    <Info         size={14} strokeWidth={2} />,
};

function ToastBubble({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);

  // Trigger enter animation on next tick
  useEffect(() => { const t = setTimeout(() => setVisible(true), 10); return () => clearTimeout(t); }, []);

  return (
    <div className={`toast-item toast-${item.type}${visible ? " toast-visible" : ""}`}>
      <span className="toast-icon">{ICONS[item.type]}</span>
      <span className="toast-message">{item.message}</span>
      <button className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        <X size={12} strokeWidth={2.5} />
      </button>
    </div>
  );
}

/** Renders the global toast stack. Mount once in App root. */
export function ToastProvider() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => toast.subscribe(setItems), []);

  if (items.length === 0) return null;

  return createPortal(
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <ToastBubble key={item.id} item={item} onDismiss={() => toast.dismiss(item.id)} />
      ))}
    </div>,
    document.body,
  );
}
