import NDK from "@nostr-dev-kit/ndk";

const ndk = new NDK({ explicitRelayUrls: ["wss://relay.damus.io", "wss://relay.primal.net"] });

async function run() {
    await ndk.connect();

    console.log("Fetching...");
    const start = Date.now();

    // fetchEvents with a timeout option? 
    // Wait, let's see what happens with sub.on("eose") 
    const filters = [
        { kinds: [33301], "#client": ["bikel"], limit: 30 },
        { kinds: [33301], limit: 200 }
    ];

    const events = new Set();
    await new Promise((resolve) => {
        const sub = ndk.subscribe(filters, { closeOnEose: true });

        const timeout = setTimeout(() => {
            console.log("Timeout reached!");
            sub.stop();
            resolve();
        }, 3500);

        let eoseCount = 0;
        sub.on("event", (e) => events.add(e));
        sub.on("eose", (relay) => {
            eoseCount++;
            console.log(`EOSE received from a relay. Total EOSEs: ${eoseCount}, Events so far: ${events.size}`);
            // Let's NOT resolve here to see if we get more events
        });
    });

    console.log(`Finished after ${Date.now() - start}ms. Total events: ${events.size}`);

    process.exit(0);
}
run();
