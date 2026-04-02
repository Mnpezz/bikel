import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = [
    "wss://relay.damus.io", 
    "wss://relay.primal.net", 
    "wss://nos.lol", 
    "wss://relay.bikel.ink",
    "wss://relay.snort.social",
    "wss://nostr.wine",
    "wss://relay.nostr.band"
];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const user = "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83";
    console.log("Searching for the MOST RECENT rides for 9367a951...");
    const events = await ndk.fetchEvents({ 
        authors: [user],
        kinds: [1301, 33301],
        limit: 10
    });
    console.log("Found " + events.size + " rides.");
    for (const e of events) {
        console.log("ID: " + e.id.substring(0,8) + " Created: " + new Date(e.created_at * 1000).toISOString() + " (" + e.created_at + ")");
    }
    process.exit(0);
}
run();
