import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io", "wss://relay.primal.net"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const now = Math.floor(Date.now() / 1000);
    const rsvps = await ndk.fetchEvents({ kinds: [31925], since: now - 86400 * 2 });
    console.log("Found " + rsvps.size + " RSVPs in last 48h.");
    for (const r of rsvps) {
        console.log("Author: " + r.pubkey + " Tag A: " + r.getMatchingTags("a")[0]?.[1] + " Status: " + r.getMatchingTags("l")[0]?.[1]);
    }
    process.exit(0);
}
run();
