import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = [
    "wss://relay.bikel.ink", 
    "wss://relay.damus.io", 
    "wss://relay.primal.net", 
    "wss://nos.lol",
    "wss://relay.snort.social",
    "wss://offchain.pub"
];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const now = Math.floor(Date.now() / 1000);
    console.log("Searching for rides since: " + new Date((now - 14400) * 1000).toISOString());
    const rides = await ndk.fetchEvents({ 
        kinds: [1301, 33301], 
        since: now - 14400 // Last 4 hours
    });
    console.log("Total recent rides found: " + rides.size);
    for (const r of rides) {
        const title = r.getMatchingTags("title")[0]?.[1];
        console.log("ID: " + r.id.substring(0,8) + " Author: " + r.pubkey + " Created: " + new Date(r.created_at * 1000).toISOString() + " Title: " + title);
    }
    process.exit(0);
}
run();
