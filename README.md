# VP Curling — Board Command Center

A shared board dashboard for the K-W Granite Club, hosted on GitHub Pages,
backed by Firestore, gated behind Google sign-in and a board-member allowlist.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app — auth gate, dashboard, editing |
| `firebase-config.js` | **You fill this in** with your project's web config |
| `firestore.rules` | Security rules — deploy these before going live |
| `seed-data.json` | Current dashboard content, ready to import |
| `seed.js` | One-time script to load the seed data |

---

## Setup

### 1. Firebase project
1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**
2. **Build → Firestore Database → Create database** → *Production mode* → region `northamerica-northeast` (Toronto/Montreal — keeps club data in Canada)
3. **Build → Authentication → Get started → Google** → Enable → save

### 2. Web app config
1. Project settings (gear) → **Your apps** → **Web** (`</>`) → register
2. Copy the `firebaseConfig` object
3. Paste the values into `firebase-config.js`

> These values are not secrets — they identify your project publicly. Your data
> is protected by the security rules and the allowlist, not by hiding this file.

### 3. Deploy the security rules
Firestore → **Rules** tab → paste the contents of `firestore.rules` → **Publish**.

Do this *before* seeding. Without it, Firestore's default rules will either block
everything or (in test mode) expose everything.

### 4. Add yourself as the first board member
Rules deliberately make `boardMembers` **write-only from the console**, so nobody
can grant themselves access from the browser. Create the first record by hand:

Firestore → **Start collection** → `boardMembers`
- Document ID: `ron.mooibroek@gmail.com`
- Fields: `name` (string) = `Ron Mooibroek`, `role` (string) = `VP Curling`,
  `canSeeConfidential` (boolean) = `true`

### 5. Seed the rest
```bash
npm install firebase-admin
# download a service-account key → save as service-account.json (never commit it)
node seed.js
```
Or skip this and add items by hand in the app — the seeder just saves typing.

### 6. Publish to GitHub Pages
```bash
git init
git add index.html firebase-config.js README.md firestore.rules seed-data.json
git commit -m "VP Curling board dashboard"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
Repo → **Settings → Pages** → Source: `main` / root → Save.

**Do not commit `service-account.json`.** Add a `.gitignore`:
```
service-account.json
node_modules/
```

### 7. Authorize the Pages domain  ← easy one to miss
Firebase → **Authentication → Settings → Authorized domains → Add domain**
→ `<you>.github.io`

Google sign-in silently fails without this.

---

## Adding board members later

Firestore → `boardMembers` → **Add document**, ID = their Google email:

| Field | Type | Notes |
|---|---|---|
| `name` | string | Display name |
| `role` | string | e.g. "Director" |
| `canSeeConfidential` | boolean | `true` to see in-camera items |

Remove someone by deleting their document — access is revoked immediately.

## A note on confidential items

Topics and agenda items flagged `confidential: true` (the Tyler Bell matter) are
readable only by members with `canSeeConfidential: true`, enforced server-side by
the rules — not just hidden in the UI.

Even so: this is a cloud database holding personnel information. Keep the detail
on in-camera records minimal — enough to know the item exists and where it stands,
not a record of the substance. Detailed personnel files belong in the club's
formal records, not here.

## Working on this with Claude

Claude can't read or write this Firestore directly. The workflow that does work:
ask Claude for updated content, get a fresh `seed-data.json`, and re-run `seed.js`
— or paste the current data into a chat when you want analysis.
