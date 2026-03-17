import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = [
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol",
    "wss://offchain.pub",
    "wss://relay.snort.social"
];

const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    console.log("Connecting...");
    await ndk.connect();
    console.log("Connected.");

    // Fetch ANY kind 1 or 1301 for the last 5 minutes to see what's out there
    const fiveMinsAgo = Math.floor(Date.now() / 1000) - 300;
    const filters = [
        { kinds: [1, 1301, 33301, 42], since: fiveMinsAgo, limit: 20 }
    ];

    console.log("Fetching recent events...");
    const events = await ndk.fetchEvents(filters);
    console.log(`Found ${events.size} events.`);

    for (const e of events) {
        const client = e.getMatchingTags("client")[0]?.[1];
        const tags = e.getMatchingTags("t").map(t => t[1]);
        console.log(`- Kind ${e.kind} | ID: ${e.id.substring(0, 8)} | Client: ${client} | Tags: ${tags.join(', ')}`);
        console.log(`  Content: ${e.content.substring(0, 60)}...`);
    }

    process.exit(0);
}

run().catch(console.error);
