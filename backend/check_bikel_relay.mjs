import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const userPubkey = "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83";
    const rides = await ndk.fetchEvents({ kinds: [1301, 33301], authors: [userPubkey], limit: 20 });
    console.log("Found " + rides.size + " rides total.");
    for (const r of rides) {
        console.log("ID: " + r.id.substring(0,8) + " Kind: " + r.kind + " Created: " + new Date(r.created_at * 1000).toISOString() + " (" + r.created_at + ")");
    }
    process.exit(0);
}
run();
