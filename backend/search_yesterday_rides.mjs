import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    const user = "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83";
    // March 28th 00:00 UTC is ~1774656000
    // March 29th 00:00 UTC is ~1774742400
    console.log("Searching for rides (1301, 33301) for 9367... on March 28th...");
    const events = await ndk.fetchEvents({ 
        authors: [user], 
        kinds: [1301, 33301],
        since: 1774656000,
        until: 1774742400
    });
    console.log("Found " + events.size + " rides.");
    for (const e of events) {
        console.log("ID: " + e.id.substring(0,8) + " Created: " + new Date(e.created_at * 1000).toISOString());
    }
    process.exit(0);
}
run();
