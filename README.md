# FWC 26 — Predictions Pool

A website where you and your friends/family predict every match of the 2026 FIFA World Cup. **Free to enter, winner gets a prize.**

---

## 🟢 Setup (15–20 mins, no coding skills needed)

You'll need: a Google account, a GitHub account. That's it. Follow these steps **in order**.

### Step 1 — Create a Firebase project (free database)

1. Go to **<https://console.firebase.google.com>** and sign in with your Google account.
2. Click **"Add project"** (or "Create a project").
3. Name it `fwc26-pool` (or anything you like). Click **Continue**.
4. When it asks about Google Analytics, **turn it off** (toggle to disabled) — you don't need it. Click **Create project**. Wait ~30 seconds.
5. When it's ready, click **Continue**.

### Step 2 — Turn on the database

1. In the left sidebar, click **Build → Firestore Database**.
2. Click **Create database**.
3. Choose **Start in production mode**. Click **Next**.
4. Pick a location close to you (for the UK: `eur3 (europe-west)`). Click **Enable**. Wait ~30 seconds.

### Step 3 — Allow the website to read/write the database

1. While still in Firestore Database, click the **Rules** tab at the top.
2. **Delete everything** in the box, and paste this in:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

3. Click **Publish**.

> This makes the database open to anyone with the link. That's fine for a friends-and-family game — but for safety **keep your GitHub repo private** (next step).

### Step 4 — Get your Firebase config (the magic numbers)

1. Click the **gear icon ⚙️** next to "Project Overview" at the top left → **Project settings**.
2. Scroll down to **"Your apps"**. Click the **`</>` (web)** icon.
3. Give the app a nickname like `fwc26-web`. Click **Register app**. (You can skip Firebase Hosting — leave it unchecked.)
4. Firebase shows you a block of code that looks like this:

```js
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "fwc26-pool.firebaseapp.com",
  projectId: "fwc26-pool",
  storageBucket: "fwc26-pool.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc123"
};
```

**Copy this whole block** — you'll paste it in the next step.

### Step 5 — Paste it into the website files

