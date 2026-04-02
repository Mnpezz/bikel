import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink", "wss://relay.nostr.band"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    console.log("Searching for ALL RSVPs in the last 72 hours...");
    const since = Math.floor(Date.now() / 1000) - (72 * 3600);
    
    const rsvps = await ndk.fetchEvents({
        kinds: [31925],
        since: since
    }, {timeout: 20000});
    
    console.log("Found " + rsvps.size + " RSVP events.");
    const sorted = [...rsvps].sort((a,b) => b.created_at - a.created_at);
    for (const r of sorted.slice(0, 10)) {
        console.log("ID: " + r.id);
        console.log("Author: " + r.pubkey);
        console.log("Created: " + new Date(r.created_at*1000).toISOString());
        console.log("Tags: " + JSON.stringify(r.tags));
        console.log("---");
    }
    process.exit(0);
}
run();
