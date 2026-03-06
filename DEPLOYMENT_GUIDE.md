# Bikel - Production Deployment & Publishing Guide

This guide covers exactly how to publish Bikel to GitHub safely, and how to separately host the Web and Backend components. 

## 1. Publishing to GitHub (Safely)

You should publish the **entire folder** to GitHub, but **exclude** all dependencies and secrets. I have already configured the `.gitignore` files in your project to handle this automatically!

When you commit, Git will inherently **ignore**:
- ❌ All `node_modules/` (they are huge and meant to be installed locally)
- ❌ All `.env` files (protecting your Coinos API Key and Bot NSEC)
- ❌ `.DS_Store` and IDE files (like `.idea`)
- ❌ Build outputs like `dist/`

### Step-by-Step GitHub Push:
1. Open your terminal in the `/bikel` root folder.
2. Initialize Git (if you haven't already):
   ```bash
   git init
   ```
3. Add all files to staging:
   ```bash
   git add .
   ```
4. Check what is being committed (make sure `.env` and `node_modules` are NOT in the green list):
   ```bash
   git status
   ```
5. Commit your code:
   ```bash
   git commit -m "Initial Bikel Open Source Release"
   ```
6. Go to GitHub.com, click "New Repository", name it `bikel`, and make it **Public**.
7. Copy the commands GitHub gives you to "push an existing repository from the command line" and run them. Example:
   ```bash
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/bikel.git
   git push -u origin main
   ```

---

## 2. Web Client Hosting (Vercel)

Vercel is the easiest and best way to host your React/Vite frontend (`/web`).

1. Go to [Vercel.com](https://vercel.com) and log in with your GitHub account.
2. Click **Add New Project**.
3. Import your new `bikel` GitHub repository.
4. **CRITICAL STEP**: In the "Root Directory" section, click Edit and select the `web` folder.
5. Vercel will automatically detect that it's a "Vite" project.
6. Click **Deploy**. Vercel will build your React app and give you a live HTTPS URL instantly! Every time you push an update to GitHub, Vercel will automatically update the site.

---

## 3. Escrow Bot Hosting (Hetzner VPS)

Because the `/backend` Bot needs an infinite server process (to constantly listen to Nostr Relays for RSVPs via WebSockets), it cannot run on Vercel. We will put it on a dedicated Hetzner Ubuntu server.

1. Go to [Hetzner Cloud](https://www.hetzner.com/cloud) and create a cheap Ubuntu VPS (the ~$4/month option is perfect).
2. Once deployed, open your terminal and SSH into the server:
   ```bash
   ssh root@<YOUR_HETZNER_IP_ADDRESS>
   ```
3. Install Node.js and Git on the server:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   ```
4. Clone your public GitHub repository:
   ```bash
   git clone https://github.com/mnpezz/bikel.git
   cd bikel/backend
   ```
5. Install the backend dependencies:
   ```bash
   npm install
   ```
6. **Re-create your secret `.env` file!** (Since it wasn't pushed to GitHub):
   ```bash
   nano .env
   ```
   *Paste your `COINOS_API_KEY` and `BOT_NSEC` into this file, just like you have locally. Press `CTRL+X`, then `Y`, then `Enter` to save.*
7. Use **PM2** to run the bot forever in the background:
   ```bash
   sudo npm install -g pm2
   pm2 start index.js --name "bikel-bot"
   pm2 save
   pm2 startup
   ```
   *Your bot is now live and will automatically restart even if the server reboots!*

---

## 4. Mobile App Distribution (GitHub Releases)

1. Go to your `bikel` repository on GitHub.
2. Look at the right sidebar and click **Releases**.
3. Click **Draft a new release**.
4. Create a tag (e.g., `v1.0.0`) and add a title and description.
5. Drag and drop your compiled `/apk/app-release.apk` file into the "Attach binaries" box.
6. Click **Publish release**. Users can now download your exact APK directly from GitHub!
