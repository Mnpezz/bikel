import NDK from "@nostr-dev-kit/ndk";

const ndk = new NDK({ explicitRelayUrls: ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"] });

async function run() {
    await ndk.connect();
    
    console.log("Testing tag queries directly...");

    const f1 = { kinds: [33301], "#t": ["cycling"] };
    const e1 = await ndk.fetchEvents(f1);
    console.log("Cycling tag count:", e1.size);

    const f2 = { kinds: [33301], "#t": ["bikel"] };
    const e2 = await ndk.fetchEvents(f2);
    console.log("bikel tag count:", e2.size);

    const f3 = { kinds: [33301], "#client": ["bikel"] };
    const e3 = await ndk.fetchEvents(f3);
    console.log("client:bikel tag count:", e3.size);

    // Let's also check without tags just to see what the latest are
    const f4 = { kinds: [33301], limit: 200 };
    const e4 = await ndk.fetchEvents(f4);
    let count = 0;
    e4.forEach(e => {
        if (e.getMatchingTags("client").some(t => t[1] === "bikel")) count++;
    });
    console.log("Generic fetch count containing bikel:", count, "out of", e4.size);

    process.exit(0);
}
run();
