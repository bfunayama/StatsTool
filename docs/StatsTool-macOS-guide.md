# StatsTool — How to run it on your Mac

A short, non-technical guide. You don't need to install anything, use GitHub, or
type any commands. Everything runs **on your own Mac** — your data never leaves
your computer.

---

## 1. What you'll receive

A file called **`StatsTool.zip`** (shared via Teams/OneDrive/email).

## 2. Open it (one-time setup, ~1 minute)

1. **Double-click `StatsTool.zip`** to unzip it. You'll get an app called
   **`StatsTool`**.
2. Drag **`StatsTool`** into your **Applications** folder (optional, but tidy).
3. **The first time only**, macOS will not let you open it with a normal
   double-click because it's an internal tool (not from the App Store). Instead:
   - **Right-click** (or Control-click) the **StatsTool** icon.
   - Choose **Open**.
   - In the pop-up, click **Open** again.

   > You only have to do this once. After that, a normal double-click works.

   If you see **"StatsTool is damaged and can't be opened"**, see Troubleshooting
   below.

## 3. Use it

- When StatsTool starts, **your web browser opens automatically** to the tool
  (at an address like `http://localhost:8000`). If a tab doesn't open on its own,
  open your browser and go to **http://localhost:8000**.
- Click **Import** in the app to load one of your own data files (`.csv`).
- Build crosstabs, filters, weights, code open-ended text, etc.

## 4. Where your data lives (and privacy)

- **Your data stays on your Mac.** Nothing is uploaded anywhere.
- When you import a file, StatsTool reads it locally and saves its working copy in:
  `~/Library/Application Support/StatsTool/data`
  (a private folder in your user account, not synced to iCloud).
- Your original files stay wherever you keep them.

## 5. Quitting StatsTool

- StatsTool runs quietly in the background while its browser tab is open.
- To stop it: **right-click the StatsTool icon in the Dock → Quit** (or press
  **⌘-Q** while it's the active app). Closing the browser tab alone does **not**
  stop it.

---

## Troubleshooting

**"StatsTool is damaged and can't be opened" / "cannot be opened because the
developer cannot be verified"**
This is macOS being cautious about an internal (unsigned) app. Ask the person who
sent you the app — they can clear this before sending, or you can:
1. Open **System Settings → Privacy & Security**.
2. Scroll down; near the bottom you'll see a note about StatsTool being blocked.
3. Click **Open Anyway**, then confirm.

**The browser tab didn't open**
Open your browser manually and go to **http://localhost:8000**. (If that doesn't
work, the app may have picked a different address — quit it from the Dock and
reopen.)

**It won't start / seems stuck**
Quit it from the Dock (right-click → Quit), wait a few seconds, and open it again.

**A blank page or an error after an update**
Refresh the browser tab (**⌘-R**).

---

## Giving feedback

Please note anything confusing, broken, or missing — screenshots help a lot.
Send feedback via **[your team's channel / shared doc / form — fill this in]**.
Include: what you were doing, what you expected, and what happened.

Thanks for testing!
