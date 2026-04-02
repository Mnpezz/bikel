import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAY = "wss://relay.bikel.ink";
const ndk = new NDK({ explicitRelayUrls: [RELAY] });

async function run() {
    await ndk.connect(5000);
    const challengeId = "09de2ee1a5486b2200fc796c1b2255765e98c60e83fb7c5c1ed423ee1f4ad7e6";
    console.log("Fetching challenge from " + RELAY);
    const event = await ndk.fetchEvent(challengeId);
    if (event) {
        console.log("Challenge Tags:", JSON.stringify(event.tags));
    } else {
        console.log("Challenge NOT found on Bikel relay.");
    }
    process.exit(0);
}
run();
