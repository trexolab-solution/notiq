import { createContext, useContext } from "react";

export interface DialogContextValue {
  titleId: string;
  descriptionId: string;
  onClose: () => void;
  dismissable: boolean;
}

export const DialogContext = createContext<DialogContextValue | null>(null);

/** The enclosing Dialog's ids and close handler (null outside a Dialog). */
export const useDialogContext = () => useContext(DialogContext);
