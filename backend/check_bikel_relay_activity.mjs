import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAY = "wss://relay.bikel.ink";
const ndk = new NDK({ explicitRelayUrls: [RELAY] });

async function run() {
    await ndk.connect();
    console.log("Connected to Bikel Relay");
    const events = await ndk.fetchEvents({ limit: 10 });
    console.log("Found " + events.size + " recent events globally on Bikel relay.");
    for (const e of events) {
        console.log("ID: " + e.id.substring(0,8) + " Kind: " + e.kind + " Author: " + e.pubkey + " Created: " + new Date(e.created_at * 1000).toISOString());
    }
    process.exit(0);
}
run();
