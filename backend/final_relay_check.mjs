import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAY = "wss://relay.bikel.ink";
const ndk = new NDK({ explicitRelayUrls: [RELAY] });

async function run() {
    await ndk.connect();
    console.log("Connected to Bikel Relay");
    const user = "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83";
    const events = await ndk.fetchEvents({ authors: [user], since: 1774656000 });
    console.log("Found " + events.size + " total events for 9367... since March 28.");
    for (const e of events) {
        console.log("ID: " + e.id.substring(0,8) + " Kind: " + e.kind + " Created: " + new Date(e.created_at * 1000).toISOString());
    }
    process.exit(0);
}
run();
