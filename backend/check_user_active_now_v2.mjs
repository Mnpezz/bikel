import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const user = "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83";
    const now = Math.floor(Date.now() / 1000);
    console.log("Checking activity for 9367a951... since March 29th 00:00 UTC...");
    const events = await ndk.fetchEvents({ 
        authors: [user],
        since: 1774742400, // March 29th 00:00 UTC
        limit: 50
    });
    console.log("Found " + events.size + " events.");
    for (const e of events) {
        console.log("ID: " + e.id.substring(0,8) + " Kind: " + e.kind + " Created: " + new Date(e.created_at * 1000).toISOString());
    }
    process.exit(0);
}
run();
