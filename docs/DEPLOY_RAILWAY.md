# 🚄 Run FelFelChat on Railway — Step-by-Step Guide

This guide gets a fully working FelFelChat (chat + voice calls + admin panel) running on **Railway** using **100% free tiers**. It takes about **15 minutes**.

**How it works:** Railway runs the app (one service), MongoDB Atlas (free M0) stores the data. The repo already contains a `railway.json` that configures everything — you only set 4 variables.

> ✅ Tested: production build passes and the exact startup path Railway uses (schema sync → seed → boot) was verified end-to-end with a real MongoDB replica set: `npm run test:e2e` → 8/8 checks passed.

---

## Step 1 — Create the free database (MongoDB Atlas)

1. Go to **https://www.mongodb.com/cloud/atlas/register** and sign up (no credit card needed).
2. It asks "What are you building?" / "Where will you host?" — pick any answer, then choose the **M0 FREE** cluster (the default) and click **Create**.
3. While the cluster builds, open **Database Access** (left sidebar) → **+ Add New Database User**:
   - Authentication method: **Password**
   - Pick a username (e.g. `felfel`) and a password (save it, you'll need it in Step 3)
   - Role: **Read and write to any database**
   - Click **Add User**
4. Open **Network Access** → **+ Add IP Address** → click **ALLOW ACCESS FROM ANYWHERE** (`0.0.0.0/0`) → **Confirm**.
   (Railway's servers don't have a fixed IP, so this is required. Your data is still protected by the username/password.)
5. Go to **Database** → click **Connect** on your cluster → choose **Drivers** → copy the connection string. It looks like:
   ```
   mongodb+srv://felfel:<password>@cluster0.abc123.mongodb.net/?retryWrites=true&w=majority
   ```
6. Edit it: replace `<password>` with the real password, and add the database name right after `.net` so it ends with `/felfelchat?`:
   ```
   mongodb+srv://felfel:MyStr0ngPass@cluster0.abc123.mongodb.net/felfelchat?retryWrites=true&w=majority
   ```
   **Keep this string — this is your `DATABASE_URL`.**

> ⚠️ Why Atlas? Prisma's MongoDB connector requires a **replica set**. Atlas has one built in; Railway's own MongoDB image does not by default.

---

## Step 2 — Create the Railway project

1. Push this repository to your GitHub account (if it isn't already).
2. Go to **https://railway.app** and sign in with GitHub.
3. Click **New Project** → **Deploy from GitHub repo** → select this repo.
   Railway detects `railway.json` and uses its build/start commands automatically — no configuration needed.
4. The first build will run, but the deploy will **crash** (or restart-loop). That's expected — the required variables don't exist yet. Continue to Step 3.

---

## Step 3 — Set the environment variables

Open your service in Railway → **Variables** tab → **+ New Variable**, and add these four:

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | the Atlas string from Step 1 | must contain `/felfelchat` before the `?` |
| `JWT_SECRET` | any long random text | e.g. run `openssl rand -hex 32` in a terminal and paste the output |
| `BACKUP_SIGNING_KEY` | another long random text | same as above, different value |
| `APP_ORIGIN` | leave empty for now | you'll fill it in Step 5, after Railway gives you a domain |

Tip: Railway can generate random values for you — when adding a variable, click **Add Reference / Generator** → **Random String** if you prefer.

Railway redeploys automatically whenever you change variables.

---

## Step 4 — First deploy & verify

1. Go to the **Deployments** tab and wait for the build to finish (a few minutes).
2. Open the deploy logs. You should see, in order:
   - `prisma db push ... in sync` (schema created in Atlas)
   - `Seeded superadmin: admin`
   - `server.started`
3. Railway runs a health check on `/api/health` — the deploy turns green when it passes.

---

## Step 5 — Get your public URL and finish setup

1. Go to **Settings** → **Networking** → **Generate Domain**. Railway gives you something like `https://felfelchat-production.up.railway.app` (port is auto-detected).
2. Open it in your browser — the app should load and you can log in.
3. Go back to **Variables** and set `APP_ORIGIN` to that exact URL **with https**:
   ```
   APP_ORIGIN=https://felfelchat-production.up.railway.app
   ```
   This enables the secure auth cookie. The app redeploys automatically.
4. Log in with the seeded superadmin:
   - username: `admin`
   - password: `admin123`
5. **Change the password immediately** (Profile page or the admin panel) — the whole internet can reach your signup page otherwise.
6. Optional: in the admin panel → **Settings**, turn **registration off** once your friends have accounts.

Done — chat, voice calls, file uploads, stickers, and the admin panel are live. 🎉

---

## Optional settings

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_WEBRTC_TURN_URLS` / `_USERNAME` / `_CREDENTIAL` | TURN server for reliable voice calls behind strict NAT/firewalls (e.g. free tier from [Metered](https://www.metered.ca/tools/openrelay/) or [Xirsys](https://xirsys.com)) |
| `SENTRY_DSN` | error monitoring |
| `UPLOAD_MAX_SIZE_MB` | max upload size (default 20) |

**Keeping uploaded files across redeploys:** uploads live on local disk. To persist them, mount a Railway volume (Service → Settings → Volumes) and set `UPLOAD_DIR`/`BACKUP_DIR` to the mounted path (e.g. `/data/uploads`).

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Deploy fails at `prisma db push` with `Server selection timeout` | `DATABASE_URL` is wrong or Atlas Network Access isn't set to `0.0.0.0/0`. Re-check Step 1.3–1.4. |
| `error: Environment variable not found: DATABASE_URL` | The variable name is misspelled, or you added it to a different service. |
| Login loop / logged out on every click | `APP_ORIGIN` doesn't start with `https://` (cookie stays insecure). Set it exactly as in Step 5.3. |
| Voice calls don't connect | Add TURN credentials (see optional settings). Calls work out-of-the-box only on permissive networks. |
| Server restarts every few minutes | Check Deployments → Logs for the crash; most often it's an invalid `DATABASE_URL`. Railway restarts the service automatically (up to 10 tries). |
| Wrong password / forgotten superadmin password | Redeploy after deleting the `User` collection in Atlas (Database → Browse Collections), which re-seeds `admin / admin123`; or change it from the admin panel while logged in. |

---

## Updating your deployment

Push to `main` on GitHub → Railway rebuilds and redeploys automatically. Schema changes are applied on deploy via `prisma db push`.
