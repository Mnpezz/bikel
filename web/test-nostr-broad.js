import NDK from '@nostr-dev-kit/ndk';

const ndk = new NDK({ explicitRelayUrls: ["wss://relay.damus.io", "wss://relay.primal.net"] });

async function run() {
    await ndk.connect();

    console.log("Fetching global 33301 without tag filters...");
    const evs = await ndk.fetchEvents({ kinds: [33301], limit: 20 });
    console.log(`Found ${evs.size} events.`);
    evs.forEach(e => {
        const client = e.getMatchingTags("client")[0]?.[1] || 'none';
        if (client === 'bikel') {
            console.log("Found bikel ride!", e.id);
        }
    });

    console.log("Fetching global 31923 without tag filters...");
    const evs2 = await ndk.fetchEvents({ kinds: [31923], limit: 20 });
    console.log(`Found ${evs2.size} events.`);
    evs2.forEach(e => {
        const client = e.getMatchingTags("client")[0]?.[1];
        if (client === 'bikel') console.log("Found bikel scheduled ride!", e.id);
    });

    process.exit(0);
}
run();
