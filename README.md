# Bikel 🚲⚡
**Bikel** is an open-source, decentralized mapping and geolocation ecosystem natively built on the Nostr network. It allows cyclists and athletes to passively track rides, overlay photos, organize alleycat races, and distribute lightning-fast Bitcoin micro-payments—all entirely free from traditional proprietary fitness trackers.
Because Bikel uses Nostr and `NIP-52` Time-Based events, your location data belongs permanently to your cryptographic identity. You are free to take your maps to any client or relay you choose.
---
## 🏗️ Architecture
The Bikel platform is divided into three completely independent applications that communicate symbiotically over Nostr websocket relays:
1. **`apk/` (The Mobile Tracker)**
    - Built completely natively in React Native & Expo.
    - Designed to run seamlessly in your pocket, utilizing background GPS location tracking (via a foreground service on Android) to constantly gather high-resolution `lat/lng` traces.
    - Features user-configurable "Privacy Tail-Trimming" logic (dropping the first and last `0.1` miles of every route) so you can safely post maps without revealing your home address.
    - Runs mathematical geometry compression to encode maps into `NIP-52` event payload content.
    - **Automatically generates a Nostr key pair on first launch** — no external setup required to start publishing rides.
    - Attaches a `confidence` score (0.0–1.0) to each ride, reflecting GPS signal quality.

2. **`web/` (The Global Dashboard)**
    - Built in React + Vite, designed to be deployed instantly on Vercel.
    - Connects directly to NIP-07 browser extensions (like Alby or nos2x) allowing web-based sign-in without ever typing a private key.
    - Parses `NIP-52` routes across the globe and renders beautiful, high-performance `react-leaflet` overlays without server-side databases.
    - Seamlessly executes `NWC` (Nostr Wallet Connect) integrations to Zap lightning transactions natively across the map directly into the pockets of global riders.
    - **Open Data / City Planner panel** — exports anonymized GPS data as CSV in three formats (raw points, aggregated corridors, ride statistics), licensed CC0 for municipal and research use.
    - **Density heatmap** — visualize high-traffic cycling corridors with a green→yellow→red overlay.
    - **Ride deletion** — publishes `kind 5` deletion events so riders can remove their own rides from supporting relays.

3. **`backend/` (The Escrow Bot)**
    - Built in Node.js. Designed to be hosted on a $4 Linux VPS (e.g. Hetzner).
    - Uses `@nostr-dev-kit/ndk` to instantly parse millions of incoming websocket commands.
    - Manages the entire Bikel Contest infrastructure: automatically aggregating RSVP fees via the Coinos API, securely escrowing sats, evaluating ride placements dynamically against the "Max Distance" criteria, and processing dynamic 50/30/20 payout sweeps instantaneously to the top three riders at midnight on the contest end date.

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
To launch the automated Prize Pool aggregator, define two API keys inside an untracked `.env` file:
```bash
cd backend
npm install
```
Create a `.env` file containing your internal Nostr secret (`BOT_NSEC`) responsible for signing prize distribution records, and a Coinos API hook (`COINOS_API_KEY`) to programmatically issue Lightning payments:
```env
BOT_NSEC="nsec1..."
COINOS_API_KEY="ey..."
```
Then fire the daemon:
```bash
npm run start
```
### 3. Compiling the Mobile App (`/apk`)
To sideload the native `.apk` straight onto your Android, ensure your phone is on the same WiFi network and USB/wireless debugging is enabled:
```bash
adb connect <YOUR_PHONE_IP_ADDRESS>:<PORT>
```
Then execute the automated build script to initiate the Gradle prebuild and auto-inject it onto the device:
```bash
cd apk
./install.sh --release
```
> **Note:** Background GPS tracking requires a production build (`eas build`) to unlock the "Allow all the time" location permission on Android 10+. The dev build works with the screen on.

---
## 🗺️ Nostr Event Kinds
| Kind | Purpose |
|------|---------|
| `33301` | Ride events (distance, duration, GPS route, confidence) |
| `31923` | Scheduled group rides (NIP-52) |
| `31925` | RSVPs for scheduled rides |
| `31924` | Challenge events |
| `5` | Deletion requests |
| `4` | Encrypted DMs between riders |
| `1` | Ride comments |

---
## 📐 Kind 33301 — Ride Event Spec

This section documents the full structure of a Bikel ride event so that third-party Nostr clients can parse and display rides without needing to read the source code.

### Top-level fields

| Field | Value |
|-------|-------|
| `kind` | `33301` |
| `content` | JSON object (see below) — present only when `visibility = "full"`, empty string otherwise |
| `created_at` | Unix timestamp of when the ride was published |
| `pubkey` | Hex pubkey of the rider |

### Tags

| Tag | Example | Description |
|-----|---------|-------------|
| `distance` | `["distance", "12.4"]` | Total ride distance in **miles**, as a decimal string |
| `duration` | `["duration", "3720"]` | Total ride duration in **seconds**, as an integer string |
| `visibility` | `["visibility", "full"]` | Route sharing mode — `"full"` (GPS route included), or `"hidden"` (stats only, no route) |
| `title` | `["title", "Morning Commute"]` | Optional rider-provided title |
| `description` | `["description", "Felt great today"]` | Optional rider-provided description |
| `image` | `["image", "https://..."]` | Optional URL to a photo from the ride |
| `confidence` | `["confidence", "0.85"]` | GPS confidence score from `0.0` (low) to `1.0` (high), as a decimal string. Rides auto-detected in the background may have lower confidence than manually recorded rides. Omitted on older events. |

