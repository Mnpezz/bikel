import NDK from "@nostr-dev-kit/ndk";

const ndk = new NDK({ explicitRelayUrls: ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.nostr.band"] });

async function run() {
    await ndk.connect();
    console.log("Connected to relays.");

    // Query 1: author pubkey (we know this works)
    const pubkey = "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83";
    const userEvs = await ndk.fetchEvents({ kinds: [33301], authors: [pubkey], limit: 5 });
    console.log(`User events found: ${userEvs.size}`);

    // Query 2: just t: cycling
    const cEvs = await ndk.fetchEvents({ kinds: [33301], "#t": ["cycling"], limit: 50 });
    console.log(`t:cycling events found: ${cEvs.size}`);

    // Query 3: just client: bikel
    const bEvs = await ndk.fetchEvents({ kinds: [33301], "#client": ["bikel"], limit: 50 });
    console.log(`client:bikel events found: ${bEvs.size}`);

    // Query 4: broad limit (more than 400)
    const broadEvs = await ndk.fetchEvents({ kinds: [33301], limit: 1000 });
    console.log(`Broad limit 1000 events found: ${broadEvs.size}`);
    let bikelCount = 0;
    broadEvs.forEach(e => {
        if (e.getMatchingTags("client").some(t => t[1] === "bikel")) {
            bikelCount++;
        }
    });
    console.log(`Bikel events in broad limit: ${bikelCount}`);

    process.exit(0);
}
run();
