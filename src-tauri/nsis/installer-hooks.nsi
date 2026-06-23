; Notiq NSIS installer hooks

; ── Pre-uninstall: clean up entries created by the Rust runtime ──────────────
; The app registers context-menu verbs, an Applications\ entry, OpenWithProgids
; values, and its own ProgID (Notiq.Note) on every launch.  The auto-generated
; APP_UNASSOCIATE macro only handles extensions + the Tauri-created ProgIDs,
; so we must delete the rest here before the built-in cleanup runs.

!macro NSIS_HOOK_PREUNINSTALL
  ; ── Context-menu verbs ────────────────────────────────────────────────────
  DeleteRegKey HKCU "Software\Classes\*\shell\Open with Notiq"
  DeleteRegKey HKCU "Software\Classes\directory\shell\Open with Notiq"
  DeleteRegKey HKCU "Software\Classes\directory\background\shell\Open with Notiq"

  ; ── "Open With" list entry ────────────────────────────────────────────────
  DeleteRegKey HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe"

  ; ── Runtime ProgID (Notiq.Note) ───────────────────────────────────────────
  DeleteRegKey HKCU "Software\Classes\Notiq.Note"

  ; ── OpenWithProgids value under each extension ────────────────────────────
  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids"        "Notiq.Note"
  DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids"  "Notiq.Note"
  DeleteRegValue HKCU "Software\Classes\.txt\OpenWithProgids"       "Notiq.Note"
  DeleteRegValue HKCU "Software\Classes\.notiq\OpenWithProgids"     "Notiq.Note"

  ; ── Notify Explorer so stale context-menu items vanish immediately ────────
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0x0000, p 0, p 0)'
!macroend

; ── Post-install: set custom file-association icon ───────────────────────────

!macro NSIS_HOOK_POSTINSTALL
  ; For each extension Tauri registered, read its ProgId and set DefaultIcon
  ; to the bundled association icon instead of the default exe icon.

  ReadRegStr $0 SHCTX "Software\Classes\.md" ""
  StrCmp $0 "" +2 0
    WriteRegStr SHCTX "Software\Classes\$0\DefaultIcon" "" "$INSTDIR\icons\association.ico"

  ReadRegStr $0 SHCTX "Software\Classes\.markdown" ""
  StrCmp $0 "" +2 0
    WriteRegStr SHCTX "Software\Classes\$0\DefaultIcon" "" "$INSTDIR\icons\association.ico"

  ReadRegStr $0 SHCTX "Software\Classes\.txt" ""
  StrCmp $0 "" +2 0
    WriteRegStr SHCTX "Software\Classes\$0\DefaultIcon" "" "$INSTDIR\icons\association.ico"

  ReadRegStr $0 SHCTX "Software\Classes\.notiq" ""
  StrCmp $0 "" +2 0
    WriteRegStr SHCTX "Software\Classes\$0\DefaultIcon" "" "$INSTDIR\icons\association.ico"

  ; Refresh the Windows shell icon cache so changes appear immediately
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0x0000, p 0, p 0)'
!macroend
