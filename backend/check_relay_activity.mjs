import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    console.log("Searching for ANY recent events on Bikel Relay...");
    const now = Math.floor(Date.now() / 1000);
    const since = now - (3600 * 24); // Last 24 hours
    
    const events = await ndk.fetchEvents({
        since: since
    }, {timeout: 10000});
    
    console.log("Found " + events.size + " events.");
    const sorted = [...events].sort((a,b) => b.created_at - a.created_at);
    for (const e of sorted.slice(0, 5)) {
        console.log("ID: " + e.id);
        console.log("Kind: " + e.kind);
        console.log("Author: " + e.pubkey);
        console.log("Created: " + e.created_at + " (" + new Date(e.created_at*1000).toISOString() + ")");
        console.log("---");
    }
    process.exit(0);
}
run();
