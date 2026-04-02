import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAY = "wss://relay.bikel.ink";
const ndk = new NDK({ explicitRelayUrls: [RELAY] });

async function run() {
    await ndk.connect();
    const now = Math.floor(Date.now() / 1000);
    console.log("Checking ALL activity on Bikel relay in the last 2 hours...");
    const events = await ndk.fetchEvents({ since: now - 7200, limit: 100 });
    console.log("Found " + events.size + " events.");
    for (const e of events) {
        process.stdout.write("Kind: " + e.kind + " Author: " + e.pubkey.substring(0,8) + " Created: " + new Date(e.created_at * 1000).toISOString() + "\n");
    }
    process.exit(0);
}
run();
