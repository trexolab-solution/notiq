import { invoke } from "@tauri-apps/api/core";

/**
 * Settings → Vault → Browser autofill → "Allow autofill in private (incognito) windows". Off by default.
 * Kept by the backend (`<app-data>/autofill_incognito.json`) because the bridge and the native host enforce it:
 * requests the extension flags as coming from a private tab are refused while it is off.
 */
export const DEFAULT_AUTOFILL_INCOGNITO = false;

export const autofillIncognitoGet = async (): Promise<boolean> => (await invoke<unknown>("autofill_incognito_get")) === true;
export const autofillIncognitoSet = (allow: boolean) => invoke<void>("autofill_incognito_set", { allow });
