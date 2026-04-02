import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const challengeATag = "33401:9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83:bikel-challenge-1774582181991";
    console.log("Searching for RSVPs (Kind 31925) for challenge " + challengeATag);
    const events = await ndk.fetchEvents({ kinds: [31925], "#a": [challengeATag] });
    console.log("Found " + events.size + " RSVPs.");
    for (const e of events) {
        console.log("RSVP ID: " + e.id.substring(0,8) + " Author: " + e.pubkey + " Status: " + (e.getMatchingTags("l")[0]?.[1] || "none"));
    }
    process.exit(0);
}
run();
