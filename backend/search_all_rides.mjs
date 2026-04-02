import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink", "wss://relay.nostr.band"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    const userHex = "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83";
    console.log("Searching for ALL rides for: " + userHex);
    
    const rides = await ndk.fetchEvents({
        kinds: [1, 1301, 33301],
        authors: [userHex]
    }, {timeout: 20000});
    
    console.log("Found " + rides.size + " events.");
    const sorted = [...rides].sort((a,b) => b.created_at - a.created_at);
    for (const r of sorted.slice(0, 10)) {
        console.log("ID: " + r.id);
        console.log("Kind: " + r.kind);
        console.log("Created: " + r.created_at + " (" + new Date(r.created_at*1000).toISOString() + ")");
        console.log("Tags: " + JSON.stringify(r.tags));
        console.log("---");
    }
    process.exit(0);
}
run();
