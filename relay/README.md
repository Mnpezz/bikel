# Bikel Dedicated Nostr Relay (strfry)

This toolkit provides everything you need to easily spin up your own hyper-fast, dedicated Nostr relay specifically for Open Cycling Data (or any other whitelisted events you choose). 

It is built on top of [strfry](https://github.com/hoytech/strfry), featuring a high-performance C++ core backed by LMDB, and utilizes a lightweight JavaScript ingestion filter to strictly block global network spam, ensuring your server disk remains completely lean and affordable.

## Prerequisites
- A cloud VPS (Virtual Private Server) like Hetzner, DigitalOcean, or AWS EC2. Hetzner is highly recommended for cost-to-performance ratio in Nostr workloads.
- Docker & Docker Compose installed on the VPS.
- A domain name (e.g., `bikel.ink`).

### DNS Setup (Example: Vercel Nameservers)
Since Bikel uses Vercel for primary DNS, you handle the relay subdomain directly in your Vercel Dashboard:

1. Go to **Vercel Dashboard > Domains > bikel.ink**.
2. Click **DNS Records**.
3. Add a new **A Record**:
   - **Name**: `relay`
   - **Value**: `89.167.00.555` (Your Hetzner IP)
   - **TTL**: 60
   
This configuration allows Vercel to manage your global HTTPS traffic for the web app while instantly routing `wss://relay.bikel.ink` to your high-performance Hetzner node.

## Step 2: Configure Caddy (Auto-SSL)
In this directory, open the `Caddyfile`. Replace `relay.bikel.ink` with your actual subdomain (e.g., `relay.yourcustomdomain.com`).

```caddyfile
relay.yourdomain.com {
    reverse_proxy strfry:7777
}
```
Caddy will flawlessly handle generating your free Let's Encrypt SSL certificates automatically upon boot, ensuring strict browser requirements for `wss://` secure sockets are instantly met.

## Step 3: Deployment
Upload this entire `/relay` directory to your Hetzner VPS (you can use `scp`, `rsync`, or Git).
Once inside the directory on your server, simply run:

```bash
docker compose up -d
```
This builds the custom container (injecting the Node JS runtime), boots the strfry database, and spins up Caddy to secure the endpoint. Your relay is now fully live!

## Step 4: Backfill Historic Data (Optional but Recommended)
If you want your shiny new relay to instantly possess *100% of all historic Bikel and Runstr rides* ever posted globally, you can run the provided scraper script. This searches the top public relays (Damus, Nos.lol, etc.) and injects the global payload right into your new instance.

You can run this directly on your development machine or the server. First, ensure dependencies are installed:
```bash
npm install
```
Then, execute the backfill script:
```bash
npm run backfill
```

## Advanced: Modifying the Spam Whitelist
By default, this relay strictly rejects 99.9% of Nostr traffic. It uses the `filter.js` script to manually vet every single incoming connection.

If you ever wish to expand your relay to accept other types of data (like Long-Form Articles, Badges, or Microblogging):
1. Open `filter.js`.
2. Locate the Whitelist condition logic (`if (ev.kind === 1301 || ... )`).
3. Add the Nostr Event Kinds you wish to accept (e.g., `if (ev.kind === 1) accept = true;` to allow global text posts).
4. Save the file and restart the docker container: `docker compose restart strfry`.

## 🛠️ Infrastructure Tuning (Critical for High Throughput)
Modern Nostr relays require a high number of simultaneous open connections. Most VPS providers cap this at a value too low for `strfry` to start by default.

### 1. Increase Host Limits
Run these with **root/sudo** on your Hetzner server to prevent the relay from crashing on startup:
```bash
# Increase global file limit
grep -q "fs.file-max" /etc/sysctl.conf || echo "fs.file-max = 1000000" >> /etc/sysctl.conf && sysctl -p

# Increase user session limits
echo "* soft nofile 1000000" >> /etc/security/limits.conf
echo "* hard nofile 1000000" >> /etc/security/limits.conf

# Restart Docker to apply (Important!)
systemctl restart docker
```

## 📊 Monitoring & Maintenance
 
All of these commands should be run from within your **`~/bikel/relay`** directory:

### 1. Check Event Count
Verify precisely how many events are stored in your database:
```bash
docker exec bikel-relay /app/strfry scan '{}' | wc -l
```

### 2. Live Filters & Spam Check
Watch which events are being accepted or rejected by your `filter.js` in real-time:
```bash
docker logs -f bikel-relay
```

### 3. Relay Branding (NIP-11)
To update the landing page name, description, or contact info, edit the `relay.info` block in `strfry.conf` and restart:
```bash
docker compose restart strfry
```

### 4. Updating the Relay
To pull the latest high-performance `strfry` improvements:
```bash
docker compose pull
docker compose up -d
```
