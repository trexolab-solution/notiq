# Vault Sync — user experience and flows (0.9.0)

Status: agreed direction from the maintainer's fresh-profile test on 2026-10-31. This replaces the ad-hoc flows in
`release/0.9.0` (connect in Settings → "Set up the vault first" dead end, create-vault prompt while Drive already has
a vault, A/B/C dialog for an empty local vault, raw device ids). Implementation follows this document.

## Principles

1. **Connecting is the intent to sync.** After Google sign-in, Notiq immediately checks Drive and offers the one next
   step. Sync is ON as soon as that step finishes; there is no separate toggle to find. (The toggle becomes
   "Pause sync on this PC".)
2. **Never ask to create a vault when Drive already has one.** If Drive has a vault, the only question is its master
   password; the local vault is created from Drive with that same password.
3. **No dead ends.** Every screen that can't do something says what to do next and offers the button for it.
4. **One recommended action.** Primary button = the safe, common choice. Rare or risky choices are secondary.
5. **Plain words.** No "A/B/C", no ids, no "adopt/join". Say what happens to the user's data, with counts.
6. **Nothing is lost.** Any step that replaces or merges local data first writes a backup file and says where.
7. **Always visible.** The user can tell at a glance whether sync is on, which account, and when it last synced.

## Where sync lives (surfaces)

| Surface | What it shows | Click |
|---|---|---|
| **Title bar cloud button** (right icon group) | Icon by state: off (outline cloud), synced, syncing (spin), offline, problem (dot), paused (locked) | Opens the **sync popover** |
| **Status bar** item | Same state + short label ("Synced", "Sync off") | Opens the popover |
| **Vault sidebar header** | Small cloud icon with tooltip "Synced with Google Drive · <email>" | Opens the popover |
| **Settings → Vault → Sync** | Full details: account, devices, pause, disconnect, limits | — |
| **Command palette** | "Vault: Sync now", "Vault: Connect Google Drive", "Vault: Sync settings" | — |

### Sync popover

```
Connected                               Off
┌─────────────────────────────────┐     ┌─────────────────────────────────┐
│ ☁ Vault Sync           ● Synced │     │ ☁ Vault Sync             ○ Off  │
│ (P) pintuprajapati4@gmail.com   │     │ Use this vault on your other    │
│ Google Drive · This PC: CODEMUNI│     │ PCs. It's encrypted before it   │
│ Last synced 2 min ago · 2 PCs   │     │ leaves this computer.           │
├─────────────────────────────────┤     ├─────────────────────────────────┤
│ [⟳ Sync now]     Sync settings ›│     │ [Connect Google Drive]          │
└─────────────────────────────────┘     └─────────────────────────────────┘
```
Problem states replace the second line with the reason and a single action: **Reconnect** (sign-in expired / access
removed), **Retry** (error), nothing (offline: "Will sync when you're back online").

## The decision after sign-in

One pure function decides the next screen (unit-tested for every row):

| Local vault on this PC | Drive (same Google account) | Next step | Ends with |
|---|---|---|---|
| none | has a vault | **Open your Drive vault**: master password | Local vault created from Drive, sync ON |
| none | empty | **Create your vault** (password, recovery key) | Vault uploaded, sync ON |
| exists, **empty** (0 items) | has a vault | Same as row 1 (the empty local vault is replaced; backup kept) | Sync ON |
| exists | empty | **Upload this vault** (one confirm, shows item count) | Sync ON |
| exists | **same** vault | Nothing to ask — merge and turn on | Toast "Synced · 3 changes" |
| exists, has items | **different** vault | **Two vaults** dialog (below) | Depends on choice |

Locked local vault: unlock it first (rows 4–6 need its key), then continue automatically.

## Flows

### F1. New user, first PC
1. Vault sidebar (no vault):
   ```
   🔒 Set up your Secure Vault
   Keep logins, SSH keys and private notes behind one master password.
   [ Create vault ]                       (primary)
   Already use Notiq on another PC?
   [ ☁ Use my vault from Google Drive ]   (secondary)
   Restore from a backup file              (link)
   ```
2. Create vault → master password → recovery key (save) →
3. **New step:** "Use this vault on your other PCs?" — explains encryption in one line.
   [Turn on sync with Google Drive] [Not now]. Not now → one-time tip on the title bar cloud button.
