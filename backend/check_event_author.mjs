import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io", "wss://relay.primal.net"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const eventId = "09de2ee1a5486b2200fc796c1b2255765e98c60e83fb7c5c1ed423ee1f4ad7e6";
    console.log("Fetching event " + eventId + "...");
    const event = await ndk.fetchEvent(eventId);
    if (event) {
        console.log("Author:", event.pubkey);
        console.log("Kind:", event.kind);
        console.log("Created At:", new Date(event.created_at * 1000).toISOString());
    } else {
        console.log("Event not found on these relays.");
    }
    process.exit(0);
}
run();
