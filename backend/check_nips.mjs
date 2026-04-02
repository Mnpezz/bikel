import NDK, { NDKUser } from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = ["wss://relay.bikel.ink", "wss://relay.damus.io", "wss://relay.primal.net"];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function run() {
    await ndk.connect();
    const authors = [
        "9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83",
        "7afc3e977ef2534a83a8b420acacbc8a8d8761fa844ac33d8f8bf8e3175bbe25"
    ];
    for (const a of authors) {
        const user = new NDKUser({ pubkey: a });
        user.ndk = ndk;
        await user.fetchProfile();
        console.log("Pubkey: " + a + " Name: " + user.profile?.name + " NIP-05: " + user.profile?.nip05);
    }
    process.exit(0);
}
run();
