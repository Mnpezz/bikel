import { NDKUser } from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

async function run() {
    const npub = "npub1jdn6j50nukyq82ug6vzn5xmmr0j98xkaemz4tdsulgvutu3e06psp3t054";
    const user = new NDKUser({ npub });
    console.log("Hex Pubkey:", user.pubkey);
    process.exit(0);
}
run();
