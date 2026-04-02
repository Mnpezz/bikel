import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.bikel.ink"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect(5000);
    const userHex = "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83";
    console.log("Searching for RSVPs (Kind 31925) for: " + userHex);
    
    // Last 3 days
    const since = Math.floor(Date.now() / 1000) - (72 * 3600);
    
    const rsvps = await ndk.fetchEvents({
        kinds: [31925],
        authors: [userHex],
        since: since
    }, {timeout: 15000});
    
    console.log("Found " + rsvps.size + " RSVP events.");
    for (const r of rsvps) {
        console.log("ID: " + r.id);
        console.log("Created: " + new Date(r.created_at*1000).toISOString());
        console.log("Tags: " + JSON.stringify(r.tags));
        
        // Find the challenge ID linked in 'a' tag
        const aTag = r.getMatchingTags("a")[0]?.[1];
        if (aTag) {
            console.log("Linked Challenge (a): " + aTag);
            // Fetch the challenge event to see its window
            const challenge = await ndk.fetchEvent(aTag);
            if (challenge) {
                const name = challenge.getMatchingTags("name")[0]?.[1] || challenge.getMatchingTags("title")[0]?.[1];
                const start = challenge.getMatchingTags("start")[0]?.[1];
                const end = challenge.getMatchingTags("end")[0]?.[1];
                console.log("  Challenge Name: " + name);
                console.log("  Challenge Window: " + (start ? new Date(parseInt(start)*1000).toISOString() : "N/A") + " to " + (end ? new Date(parseInt(end)*1000).toISOString() : "N/A"));
            }
        }
        console.log("---");
    }
    process.exit(0);
}
run();
