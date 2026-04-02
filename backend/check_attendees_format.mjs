import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(2000);
    const challengeId = "09de2ee1a5486b2200fc796c1b2255765e98c60e83fb7c5c1ed423ee1f4ad7e6";
    const challenge = await ndk.fetchEvent(challengeId);
    if (challenge) {
        const attendees = challenge.getMatchingTags("p").map(t => t[1]);
        console.log("First 5 attendees raw:", attendees.slice(0, 5));
        const userHex = "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83";
        console.log("User hex in attendees?", attendees.includes(userHex));
    }
    process.exit(0);
}
run();
