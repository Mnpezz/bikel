import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink", "wss://relay.nostr.band"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    console.log("Searching for ANY Kind 1301/33301 in the last 24 hours...");
    const now = Math.floor(Date.now() / 1000);
    const since = now - (3600 * 24); 
    
    const events = await ndk.fetchEvents({
        kinds: [1301, 33301],
        since: since
    }, {timeout: 20000});
    
    console.log("Found " + events.size + " ride events.");
    const sorted = [...events].sort((a,b) => b.created_at - a.created_at);
    for (const e of sorted.slice(0, 5)) {
        console.log("ID: " + e.id);
        console.log("Kind: " + e.kind);
        console.log("Author: " + e.pubkey);
        console.log("Created: " + e.created_at + " (" + new Date(e.created_at*1000).toISOString() + ")");
        console.log("Tags: " + JSON.stringify(e.tags));
        console.log("---");
    }
    process.exit(0);
}
run();