### Content (when `visibility = "full"`)

The `content` field is a JSON-encoded object with a single key:

```json
{
  "route": [
    [37.7749, -122.4194],
    [37.7751, -122.4190],
    ...
  ]
}
```

Each element in `route` is a `[latitude, longitude]` pair as decimals. The array is ordered chronologically from ride start to finish. Privacy tail-trimming (dropping the first and last ~0.1 miles) may be applied by the client before publishing, so the route will not include the rider's precise start/end location unless they opted out of trimming.

When `visibility = "hidden"`, `content` is an empty string and no route is published.

### Example event

```json
{
  "kind": 33301,
  "pubkey": "9367a951...",
  "created_at": 1710000000,
  "tags": [
    ["distance", "8.3"],
    ["duration", "2340"],
    ["visibility", "full"],
    ["title", "Evening Loop"],
    ["description", "Nice sunset ride"],
    ["image", "https://example.com/ride.jpg"],
    ["confidence", "0.92"]
  ],
  "content": "{\"route\":[[37.7749,-122.4194],[37.7751,-122.4190]]}",
  "id": "...",
  "sig": "..."
}
```

### Filtering recommendations

When querying relays for Bikel rides, filter by `kinds: [33301]`. To display a feed of recent global rides, use a `limit` of 50–100 and sort by `created_at` descending. It is recommended to filter out rides with `distance < 0.1` miles as these are likely test events or GPS errors. If you wish to show only high-quality auto-detected rides, filter for `confidence >= 0.7`.

### Deletion

Rides can be deleted by their author via a standard `kind 5` event referencing the ride's event ID:

```json
{
  "kind": 5,
  "tags": [
    ["e", "<ride-event-id>"],
    ["k", "33301"]
  ],
  "content": "deleted"
}
```

Clients should respect these deletion events and suppress the referenced ride from their UI.

---
## 📐 Kind 31924 — Challenge Event Spec

Bikel challenges are community competitions where riders pay a sats entry fee, compete over a set time window, and the escrow bot automatically pays out to the top three finishers.

### Top-level fields

| Field | Value |
|-------|-------|
| `kind` | `31924` |
| `content` | Empty string (all data is in tags) |
| `created_at` | Unix timestamp of when the challenge was created |
| `pubkey` | Hex pubkey of the challenge organizer |

### Tags

| Tag | Example | Description |
|-----|---------|-------------|
| `name` | `["name", "July Distance King"]` | Display name of the challenge |
| `description` | `["description", "Who can ride the most miles?"]` | Human-readable description |
| `start` | `["start", "1720000000"]` | Unix timestamp when the challenge window opens |
| `end` | `["end", "1720604800"]` | Unix timestamp when the challenge window closes |
| `parameter` | `["parameter", "max_distance"]` | Winning metric — one of `max_distance`, `max_elevation`, or `fastest_mile` |
| `fee` | `["fee", "5000"]` | Entry fee in satoshis as an integer string. `"0"` for free challenges |
| `p` | `["p", "hexpubkey1"]` | Optional — one tag per invited participant. If no `p` tags are present the challenge is **global** (open to anyone). If one or more `p` tags are present it is **private** (invite-only) |

### Winning metrics

| Value | Description |
|-------|-------------|
| `max_distance` | Rider with the highest total distance (miles) across all rides submitted during the window wins |
| `max_elevation` | Rider with the highest total elevation gain wins |
| `fastest_mile` | Rider with the best average pace wins |

### RSVP / entry

Riders join a challenge by publishing a `kind 31925` RSVP event referencing the challenge, and simultaneously zapping the entry fee in sats directly to the escrow bot's pubkey (`ESCROW_PUBKEY`). The escrow bot watches for both the RSVP and the payment before counting a rider as entered.

### Payout

At midnight on the `end` date, the escrow bot automatically evaluates all `kind 33301` ride events published by entered riders during the challenge window, ranks them by the challenge `parameter`, and distributes the prize pool in a **50 / 30 / 20** split to the top three finishers via the Coinos Lightning API.

### Example event

```json
{
  "kind": 31924,
  "pubkey": "cc130b71...",
  "created_at": 1720000000,
  "tags": [
    ["name", "July Distance King"],
    ["description", "Who can ride the most miles this week?"],
    ["start", "1720000000"],
    ["end", "1720604800"],
    ["parameter", "max_distance"],
    ["fee", "5000"]
  ],
  "content": "",
  "id": "...",
  "sig": "..."
}
```

Private invite-only challenge (add `p` tags):
```json
{
  "kind": 31924,
  "tags": [
    ["name", "Club Ride-Off"],
    ["start", "1720000000"],
    ["end", "1720604800"],
    ["parameter", "fastest_mile"],
    ["fee", "1000"],
    ["p", "hexpubkey1"],
    ["p", "hexpubkey2"],
    ["p", "hexpubkey3"]
  ],
  "content": ""
}
```


Bikel ensures structural autonomy by keeping its layers entirely decoupled.
- The **Web Client** doesn't require the Escrow Bot to function.
- The **Mobile App** publishes routes into thin air (Nostr relays); it doesn't even know if the Web Client exists.
- The **Escrow Bot** has absolutely zero frontend framework — it solely watches the mathematical matrices flowing across the sockets.

You are highly encouraged to fork, audit, reskin, and deploy your own variations of all three instances for your local cycling clubs. Happy Riding! 🚴