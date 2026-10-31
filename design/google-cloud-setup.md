# Google Cloud setup for Notiq Vault Sync

Ye steps aapko (maintainer) apne Gmail se ek baar karne hain. Company ya apna domain nahi chahiye, aur Drive API ke
liye billing/card bhi nahi lagta. Google Console ke menu names kabhi-kabhi badalte hain, isliye naam thoda alag dikhe
to wahi cheez dhoondhna.

> **Pehle check karo:** v0.6.0 se pehle Notiq ek OAuth client use karta tha:
> `639536443788-jo6ec87mf9qfafpbb1qqskoj0gca8jra.apps.googleusercontent.com`.
> Agar wo project aapke Google account mein abhi bhi hai, to naya banane ki jagah wahi use kar sakte ho.
> Tab step 1 skip karke baaki steps us project par check kar lena.

## 1. Project banao
1. https://console.cloud.google.com par apne Gmail se login karo.
2. Upar project picker → **New project** → naam `Notiq` → Create.

## 2. Google Drive API on karo
**APIs & Services → Library** → "Google Drive API" → **Enable**.

## 3. Consent screen (Google Auth Platform)
**APIs & Services → OAuth consent screen** (ya **Google Auth Platform**):

- **Branding**
  - App name: `Notiq`
  - User support email: aapka email. Ye users ko Google login screen par dikhega.
  - Logo: optional. Logo daaloge to Google brand verification maangega, isliye pehle bina logo ke rakh sakte ho.
  - Application home page: `https://trexolab-solution.github.io/notiq/`
  - Privacy policy: `https://trexolab-solution.github.io/notiq/privacy.html`. Ye page sync feature ke saath update hoga.
  - Authorized domains: `trexolab-solution.github.io`. Ye step 5 ke baad hi accept hoga.
  - Developer contact email: aapka email.
- **Audience:** User type **External**. Phir **Publish app → In production**.
  "Testing" mode mat chhodna. Usme sirf 100 test users chalte hain, aur login har 7 din mein expire ho jaata hai.
- **Data access (scopes):** sirf ye teen add karo:
  - `https://www.googleapis.com/auth/drive.appdata`: Notiq ka apna hidden folder
  - `openid` aur `email`: Settings mein "Connected as you@gmail.com" dikhane ke liye

  Ye teeno non-sensitive category ke maane jaate hain. Agar Console kisi scope ko "sensitive" ya "restricted" bataye,
  to ruk jaao aur mujhe batao.

## 4. Desktop client ID banao
**Clients** (ya **Credentials → Create credentials → OAuth client ID**):
- Application type: **Desktop app**
- Name: `Notiq Desktop`
- Create karne par **Client ID** aur **Client secret** milenge.

Notiq dono values build ke time environment se leta hai (`src-tauri/src/sync/gdrive.rs`). Inke bina bana build
Google sign-in nahi kar sakta. Desktop apps mein Google client secret ko asli secret nahi maanta, kyunki security
PKCE se aati hai. Phir bhi secret repo mein commit mat karna:
- GitHub → repo `trexolab-solution/notiq` → Settings → Secrets and variables → Actions:
  - **Variables** tab: `NOTIQ_GOOGLE_CLIENT_ID` = client ID (ye public hai)
  - **Secrets** tab: `NOTIQ_GOOGLE_CLIENT_SECRET` = client secret
- Local dev ke liye apne PC par yahi do environment variables set karo, phir `tauri dev` chalao.
- Release workflow (`.github/workflows/release.yml`) abhi ye do values build ko nahi deta. Ye wiring 0.9.0 ke
  baaki kaam (P3/P4) mein add hogi.

## 5. GitHub Pages site ka owner hone ka proof (Search Console)
1. https://search.google.com/search-console → **Add property** → **URL prefix** → `https://trexolab-solution.github.io/notiq/`.
2. Verification method **HTML file** → file download karo → repo ke `docs/` folder mein daal kar push karo.
   GitHub Pages wahi folder publish karta hai.
3. Page live hone par **Verify**.
4. Ab step 3 ke "Authorized domains" mein `trexolab-solution.github.io` accept ho jaana chahiye.

## 6. Mujhe kya bhejna hai
- Client ID (public hai, chat mein bhej sakte ho)
- Confirm karo ki secret GitHub Actions secret mein daal diya hai. **Secret chat mein mat bhejna.**

Tab tak development test credentials par chalega. Aapki client ID aate hi wahi laga denge.
