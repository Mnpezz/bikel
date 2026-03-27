import NDK, { NDKEvent, NDKFilter, NDKRelay } from "@nostr-dev-kit/ndk";
import WebSocket from "ws";

// Node.js doesn't have a global WebSocket by default, which NDK often expects
if (typeof global.WebSocket === 'undefined') {
    (global as any).WebSocket = WebSocket;
}

// The source relays to scrape historic Open Cycling Data from
const SOURCE_RELAYS = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band",
    "wss://relay.primal.net",
    "wss://purplepag.es"
];

// The target personal relay to inject the data into
const TARGET_RELAY = "ws://127.0.0.1:7777"; // Internal localhost on the Hetzner box

async function main() {
    console.log("[Scraper] Initializing Bikel Backfill Utility...");
    const sourceNdk = new NDK({ explicitRelayUrls: SOURCE_RELAYS });
    const targetNdk = new NDK({ explicitRelayUrls: [TARGET_RELAY] });

    console.log("[Scraper] Connecting to Public Network...");
    await sourceNdk.connect(15000);
    const connectedCount = sourceNdk.pool.connectedRelays().length;
    console.log(`[Scraper] Connected to ${connectedCount} source relays.`);

    console.log("[Scraper] Connecting to Local Bikel Relay...");
    await targetNdk.connect(5000);
    console.log("[Scraper] Personal Relay Connected.");

    // Core Bikel Data Filters
    const filters: NDKFilter[] = [
        { kinds: [33301, 1301, 31923, 33401] as any },
        { kinds: [1], "#t": ["bikel", "runstr", "cycling"] }
    ];

    console.log("[Scraper] Querying sources for historic data (this may take a minute)...");
    const historicEvents = new Set<NDKEvent>();
    const sub = sourceNdk.subscribe(filters, { closeOnEose: true });

    sub.on("event", (ev: NDKEvent) => {
        if (!historicEvents.has(ev)) {
           historicEvents.add(ev);
           if (historicEvents.size % 100 === 0 || historicEvents.size === 1) {
              process.stdout.write(`\r[Scraper] Discovered ${historicEvents.size} unique events...`);
           }
        }
    });

    await new Promise<void>((resolve) => {
        sub.on("eose", () => {
             console.log("\n[Scraper] Global search complete.");
             resolve();
        });
        setTimeout(resolve, 180000); // 3-minute hard limit
    });
    
    sub.stop(); 
    
    console.log(`[Scraper] Final discovery count: ${historicEvents.size} events.`);
    console.log("[Scraper] Mirroring data to personal relay...");

    let successCount = 0;
    let failCount = 0;
    const eventsArray = Array.from(historicEvents);
    const BATCH_SIZE = 50;
    
    for (let i = 0; i < eventsArray.length; i += BATCH_SIZE) {
        const batch = eventsArray.slice(i, i + BATCH_SIZE);
        const promises = batch.map(async (ev) => {
            try {
                ev.ndk = targetNdk;
                await ev.publish();
                successCount++;
            } catch (e) {
                failCount++;
            }
        });
        
        await Promise.all(promises);
        process.stdout.write(`\r[Scraper] Injection Progress: ${successCount + failCount} / ${eventsArray.length}`);
    }

    console.log(`\n\n[Scraper] Migration Complete!`);
    console.log(`- Successfully Injected: ${successCount}`);
    console.log(`- Already present / Filtered: ${failCount}`);
    
    process.exit(0);
}

main().catch(console.error);
