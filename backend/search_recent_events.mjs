import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink", "wss://purplepag.es"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    const userHex = "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83";
    console.log("Searching for ANY events for: " + userHex);
    
    // Last 48 hours.
    const now = Math.floor(Date.now() / 1000);
    const since = now - (48 * 3600);
    
    const events = await ndk.fetchEvents({
        authors: [userHex],
        since: since
    }, {timeout: 20000});
    
    console.log("Found " + events.size + " events.");
    const sorted = [...events].sort((a,b) => b.created_at - a.created_at);
    for (const e of sorted) {
        console.log("ID: " + e.id);
        console.log("Kind: " + e.kind);
        console.log("Created: " + e.created_at + " (" + new Date(e.created_at*1000).toISOString() + ")");
        console.log("Tags: " + JSON.stringify(e.tags));
        console.log("---");
    }
    process.exit(0);
}
run();
