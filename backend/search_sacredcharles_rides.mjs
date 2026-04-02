import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    const charlesHex = "7afc3e977ef2534a83a8b420acacbc8a8d8761fa844ac33d8f8bf8e3175bbe25";
    console.log("Searching for 2026 rides for: " + charlesHex);
    const startOfMarch = 1772323200; 
    const rides = await ndk.fetchEvents({
        kinds: [1, 1301, 33301],
        authors: [charlesHex],
        since: startOfMarch
    }, {timeout: 15000});
    
    console.log("Found " + rides.size + " events.");
    for (const r of rides) {
        console.log("ID: " + r.id);
        console.log("Kind: " + r.kind);
        console.log("Created: " + r.created_at + " (" + new Date(r.created_at*1000).toISOString() + ")");
        console.log("Tags: " + JSON.stringify(r.tags));
    }
    process.exit(0);
}
run();
