import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io", "wss://relay.primal.net"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const userPubkey = "7afc3e977ef2534a83a8b420acacbc8a8d8761fa844ac33d8f8bf8e3175bbe25";
    const now = Math.floor(Date.now() / 1000);
    const rides = await ndk.fetchEvents({ 
        kinds: [1301, 33301], 
        authors: [userPubkey],
        since: now - 86400 * 2
    });
    console.log("Found " + rides.size + " rides for 7afc3e97 in last 48h.");
    for (const r of rides) {
        console.log("ID: " + r.id.substring(0,8) + " Created: " + new Date(r.created_at * 1000).toISOString() + " (" + r.created_at + ")");
        console.log("  Tags: " + JSON.stringify(r.tags));
    }
    process.exit(0);
}
run();
