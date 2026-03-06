# Bikel 🚲⚡

**Bikel** is an open-source, decentralized mapping and geolocation ecosystem natively built on the Nostr network. It allows cyclists and athletes to passively track rides, overlay photos, organize alleycat races, and distribute lightning-fast Bitcoin micro-payments—all entirely free from traditional proprietary fitness trackers.

Because Bikel uses Nostr and `NIP-52` Time-Based events, your location data belongs permanently to your cryptographic identity. You are free to take your maps to any client or relay you choose.

---

## 🏗️ Architecture

The Bikel platform is divided into three completely independent applications that communicate symbiotically over Nostr websocket relays:

1. **`apk/` (The Mobile Tracker)**
    - Built completely natively in React Native & Expo. 
    - Designed to run seamlessly in your pocket, utilizing Background GPS location tracking algorithms to constantly gather high-resolution `lat/lng` traces.
    - Features user-configurable "Privacy Tail-Trimming" logic (dropping the first and last `0.1` miles of every route) so you can safely post maps starting from your home address!
    - Runs mathematical geometry compression to encode maps into `NIP-52` event payload content.

2. **`web/` (The Global Dashboard)**
    - Built in React + Vite, designed to be deployed instantly on Vercel.
    - Connects directly to NIP-07 browser extensions (like Alby or nos2x) allowing web-based sign-in without ever typing a private key.
    - Parses `NIP-52` routes across the globe and rendering beautiful, high-performance `react-leaflet` overlays without server-side databases!
    - Seamlessly executes `NWC` (Nostr Wallet Connect) integrations to Zap lightning transactions natively across the map directly into the pockets of global riders.

3. **`backend/` (The Escrow Bot)**
    - Built in Node.js. Designed to be hosted on a $4 Linux VPS (e.g. Hetzner).
    - Uses `@nostr-dev-kit/ndk` to instantly parse millions of incoming websocket commands.
    - Manages the entire `Bikel` Contest infrastructure: Automatically aggregating RSVP fees via the `Coinos API`, securely escrowing Sats, evaluating ride placements dynamically against the "Max Distance" criteria, and processing dynamic 50/30/20 Payout Sweeps instantaneously to the top three riders at Midnight on the contest end date!

---

## 🚀 Quickstart Guides

### 1. Web Frontend (`/web`)
Since the Web Frontend relies purely on Nostr and doesn't use databases, spinning it up is incredibly easy:
```bash
cd web
npm install
npm run dev
```

### 2. Escrow Node (`/backend`)
To launch the automated Prize Pool aggregator, you simply need to define two API keys inside an untracked `.env` wrapper:
```bash
cd backend
npm install
```
Create a `.env` file containing your internal Nostr Secret (`BOT_NSEC`) explicitly responsible for signing the prize distribution records, and an API hook (`COINOS_API_KEY`) to programmatically issue Lightning strikes:
```env
BOT_NSEC="nsec1..."
COINOS_API_KEY="ey..."
```
Then fire the daemon:
```bash
npm run start
```

### 3. Compiling the Mobile App (`/apk`)
To sideload the native `.apk` straight onto your Android, ensure your phone is on the same WiFi network and Developer Debugging is enabled:
```bash
adb connect <YOUR_PHONE_IP_ADDRESS>:<PORT>
```
Then execute our automated bash script to initiate the Gradle Prebuild and auto-inject it into the device:
```bash
cd apk
./install.sh --release
```

---

## 💡 Philosophy
Bikel ensures structural autonomy by keeping its layers entirely decoupled.
- The **Web Client** doesn't require the Escrow Bot to function.
- The **Mobile App** publishes routes into thin air (Nostr relays); it doesn't even know if the Web Client exists!
- The **Escrow Bot** has absolutely zero frontend framework—it solely watches the mathematical matrices flowing across the sockets.

You are highly encouraged to fork, audit, reskin, and deploy your own variations of all three instances for your local cycling clubs. Happy Riding!