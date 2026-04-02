import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    const challenges = await ndk.fetchEvents({kinds: [33401]});
    for (const c of challenges) {
        const start = parseInt(c.getMatchingTags("start")[0]?.[1]);
        const end = parseInt(c.getMatchingTags("end")[0]?.[1]);
        const name = c.getMatchingTags("name")[0]?.[1];
        console.log("---");
        console.log("ID:    " + c.id);
        console.log("Name:  " + name);
        console.log("Start: " + start + " (" + new Date(start*1000).toISOString() + ")");
        console.log("End:   " + end + " (" + new Date(end*1000).toISOString() + ")");
    }
    process.exit(0);
}
run();
