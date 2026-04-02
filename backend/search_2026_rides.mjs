import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    const userHex = "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83";
    console.log("Searching for rides for: " + userHex);
    // March 2026 roughly.
    const startOfMarch = 1772323200; 
    const rides = await ndk.fetchEvents({
        kinds: [1301, 33301],
        authors: [userHex],
        since: startOfMarch
    }, {timeout: 15000});
    
    console.log("Found " + rides.size + " rides.");
    for (const r of rides) {
        console.log("ID: " + r.id);
        console.log("Created: " + r.created_at + " (" + new Date(r.created_at*1000).toISOString() + ")");
        console.log("Tags: " + JSON.stringify(r.tags));
    }
    process.exit(0);
}
run();
