import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const rideIds = ["b87f97531b792ef713f7a9df910d7ca01a9c76a5cc5795cb6d4f7c087f31e698", "6c6563214b7e80f9dd3ea9a1eb08146747d667c2936746816027a052bd3cb146"];
    for (const id of rideIds) {
        console.log("Fetching ride: " + id);
        const event = await ndk.fetchEvent(id);
        if (event) {
            console.log("Tags: " + JSON.stringify(event.tags));
        } else {
            console.log("Ride not found.");
        }
    }
    process.exit(0);
}
run();