4. Turn on → Google sign-in (browser) → Notiq shows "Waiting for Google… [Cancel]" →
   success page in browser → Notiq: "Uploading your vault… 12 items" → toast "Your vault is now in Google Drive".

### F2. Second PC (the main case)
1. Fresh install → vault sidebar → **Use my vault from Google Drive**.
2. Google sign-in → Notiq finds the vault and shows:
   ```
   ☁ Your vault is in Google Drive
   pintuprajapati4@gmail.com · last changed on LAPTOP, 2 hours ago
   Master password  [••••••••••    👁]
   [Open vault]                     Forgot password? → recovery key
   ```
3. Download → vault opens → sync ON → toast "Vault ready · synced with LAPTOP".
   The local vault uses the same master password and recovery key; PC sign-in (Windows Hello) is offered per PC later.
4. Wrong password: inline error under the field, nothing written.
5. Drive turns out empty: "No vault in this Google Drive yet" → [Create a new vault] (continues as F1 step 2 with sync ON).

### F3. Connecting from Settings / popover first (no local vault)
Same as F2 from step 2. Settings must never show "Set up the vault first" with a disabled toggle.

### F4. Existing vault, turning sync on
- Drive empty → confirm "Upload this vault (12 items) to Google Drive?" → upload → ON.
- Drive has the same vault (e.g. reconnecting) → silently merge → ON → toast with changes.
- Drive has a different vault → F5.

### F5. Two different vaults (replaces the A/B/C dialog)
```
☁ This PC and Google Drive have different vaults
This PC: 12 items          Google Drive: 40 items · last changed on LAPTOP
A PC syncs one vault. Choose which one to keep using:

(•) Use the Google Drive vault and add this PC's items to it   ← recommended
    This PC's items are copied in. Identical logins are skipped; others are kept as "Name (This PC)".
( ) Use the Google Drive vault only
    This PC's vault is saved as a backup file you can import later.

Master password of the Google Drive vault [••••••••    👁]
A backup of this PC's vault is saved first: Documents\Notiq\…\backup.nqbackup
                                   [Keep this PC separate]  [Continue]
```
- "Keep this PC separate" = cancel; sync stays off and the popover says so.
- After Continue: progress, then toast "Vault ready · 12 items added".
- Not offered in 0.9.0: replacing the Drive vault with this PC's vault (destructive; later behind a strong confirm).

### F6. Day to day
- Edits sync ~5 s later; title bar icon spins; status bar "Synced".
- Conflicts: one notification "1 note was edited on two PCs — the newer version is kept, the other is in its history".
- New PC joined: other PCs show once "New device: OFFICE-PC joined your vault".
- Locked vault: "Sync paused while the vault is locked".

### F7. Problems
| Situation | Shown | Action |
|---|---|---|
| Offline | "Offline — changes will sync when you're back online" | none |
| Google sign-in expired / access removed | Notification + popover reason | **Reconnect** (re-shown if reconnect fails) |
| Password changed on another PC | Unlock dialog: "Your master password was changed on another PC. Use the new password." | — |
| Drive full / quota | "Google Drive is full" | Open Drive storage page |
| This PC removed from devices elsewhere | "This PC was removed from sync" | Reconnect / keep local |

### F8. Leaving
- **Pause sync on this PC** (toggle): stops syncing, keeps the connection.
- **Disconnect…**: confirm "Your vault stays on this PC and in your Google Drive. This PC stops syncing."
- **Devices**: names (never ids), "This PC" badge, last seen, remove (with confirm).

## Copy rules
- Title case only for buttons; sentences for everything else; no trailing periods on buttons.
- Always name the account and the PC ("pintu…@gmail.com", "LAPTOP").
- Numbers instead of vague words ("12 items", "2 PCs").
- Error text says what happened and what to do, never internal codes.

## Acceptance (fresh-profile tests on one PC)
1. Fresh profile, Drive has a vault → sidebar "Use my vault from Google Drive" → password → vault opens, sync ON, no
   create-vault prompt anywhere.
2. Fresh profile → Settings → Connect → same result as 1 without visiting the sidebar.
3. Fresh profile, Drive empty → create vault → sync ON automatically, upload toast.
4. Fresh profile → Create vault (empty) → Connect → Drive vault offered directly (row 3), no two-vaults dialog.
5. Vault with items + different Drive vault → F5 dialog, both choices work, backup file exists.
6. Title bar, status bar and sidebar header update immediately after every step; devices list shows names.
