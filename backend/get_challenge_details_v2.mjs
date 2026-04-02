import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io", "wss://relay.primal.net"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const eventId = "09de2ee1a5486b2200fc796c1b2255765e98c60e83fb7c5c1ed423ee1f4ad7e6";
    console.log("Fetching challenge: " + eventId);
    const event = await ndk.fetchEvent(eventId);
    if (event) {
        const start = event.getMatchingTags("start")[0]?.[1];
        const end = event.getMatchingTags("end")[0]?.[1];
        console.log("Challenge Start:", start, "(" + new Date(parseInt(start)*1000).toISOString() + ")");
        console.log("Challenge End:  ", end,   "(" + new Date(parseInt(end)*1000).toISOString() + ")");
        console.log("Tags:", JSON.stringify(event.tags));
    } else {
        console.log("Challenge not found.");
    }
    process.exit(0);
}
run();
