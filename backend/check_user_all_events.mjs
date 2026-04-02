import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const authors = [
        "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83",
        "7afc3e977ef2534a83a8b420acacbc8a8d8761fa844ac33d8f8bf8e3175bbe25"
    ];
    const now = Math.floor(Date.now() / 1000);
    const events = await ndk.fetchEvents({ 
        authors: authors,
        since: now - 86400,
        limit: 100
    });
    console.log("Found " + events.size + " events in last 24h.");
    for (const e of events) {
        console.log("ID: " + e.id.substring(0,8) + " Kind: " + e.kind + " Author: " + e.pubkey + " Created: " + new Date(e.created_at * 1000).toISOString());
    }
    process.exit(0);
}
run();
