import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    const challengeId = "09de2ee1a5486b2200fc796c1b2255765e98c60e83fb7c5c1ed423ee1f4ad7e6";
    const rideId = "b87f97531b792ef713f7a9df910d7ca01a9c76a5cc5795cb6d4f7c087f31e698";
    
    console.log("Fetching challenge...");
    const challenge = await ndk.fetchEvent(challengeId);
    if (challenge) {
        console.log("Challenge Start:", challenge.getMatchingTags("start")[0]?.[1]);
        console.log("Challenge End:  ", challenge.getMatchingTags("end")[0]?.[1]);
        console.log("Challenge Name: ", challenge.getMatchingTags("name")[0]?.[1]);
    }

    console.log("\nFetching ride...");
    const ride = await ndk.fetchEvent(rideId);
    if (ride) {
        console.log("Ride Author: ", ride.pubkey);
        console.log("Ride Created:", new Date(ride.created_at*1000).toISOString());
        console.log("Ride Tags:   ", JSON.stringify(ride.tags));
    }
    process.exit(0);
}
run();