1. On your computer, **unzip** the `fwc26-predictions.zip` you got.
2. Open the file `assets/js/firebase-config.js` in any text editor (Notepad, TextEdit, VS Code — doesn't matter).
3. Replace the placeholder `firebaseConfig` block with the one you copied from Firebase. Keep the `export const` at the start.
4. **Change the `ADMIN_PASSWORD`** from `"change-this-password"` to something only you know. Write it down somewhere — you'll need it later.
5. (Optional) update `CONTACT_EMAIL` to your real email address.
6. Save the file.

### Step 6 — Put the site on the internet (GitHub Pages, also free)

1. Go to **<https://github.com>** and sign in.
2. Click the **+** in the top right → **New repository**.
3. Name it `fwc26-pool`. Make it **Private** (important — your admin password is inside it). Click **Create repository**.
4. On the next page you'll see "Quick setup" — look for the **"uploading an existing file"** link. Click it.
5. Drag and drop **all the files inside your unzipped `fwc26-predictions` folder** (not the folder itself — the files inside it: `index.html`, `README.md`, the `assets` folder, etc.) into the GitHub web page.
6. Scroll down and click **Commit changes**.
7. Click **Settings** (top of the repo). In the left sidebar click **Pages**.
8. Under "Build and deployment" → "Source", select **Deploy from a branch**. Under "Branch", select **main** and **/(root)**. Click **Save**.
9. Wait ~2 minutes. Refresh the Pages settings page. You'll see a green box with your live URL — something like `https://yourname.github.io/fwc26-pool/`.

**That's your website!** Open it in a browser.

### Step 7 — Generate the 100 access codes

1. On your live site, click **Admin access** at the bottom of the login screen.
2. Enter the `ADMIN_PASSWORD` you set in Step 5.
3. Click the **Setup** tab at the top.
4. Click **Generate & seed 100 codes**.
5. A black box appears with all 100 codes. **Copy them all and save them in a Notes app or text file.** They're shown once in this form — after this you can still see them in the Codes tab, but better to have a backup.

You're done with setup! 🎉

---

## 🟡 Giving out codes

- Each player gets **one code**. Send it to them however (WhatsApp, text, email).
- They go to your site, enter the code and their name, and they're in.
- A code locks to whoever uses it first. They can come back any time with the same code + name to update their predictions.
- If a friend hasn't got a code, they can click **"I don't have a code"** on the login page — it opens a pre-written email to you asking for one.

---

## 🔵 How to run things as admin (during the tournament)

Sign in via the **Admin access** button on the login page. Enter your password. You'll see four tabs:

### 1. Leaderboard tab
Shows every player ranked by points. Refreshes when you click into it. Use this to see who's winning.

### 2. Enter results tab
This is where you tell the site what actually happened. **Update this after each match finishes**, or batch it once a day.

- **Group stage section**: scroll to the match, type the final score in the two number boxes (e.g. `2` and `1`). The H/D/A buttons auto-select based on the score. Tap a different one if you want to override (e.g. for a penalty-shootout decision, although in group stage that shouldn't happen).
- **Knockout sections**: each round (R32, R16, QF, SF, Finalists) shows all 48 teams. Click the team chips to mark which teams **actually reached** that round. So when the Round of 32 is locked in, click the 32 teams that got through. When R16 starts, click the 16 that made it. Same idea up the bracket.
- **Trophy section**: pick the Champion from the dropdown when the final's done, and the 3rd-place team after the bronze final.

Everything auto-saves about half a second after you stop clicking. The leaderboard recalculates automatically.

### 3. Codes tab
Shows all 100 codes with who's claimed each one. Useful if a friend forgets their code — you can find it by their name. Also useful to see how many people have signed up.

### 4. Setup tab
You already used this in Step 7. Don't re-run unless you want to wipe everything and start fresh.

### Scoring (so you know what you're awarding)

| Action | Points |
| --- | --- |
| Correct group-stage winner (or draw) | **+3** |
| Correct exact score on top of that | **+7** (so an exact score = 10 total) |
| Each team correctly predicted to make R32 | +2 each |
| ... R16 | +4 each |
| ... Quarter-finals | +7 each |
| ... Semi-finals | +12 each |
| ... The Final | +20 each |
| Correct 3rd place (bronze final winner) | +25 |
| **Correct Champion** | **+40** |

The player with the most points when the tournament ends wins the prize.

---

## 🟣 Common questions

**"Someone's code isn't working."**
Make sure they're typing it exactly as you sent it — codes are uppercase letters + numbers, no `0` (zero), `O` (capital o), `1` (one), or `I` (capital i) because those look the same. If it still won't work, check the Codes tab — if the code isn't there, generate more (rerun Setup will wipe existing claims though — easier to just give them a different unclaimed code).

**"I want to test the site myself without using a real code."**
Type `test` (lowercase or any case) in the code field with any name. You'll get into the app like a normal player, and you'll show at the top of your own leaderboard so you can see what winning looks like. Don't tell anyone about this — it's just for you to check things behind the scenes.

**"How do I change the prize, or the scoring?"**
Prize is decided offline — just tell people what they're playing for. Scoring lives in `assets/js/data.js` under the `SCORING` object — change any number, recommit, refresh.

**"I broke something / want to start over."**
In Firebase console → Firestore Database, you can delete the `codes`, `predictions`, and `results` collections to wipe everything. Then run the Setup tab again.

**"My GitHub Pages site shows 404."**
Wait a couple more minutes — the first deploy can take up to 10 mins. Also check the URL ends in `/` (some browsers drop it).

---

## File map

```
fwc26-predictions/
├── index.html              ← the website itself (don't edit unless you know HTML)
├── README.md               ← this file
├── .gitignore              ← tells GitHub what to ignore
└── assets/
    ├── css/style.css       ← styling
    └── js/
        ├── app.js          ← the app logic
        ├── data.js         ← all 104 matches + scoring rules
        └── firebase-config.js  ← ★ THE ONE FILE YOU EDIT ★
```

---

Good luck. May the most psychic friend win. 🏆
