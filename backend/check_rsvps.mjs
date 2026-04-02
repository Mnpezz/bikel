import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io", "wss://relay.primal.net"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const contestId = "fdb7fbfe9b0f0a5318d73f7dc6296d75a60bb6797558f2554f39b3217ba0cf3b";
    
    console.log("Fetching contest...");
    const contest = await ndk.fetchEvent(contestId);
    if (!contest) { console.log("Contest not found"); process.exit(1); }

    const dTag = contest.getMatchingTags("d")[0]?.[1];
    const aTag = `33401:${contest.pubkey}:${dTag}`;
    console.log("Fetching RSVPs for: " + aTag);

    const rsvps = await ndk.fetchEvents({ kinds: [31925], "#a": [aTag] });
    console.log("Total RSVPs: " + rsvps.size);
    for (const r of rsvps) {
        console.log("User: " + r.pubkey + " Status: " + r.getMatchingTags("l")[0]?.[1]);
    }
    process.exit(0);
}
run();
