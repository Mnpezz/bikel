import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = [
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol"
];

const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    console.log("Connected to relays");

    const filters = [
        { kinds: [1, 1301, 33301], "#t": ["bikel"], limit: 10 },
        { kinds: [1, 1301, 33301], "#client": ["bikel"], limit: 10 }
    ];

    console.log("Fetching with filters:", JSON.stringify(filters));
    const events = await ndk.fetchEvents(filters);
    console.log(`Found ${events.size} events in general search.`);

    for (const e of events) {
        console.log(`- [Kind ${e.kind}] ID: ${e.id.substring(0, 8)}... Content: ${e.content.substring(0, 40)}`);
        if (e.kind === 1301 || e.kind === 33301) {
            console.log(`  Fetching replies for this ride...`);
            const replies = await ndk.fetchEvents({ kinds: [1], "#e": [e.id] });
            console.log(`  Found ${replies.size} replies.`);
        }
    }

    process.exit(0);
}

run().catch(console.error);
