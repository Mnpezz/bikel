import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    console.log("Searching for Kind 33401...");
    const filters = { kinds: [33401], limit: 20 };
    const challenges = await ndk.fetchEvents(filters, {timeout: 10000});
    console.log("Found " + challenges.size + " challenges.");
    for (const c of challenges) {
        const start = c.getMatchingTags("start")[0]?.[1];
        const end = c.getMatchingTags("end")[0]?.[1];
        const name = c.getMatchingTags("name")[0]?.[1] || c.getMatchingTags("title")[0]?.[1];
        console.log("- ID: " + c.id);
        console.log("  Name: " + name);
        console.log("  Window: " + (start ? new Date(parseInt(start)*1000).toISOString() : "N/A") + " to " + (end ? new Date(parseInt(end)*1000).toISOString() : "N/A"));
        console.log("  Author: " + c.pubkey);
    }
    process.exit(0);
}
run();
