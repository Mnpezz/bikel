import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io", "wss://relay.primal.net"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const now = Math.floor(Date.now() / 1000);
    const rides = await ndk.fetchEvents({ 
        kinds: [1301, 33301], 
        since: now - 86400 * 2
    });
    console.log("Checking " + rides.size + " rides for lightning tag...");
    for (const r of rides) {
        const ltag = r.getMatchingTags("lightning")[0]?.[1];
        if (ltag && ltag.includes("sacredcharles138")) {
            console.log("MATCH! ID: " + r.id.substring(0,8) + " Author: " + r.pubkey + " Created: " + new Date(r.created_at * 1000).toISOString());
            console.log("  Tags: " + JSON.stringify(r.tags));
        }
    }
    process.exit(0);
}
run();
