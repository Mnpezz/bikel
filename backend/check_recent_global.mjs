import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io", "wss://relay.primal.net"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const now = Math.floor(Date.now() / 1000);
    const rides = await ndk.fetchEvents({ kinds: [1301, 33301], since: now - 86400 * 2, limit: 50 });
    console.log("Recent global rides: " + rides.size);
    for (const r of rides) {
        console.log("ID: " + r.id.substring(0,8) + " Kind: " + r.kind + " Author: " + r.pubkey + " Created: " + new Date(r.created_at * 1000).toISOString());
    }
    process.exit(0);
}
run();
