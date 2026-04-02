import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    const challengeId = "09de2ee1a5486b2200fc796c1b2255765e98c60e83fb7c5c1ed423ee1f4ad7e6";
    const c = await ndk.fetchEvent(challengeId);
    if (c) {
        console.log("Challenge ID: " + c.id);
        console.log("Tags:", JSON.stringify(c.tags));
        console.log("Created At:", c.created_at + " (" + new Date(c.created_at*1000).toISOString() + ")");
    } else {
        console.log("Challenge not found.");
    }
    process.exit(0);
}
run();
