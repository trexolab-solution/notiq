import { APP_VERSION } from "./app";

/**
 * "What's New" release note, shown once in the editor after the app updates to a
 * new version (see `lib/firstRun.ts` + the startup effect in `App.tsx`). It opens
 * as an in-memory Markdown *preview* tab, so keep two rendering constraints in mind:
 *   • Lead with a `#` heading — an unsaved note derives its tab title from the
 *     first line, so this keeps the title as "What's New in Notiq …".
 *   • Use absolute `https://` / `data:` image URLs only; relative paths can't
 *     resolve without a file on disk.
 *
 * Update this string for every release — keep it short and highlight-focused.
 */
export const WHATS_NEW = `# What's New in Notiq ${APP_VERSION}

Thanks for updating! Here's what's new in this release.

## 🔑 Autofill, redesigned

- **A simpler approval window** — when the browser asks to fill, Notiq shows a compact sheet: the site, one account (tap ⌄ to switch), a big **Fill** button and **Not now**. It opens at the size of its content, and only warns when a site looks like an imitation of the saved one. **Shift+Enter** fills and copies the 2-step code.
- **Logins right in the page** — click a username or password field and a small menu lists your saved logins for that site. Type to filter, pick one, and Notiq still asks before it fills. Passwords never appear in the page.
- **Strong passwords on sign-up** — focus a new-password field to get a strong password with its strength, a new one with ↻, and options for length, numbers and symbols. **Use and save** fills both password fields and saves the login to Notiq.
- Turn the in-page menus off in the extension's popup under **Suggest on field focus**.

---

*You can safely close this tab — it won't open again until the next update. See the full history on the [releases page](https://github.com/trexolab-solution/notiq/releases).*
`;
