import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = [
    "wss://relay.snort.social",
    "wss://nostr.wine",
    "wss://relay.nostr.band",
    "wss://offchain.pub",
    "wss://nostr.land",
    "wss://relay.bikel.ink"
];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const user = "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83";
    console.log("Checking for rides (1301, 33301) for 9367a951 on extended relays...");
    const events = await ndk.fetchEvents({ 
        authors: [user],
        kinds: [1301, 33301],
        limit: 20
    });
    console.log("Found " + events.size + " rides.");
    for (const e of events) {
        console.log("ID: " + e.id.substring(0,8) + " Created: " + new Date(e.created_at * 1000).toISOString());
    }
    process.exit(0);
}
run();
