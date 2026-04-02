import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = [
    "wss://relay.damus.io", 
    "wss://relay.primal.net", 
    "wss://nos.lol", 
    "wss://relay.bikel.ink",
    "wss://relay.snort.social",
    "wss://nostr.wine",
    "wss://relay.nostr.band"
];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const challengeId = "09de2ee1a5486b2200fc796c1b2255765e98c60e83fb7c5c1ed423ee1f4ad7e6";
    console.log("Global search for RSVPs (Kind 31925) referring to " + challengeId);
    const rsvps = await ndk.fetchEvents({ kinds: [31925], "#e": [challengeId] });
    console.log("Found " + rsvps.size + " RSVPs.");
    for (const r of rsvps) {
        console.log("Author: " + r.pubkey + " Tags: " + JSON.stringify(r.tags));
    }
    process.exit(0);
}
run();
