import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const user = "7afc3e977ef2534a83a8b420acacbc8a8d8761fa844ac33d8f8bf8e3175bbe25";
    // March 29th 00:00 UTC is ~1774742400
    const events = await ndk.fetchEvents({ 
        authors: [user],
        since: 1774742400
    });
    console.log("Found " + events.size + " events for 7afc3e97 since March 29th 00:00 UTC.");
    for (const e of events) {
        console.log("ID: " + e.id.substring(0,8) + " Kind: " + e.kind + " Created: " + new Date(e.created_at * 1000).toISOString());
    }
    process.exit(0);
}
run();
