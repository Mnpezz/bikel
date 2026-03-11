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
| `33401` | Challenge events (custom Bikel kind) |
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
## 📐 Kind 33401 — Challenge Event Spec

`33401` is a fully custom Bikel kind for cycling challenges and competitions. It is intentionally distinct from NIP-52 calendar kinds (`31922`–`31925`) to avoid conflicts, while being rich enough for other developers to adopt independently.

### Why not reuse NIP-52?

`kind 31924` is defined by NIP-52 as a **Calendar** (a container for collecting calendar events). Bikel challenges have a fundamentally different structure — entry fees, escrow agents, winning metrics, configurable payout splits — so a dedicated kind is the right design. Any client that understands `33401` gets the full challenge experience; clients that don't simply ignore it.

### Top-level fields

| Field | Value |
|-------|-------|
| `kind` | `33401` |
| `content` | Human-readable description of the challenge |
| `created_at` | Unix timestamp of publication |
| `pubkey` | Hex pubkey of the challenge organizer |

### Tags

| Tag | Example | Required | Description |
|-----|---------|----------|-------------|
| `d` | `["d", "bikel-challenge-1720000000"]` | ✅ | Unique identifier — makes the event addressable and replaceable |
| `title` | `["title", "July Distance King"]` | ✅ | Display name |
| `start` | `["start", "1720000000"]` | ✅ | Unix timestamp when the challenge window opens |
| `end` | `["end", "1720604800"]` | ✅ | Unix timestamp when the challenge window closes |
| `parameter` | `["parameter", "max_distance"]` | ✅ | Winning metric — `max_distance`, `max_elevation`, or `fastest_mile` |
| `sport` | `["sport", "cycling"]` | ✅ | Activity type — `cycling`, `running`, `walking`, `swimming` etc. |
| `unit` | `["unit", "imperial"]` | ✅ | `imperial` or `metric` — tells clients how to display values |
| `fee` | `["fee", "5000"]` | ✅ | Entry fee in satoshis. Use `"0"` for free challenges |
| `escrow` | `["escrow", "cc130b71..."]` | ✅ | Hex pubkey of the escrow agent bot that holds and distributes funds |
| `payout` | `["payout", "50", "30", "20"]` | ☐ | Percentage split for 1st/2nd/3rd. Defaults to 50/30/20 if omitted |
| `prize` | `["prize", "25000"]` | ☐ | Total prize pool in sats — may exceed collected fees if the challenge is sponsored |
| `min_confidence` | `["min_confidence", "0.7"]` | ☐ | Minimum ride `confidence` score (0.0–1.0) required to qualify. Rides below this are excluded from scoring |
| `p` | `["p", "hexpubkey1"]` | ☐ | Invited participant. Omit all `p` tags for a **global** open challenge. Add one per invitee for a **private** challenge |
| `client` | `["client", "bikel"]` | ☐ | Publishing client identifier for relay filtering |
| `t` | `["t", "bikel-challenge"]` | ☐ | Hashtag for discoverability |

### Winning metrics

| Value | Description |
|-------|-------------|
| `max_distance` | Highest total distance (in `unit`) across all qualifying rides during the window |
| `max_elevation` | Highest total elevation gain |
| `fastest_mile` | Best average pace — highest mph (imperial) or kph (metric) across a single ride of ≥1 mile/km |

### Entry flow

1. Rider discovers a `33401` event on a relay
2. Rider publishes a `kind 31925` RSVP with an `a` tag referencing `33401:<organizer-pubkey>:<d-tag>`
3. If `fee > 0`, rider simultaneously zaps the fee amount to the `escrow` pubkey
4. The escrow bot watches for matching RSVPs + zap receipts and registers the rider as entered

### Payout flow

At midnight UTC on the `end` date, the escrow bot:
1. Fetches all `kind 33301` rides from entered riders with `created_at` between `start` and `end`
2. Filters out rides where `confidence < min_confidence` (if set)
3. Ranks riders by `parameter`
4. Distributes the prize pool according to `payout` split (default 50/30/20) via Lightning

### Example event — global open challenge

```json
{
  "kind": 33401,
  "pubkey": "cc130b71...",
  "created_at": 1720000000,
  "tags": [
    ["d", "bikel-challenge-1720000000"],
    ["title", "July Distance King"],
    ["start", "1720000000"],
    ["end", "1720604800"],
    ["parameter", "max_distance"],
    ["sport", "cycling"],
    ["unit", "imperial"],
    ["fee", "5000"],
    ["prize", "25000"],
    ["escrow", "cc130b7120d00ded76d065bf0bd27e3a36a38d5268208078a1e99aa29ac44adf"],
    ["payout", "50", "30", "20"],
    ["min_confidence", "0.7"],
    ["client", "bikel"],
    ["t", "bikel-challenge"]
  ],
  "content": "Who can ride the most miles this week? Winner takes the pot!",
  "id": "...",
  "sig": "..."
}
```

### Example event — private invite-only challenge

```json
{
  "kind": 33401,
  "tags": [
    ["d", "bikel-challenge-1720000001"],
    ["title", "Club Ride-Off"],
    ["start", "1720000000"],
    ["end", "1720604800"],
    ["parameter", "fastest_mile"],
    ["sport", "cycling"],
    ["unit", "imperial"],
    ["fee", "1000"],
    ["escrow", "cc130b71..."],
    ["payout", "70", "30", "0"],
    ["p", "hexpubkey1"],
    ["p", "hexpubkey2"],
    ["p", "hexpubkey3"],
    ["client", "bikel"],
    ["t", "bikel-challenge"]
  ],
  "content": "Members-only speed challenge."
}
```

---
## 💡 Philosophy

Bikel ensures structural autonomy by keeping its layers entirely decoupled.
- The **Web Client** doesn't require the Escrow Bot to function.
- The **Mobile App** publishes routes into thin air (Nostr relays); it doesn't even know if the Web Client exists.
- The **Escrow Bot** has absolutely zero frontend framework — it solely watches the mathematical matrices flowing across the sockets.

You are highly encouraged to fork, audit, reskin, and deploy your own variations of all three instances for your local cycling clubs. Happy Riding! 🚴