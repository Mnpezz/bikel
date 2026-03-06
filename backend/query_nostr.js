import NDK from "@nostr-dev-kit/ndk";

const ndk = new NDK({
    explicitRelayUrls: [
        "wss://relay.damus.io",
        "wss://relay.primal.net",
        "wss://nos.lol"
    ],
});

async function run() {
    await ndk.connect();
    console.log("Connected");

    // Let's find the user's pubkey first. We know the user npub starts with npub1esfsk...
    // The user has a profile named "bikel". Let's search by authors if we can't find it easily.
    // Or just query the recent kinds 33301 and 31923
    
    let filter = { kinds: [31923], limit: 20 };
    let evs = await ndk.fetchEvents(filter);
    console.log("Any 31923 events:", evs.size);
    for (const e of evs) {
        console.log("31923 event:", e.id, "tags:", e.tags);
    }

    let filter2 = { kinds: [33301], limit: 20 };
    let evs2 = await ndk.fetchEvents(filter2);
    console.log("Any 33301 events:", evs2.size);
    
    // Check if the user's npub was known. The user screenshot says "npub1esfsk..."
    // We can just rely on the test outputs.

    process.exit(0);
}
run();
