# Bikel 🚲⚡
**Bikel** is an open-source, decentralized mapping and geolocation ecosystem natively built on the Nostr network. It allows cyclists and athletes to passively track rides, overlay photos, organize alleycat races, and distribute lightning-fast Bitcoin micro-payments—all entirely free from traditional proprietary fitness trackers.
Because Bikel uses Nostr and `NIP-52` Time-Based events, your location data belongs permanently to your cryptographic identity. You are free to take your maps to any client or relay you choose## 🏗️ Architecture
The Bikel platform is divided into four independent components that communicate symbiotically over Nostr websocket relays:

1. **`apk/` (The Mobile Tracker)**
    - Built natively in React Native & Expo. Standardized on **NIP-1301** for fitness activities.
    - Features background GPS tracking, "Privacy Tail-Trimming," and automatic key generation.
    - Optimized for your dedicated relay to ensure zero-latency ride publishing.

2. **`web/` (The Global Dashboard)**
    - React + Vite dashboard for map overlays, NWC zapping, and CC0 data exports.
    - Acts as a social hub for RSVPs, scheduling, and ride discussions.

3. **`relay/` (The Sovereign Backbone)**
    - **New**: A dedicated, high-performance `strfry` (C++) relay hosted on Hetzner.
    - Features a strict whitelist (`filter.js`) to block network spam and prioritize cycling data.
    - Powers the ecosystem with 1,000,000+ simultaneous connection support.

4. **`backend/` (The Escrow Bot)**
    - Node.js bot for managing automated prize pools and contest payouts.

---
## 🚀 Quickstart Guides

### 1. Dedicated Relay (`/relay`)
Launch your own sovereign data infrastructure:
```bash
cd relay
docker compose up -d
```
*See [relay/README.md](./relay/README.md) for host-tuning and DNS instructions.*

### 2. Web Frontend (`/web`)
```bash
cd web
npm install && npm run dev
```

### 3. Escrow Node (`/backend`)
```bash
cd backend
npm install && npm run start
```

### 4. Compiling the APK (`/apk`)
To sideload the native `.apk` straight onto your Android, ensure your phone is on the same WiFi network and USB/wireless debugging is enabled. Then run:
```bash
cd apk
./install.sh --release
```
*This script automates the Expo prebuild, Gradle compilation, and APK sideloading.*

---
## 🗺️ Nostr Event Kinds
| Kind | Purpose |
|------|---------|
| `1301` | **Primary**: Fitness Activity (NIP-1301) |
| `33301` | Legacy Bikel Ride events (Supported for backfill) |
| `31923` | Scheduled group rides (NIP-52) |
| `31925` | RSVPs for scheduled rides |
| `33401` | Challenge events (Custom Bikel kind) |
| `5` | Deletion requests |
| `4` | Encrypted DMs |
| `1` | Ride comments / Discussion |

---
## 📐 Kind 1301 — Fitness Activity (Primary Standard)
Bikel has adopted **NIP-1301** as its primary data standard. This ensures compatibility with the broader Nostr fitness ecosystem while maintaining the high-resolution geometry Bikel is known for.

- **Storage**: Rides are broadcast to `wss://relay.bikel.ink` (and public relays).
- **Format**: Uses standard tags for `distance`, `duration`, and `sport`.
- **Legacy**: `kind: 33301` is still fully supported for reading historical data.

---
## 💡 Philosophy
Bikel ensures structural autonomy by keeping its layers entirely decoupled. By hosting your own **dedicated relay**, you ensure your data is never pruned by public relays and your community always has a fast, reliable place to call home.

You are highly encouraged to fork, audit, reskin, and deploy your own variations of all four instances for your local cycling clubs. Happy Riding! 🚴