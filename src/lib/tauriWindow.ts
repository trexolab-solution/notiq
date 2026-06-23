import { getCurrentWindow } from '@tauri-apps/api/window'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
export const appWin  = isTauri ? getCurrentWindow() : null
