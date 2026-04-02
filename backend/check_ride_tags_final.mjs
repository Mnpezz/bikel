import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    const rideId = "b87f97531b792ef713f7a9df910d7ca01a9c76a5cc5795cb6d4f7c087f31e698";
    console.log("Fetching ride: " + rideId);
    const ride = await ndk.fetchEvent(rideId);
    if (ride) {
        console.log("Ride Tags: " + JSON.stringify(ride.tags));
        console.log("Ride Created: " + new Date(ride.created_at * 1000).toISOString());
    } else {
        console.log("Ride not found on major relays.");
    }
    process.exit(0);
}
run();
