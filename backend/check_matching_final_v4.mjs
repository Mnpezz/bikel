import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    const challengeId = "09de2ee1a5486b2200fc796c1b2255765e98c60e83fb7c5c1ed423ee1f4ad7e6";
    const rideId = "b87f97531b792ef713f7a9df910d7ca01a9c76a5cc5795cb6d4f7c087f31e698";
    
    console.log("Fetching challenge: " + challengeId);
    const challenge = await ndk.fetchEvents({ids: [challengeId]}, {timeout: 10000});
    let startTime, endTime;
    for (const c of challenge) {
        startTime = parseInt(c.getMatchingTags("start")[0]?.[1]);
        endTime = parseInt(c.getMatchingTags("end")[0]?.[1]);
        console.log("Challenge Start: " + start + " (" + new Date(startTime*1000).toISOString() + ")");
        console.log("Challenge End:   " + end + " (" + new Date(endTime*1000).toISOString() + ")");
    }

    console.log("\nFetching ride: " + rideId);
    const ride = await ndk.fetchEvents({ids: [rideId]}, {timeout: 10000});
    for (const r of ride) {
        console.log("Ride Created At: " + r.created_at + " (" + new Date(r.created_at*1000).toISOString() + ")");
        console.log("Ride Tags: " + JSON.stringify(r.tags));
    }
    process.exit(0);
}
run();
