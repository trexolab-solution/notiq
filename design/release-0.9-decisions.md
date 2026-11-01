# 0.9.0 — decisions from the maintainer interview (2026-11-01)

Source of truth for the last 0.9.0 items. Asked with examples; answers below are the maintainer's choices.

## Vault Sync

1. **Two password changes at nearly the same time → the later change wins.**
   Example: Laptop sets "Aam123" at 10:00, the offline Office PC sets "Kela456" at 10:02 → after both sync,
   "Kela456" works everywhere. On the Laptop the old password shows "Your master password was changed on another
   PC. Use the new password." Rollback protection stays: an older `vault.meta` that is not a concurrent change is
   still rejected. (Previously: higher generation wins, tie → Drive wins.)
2. **Pause control = status line + button, no toggle.**
   "Sync is on · [Pause]" / "Sync is paused on this PC · [Resume sync]". Cancelling "Upload this vault?" or choosing
   "Keep this PC separate" ends in the paused state.
3. **Resume finds an empty Drive → ask first.**
   "Your vault wasn't found in Google Drive (it may have been deleted). Upload this PC's vault (42 items) again?"
   [Upload] [Cancel]. Never upload silently in this case.

## Browser extension

4. **Popup upgrade** — accounts that match the current site (no whole-vault search: the vault list never reaches
   the extension), a filter box over those matches, lock status. Clicking an account row fills it (normal app
   approval). Row buttons: copy username, copy password, copy 2FA code, open in Notiq.
   Copies go through the Notiq app (secret never stored in the extension, excluded from Windows clipboard history)
   and are cleared after the app setting below.
5. **Clipboard auto-clear** — new Notiq setting (Settings → Vault): "Clear copied secrets after: 15 s / 30 s
   (default) / 1 min / 2 min / Never". Used by every copy of a secret, in the app and from the extension.
6. **Right-click menu** on editable fields: "Notiq ▸ Fill login · Fill 2FA code · Fill identity ▸ (Home / Office …) ·
   Generate password".
7. **Identity entries** — new vault entry type "Identity" (several per vault, e.g. Home, Office) with: full name,
   email, phone, address line 1, address line 2, city, state, PIN/ZIP, country. Filled into address / contact forms
   (autocomplete tokens first, then label/name heuristics) with the usual approval.
8. **Custom fields fill by name** — a login's custom fields are filled with the login when a page field's
   label / name / placeholder matches the custom field's name (e.g. bank "Customer ID"); secret custom fields too,
   but only on that login's own site.
9. **Choose which entry to update** — when several entries share the username on the site, the save prompt shows
   "Update: <entry> ▾" (most recently used pre-selected) plus "Save as new".

Not in 0.9.0: whole-vault search in the popup, i18n, Vivaldi/Opera, toolbar fill inside shadow DOM.
