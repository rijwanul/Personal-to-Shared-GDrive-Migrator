<div align="center">

# 📁 Google Drive Bulk Mover & Smart Migrator

**A Google Apps Script toolkit for bulk-moving Drive files and safely migrating whole folder trees into a Shared Drive.**

[![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-4285F4?style=flat&logo=google&logoColor=white)](https://developers.google.com/apps-script)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg?style=flat)](LICENSE)
[![Made for Google Drive](https://img.shields.io/badge/Made%20for-Google%20Drive-34A853?style=flat&logo=googledrive&logoColor=white)](https://drive.google.com)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat)](../../pulls)
[![Last Commit](https://img.shields.io/github/last-commit/rijwanul/Personal-to-Shared-GDrive-Migrator?style=flat)](../../commits/main)
[![Issues](https://img.shields.io/github/issues/rijwanul/Personal-to-Shared-GDrive-Migrator?style=flat)](../../issues)
[![Website](https://img.shields.io/badge/website-rijwanul.com-1a73e8?style=flat&logo=googlechrome&logoColor=white)](https://rijwanul.com)

![Visitors](https://visitor-badge.laobi.icu/badge?page_id=rijwanul.Personal-to-Shared-GDrive-Migrator)

</div>

> This repo is licensed under **ISC** — see the [`LICENSE`](LICENSE) file for the full text.
>
> Built by [**Rijwanul Hoque**](https://rijwanul.com) — 🌐 [rijwanul.com](https://rijwanul.com)

---

## 📚 Table of Contents

- [✨ What it does](#-what-it-does)
- [🛠️ Setup](#️-setup)
- [🚀 Using it](#-using-it)
- [⚙️ Configuration](#️-configuration)
- [⚠️ Limitations & things to know](#️-limitations--things-to-know)
- [🗂️ File overview](#️-file-overview)
- [📄 License](#-license)

---

## ✨ What it does

A single Apps Script project that powers **two tools**:

| Tool | Purpose |
|---|---|
| 📦 **Simple Mover** | Bulk-move a list of Drive files/folders into a target folder — via a web app UI or a Google Sheet menu. |
| 🧠 **Smart Migrate to Shared Drive** | Safely migrate a whole personal-Drive folder into a Shared Drive, automatically working around Google's two most common blockers. |

It can run entirely in your browser, or **in the background on Google's own servers** — so it survives a closed tab, a lost connection, or your computer being switched off — with a daily runtime cap, automatic pause/resume, and optional email notifications (with CC).

### 📦 Simple Mover

Give it a list of file/folder URLs and a target folder URL. It moves each item — for a folder URL, it moves the folder's **direct contents**, not the folder itself.

### 🧠 Smart Migrate to Shared Drive

Give it a **source folder** (personal Drive) and a **target folder** (inside a Shared Drive). Here's what happens:

1. 📂 Creates `[SD] <source folder name>` inside the target.
2. 📂 Creates a single `[Unmovable] <source folder name>` folder inside the **source**.
3. 🔁 Walks the source folder tree, and for each subfolder:

   | Step | What happens |
   |---|---|
   | ✅ **Try whole move** | Fastest path — used whenever nothing blocks it. |
   | 🚧 **If blocked** (a file owned by someone else) | Walks the subtree; for every foreign-owned file, optionally copies it right next to itself (owned by you, so it can move) and moves the original into the root `[Unmovable]` folder. Then retries the whole-folder move. |
   | 🕵️ **If still blocked** (most often a hidden file you can't see) | Recreates the folder inside the Shared Drive and processes its contents individually. Once everything visible has been dealt with, the leftover original is resolved: |

   - if it's now genuinely **empty** → 🗑️ trashed.
   - if something is still inside it (couldn't be moved, copied, or even parked) → 📦 the whole folder is moved as-is into `[Unmovable] ▸ Hidden Files in Folders`, so **nothing is ever lost or silently deleted** — it's left intact for manual review.

4. 🔗 Creates a shortcut to `[SD] <source folder name>` inside the original source folder, so anyone browsing the personal Drive can find where things went.
5. 📊 Reports counts: files moved, folders moved whole, folders recreated, empty folders cleaned up, folders moved to `Hidden Files in Folders`, files parked as unmovable, files copied, and errors.

---

## 🛠️ Setup

### 1️⃣ Create the Apps Script project

- **Standalone script**, or
- **Bound to a Google Sheet** *(adds a "Drive Tools" menu)*

Either works — the Sheet menu is optional and only adds a convenient entry point.

### 2️⃣ Add the files

Copy each file below into a matching file in the Apps Script editor:

| Repo file | Apps Script file | Type |
|---|---|---|
| `Code.gs` | `Code.gs` | 📜 Script |
| `Index.html` | `Index` | 🌐 HTML |
| `MigrateModal.html` | `MigrateModal` | 🌐 HTML |
| `SheetMoveModal.html` | `SheetMoveModal` | 🌐 HTML |

Use **+ → HTML** in the editor to create each new HTML file, and give it the exact name in the table above (no `.html` needed when naming — the editor adds it).

### 3️⃣ Enable the Drive API advanced service

The shortcut created at the end of a migration needs Drive API v3:

1. Click **+** next to **Services** in the left sidebar.
2. Select **Drive API**.
3. Set **Version** to **v3**.
4. Leave the identifier as `Drive`.
5. Click **Add**.

### 4️⃣ Authorize

Run any function once from the editor (e.g. `onOpen`) and approve the permissions. Background mode needs:

- 🔑 Manage your Drive files
- ⏰ Manage triggers for your Google account
- 📧 Send email as you

### 5️⃣ Deploy as a web app *(optional, for the browser UI)*

**Deploy → New deployment → Web app**

- Execute as: **Me**
- Who has access: your choice (e.g. "Only myself" or "Anyone within [your org]")

If you're bound to a Sheet, you also get the **Drive Tools** menu automatically (reload the Sheet after first deploying).

### 6️⃣ Redeploying after changes

Editing `Code.gs` or the HTML files doesn't update the web app URL's live version by itself:

> **Deploy → Manage deployments → ✏️ Edit existing deployment → Version: New version → Deploy**

The Sheet menu and background triggers always run the latest saved code — no redeploy needed for those.

---

## 🚀 Using it

### 📦 Simple Mover

Paste file/folder URLs (one per line) and a target folder URL, then click **Move Items**.

### 🧠 Smart Migrate

1. Enter the **source** folder URL (personal Drive) and **target** folder URL (inside a Shared Drive).
2. Choose whether to copy files owned by other people into the Shared Drive *(recommended, on by default)* — originals are parked in `[Unmovable]`.
3. Choose whether to run in the **background** *(recommended, on by default)* — see below.
4. Optionally add CC email addresses and pick which events to be notified about (Paused / Resumed / Completed).
5. Click **Start Migration**.

The page shows live progress: a folder-based progress bar, a running log, and — in background mode — a badge showing whether the trigger is active and how much of the daily runtime budget has been used.

<details>
<summary>⏳ <strong>Background mode</strong> (click to expand)</summary>
<br>

Background mode uses a time-driven Apps Script trigger (runs about once a minute) so the migration continues even if you close the browser, your computer sleeps, or you lose power. It's capped at a configurable daily runtime — default **75 minutes**, safely under Google's ~90 minute/day trigger quota for consumer `@gmail.com` accounts.

When the cap is hit:

- ⏸️ The migration **pauses** and saves its exact progress.
- 🔄 A one-time trigger is scheduled to resume it *(default **24 hours** later)*.
- 📧 You get an email *(if enabled)* stating the exact resume time.
- ▶️ It resumes automatically — no action needed.

You can also click **Continue Migration** yourself at any time while paused. That runs through your open browser rather than waiting for the scheduled resume, so it isn't blocked by the daily-limit pause — but it still shares Google's other per-day script/Drive quotas, so it can occasionally get stuck or fail if those happen to be exhausted too.

</details>

<details>
<summary>👥 <strong>Only one migration at a time</strong> (click to expand)</summary>
<br>

State is stored per Google account, so if a teammate opens the tool while signed in to the same account, they'll see the same migration's live progress and a banner explaining that a new migration can't be started until the current one finishes.

</details>

<details>
<summary>✉️ <strong>Editing email settings mid-migration</strong> (click to expand)</summary>
<br>

You can add/remove CC recipients and toggle which events send an email (Paused / Resumed / Completed) at any time — before starting, or while a migration is running or paused. Updating these settings only touches saved preferences; it doesn't interrupt the migration in progress.

</details>

---

## ⚙️ Configuration

At the top of `Code.gs`:

```javascript
var DAILY_RUNTIME_LIMIT_MIN = 75;   // background runtime cap per day, in minutes
var PAUSE_HOURS = 24;               // how long to wait before auto-resuming
var DISPLAY_TZ = 'Asia/Dhaka';      // timezone used in emails and on-page times
```

Adjust these to fit your account type — Google Workspace accounts get a much larger daily trigger quota than consumer `@gmail.com` accounts — and your timezone.

---

## ⚠️ Limitations & things to know

| ⚠️ | Note |
|---|---|
| 🔍 | **Quota detection is best-effort.** The script tracks its own runtime and pauses before hitting Google's cap, but it can't see the account-wide quota directly, and it can't tell you about a cutoff that happens before it gets a chance to run. Repeated failures (5 in a row) stop background mode and send an email — but a hard trigger cutoff with zero executions produces no error to catch. |
| 🖱️ | **Manual "Continue" during a pause** is not blocked by the daily-limit pause (it runs through your browser), but it still shares Google's other daily script/Drive quotas and can fail if those are exhausted. |
| 👻 | **Hidden files stay hidden.** If a source folder contains a file the script genuinely cannot see, it's left behind — the script can't discover what it can't enumerate. The folder that contained it is recreated in the Shared Drive so everything visible still migrates; the leftover original is trashed only if it ends up empty, otherwise moved into `[Unmovable] ▸ Hidden Files in Folders`. |
| 🤔 | **"Hidden files?" is a best guess, not a confirmed diagnosis.** The script can't directly detect a hidden file — it only knows a whole-folder move still failed after every visible problem was cleared. Other causes (a Shared Drive limit, a permission edge case, a transient API error) can produce the same symptom. Treat `Hidden Files in Folders` as "needs a manual look," not strictly "contains a hidden file." |
| 🚫 | **Foreign-owned files that can't even be copied** (copying disabled by the owner) are left in the source as a parked, unmovable original — nothing is silently dropped, but check the log / `[Unmovable]` folder afterward. |
| 🔒 | **One migration at a time, per Google account.** This is intentional — it prevents duplicate `[SD]` folders from concurrent starts — not a bug. |
| 📧 | **Email delivery uses `MailApp`**, which has its own daily sending limit, separate from the trigger runtime limit. |

---

## 🗂️ File overview

```
📦 your-project
 ┣ 📜 Code.gs              → All server-side logic: Simple Mover, the Smart Migrate
 ┃                            engine (queue-based, resumable, lock-protected),
 ┃                            background triggers, daily-limit pause/resume,
 ┃                            and email notifications.
 ┣ 🌐 Index.html            → Web app UI (Simple Mover + Smart Migrate tabs).
 ┣ 🌐 MigrateModal.html     → Smart Migrate dialog opened from the Sheet menu.
 ┗ 🌐 SheetMoveModal.html   → Simple Mover dialog opened from the Sheet menu
                               (reads URLs from column B of the active sheet).
```

---

## 📄 License

Licensed under the **[ISC License](https://choosealicense.com/licenses/isc/)** — a short, permissive license functionally equivalent to MIT. See [`LICENSE`](LICENSE) for the full text.

---

<div align="center">

Made with 🧰 Apps Script and a healthy respect for Google's daily quotas.

</div>
