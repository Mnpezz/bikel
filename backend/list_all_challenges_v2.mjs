import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    console.log("Fetching challenges...");
    const challenges = await ndk.fetchEvents({kinds: [33401]}, {timeout: 15000});
    console.log("Found " + challenges.size + " challenges.");
    for (const c of challenges) {
        const start = c.getMatchingTags("start")[0]?.[1];
        const end = c.getMatchingTags("end")[0]?.[1];
        const name = c.getMatchingTags("name")[0]?.[1];
        console.log("---");
        console.log("ID:    " + c.id);
        console.log("Name:  " + name);
        console.log("Start: " + start + " (" + (start ? new Date(parseInt(start)*1000).toISOString() : "N/A") + ")");
        console.log("End:   " + end + " (" + (end ? new Date(parseInt(end)*1000).toISOString() : "N/A") + ")");
    }
    process.exit(0);
}
run();
