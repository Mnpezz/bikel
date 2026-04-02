
import NDK from '@nostr-dev-kit/ndk';
import WebSocket from 'ws';
global.WebSocket = WebSocket;

const RELAYS = [
    'wss://relay.bikel.ink',
    'wss://relay.damus.io',
    'wss://relay.primal.net'
];

async function checkRecentRides() {
    const ndk = new NDK({ explicitRelayUrls: RELAYS });
    await ndk.connect();
    
    const now = Math.floor(Date.now() / 1000);
    console.log(`[Diagnostic] Checking for Kind 1301/33301 rides since ${new Date((now - 14400) * 1000).toISOString()} (last 4 hours)...`);
    
    const events = await ndk.fetchEvents({
        kinds: [1301, 33301],
        since: now - 14400,
        limit: 20
    });
    
    console.log(`[Diagnostic] Found ${events.size} events.`);
    for (const ev of events) {
        console.log(`- Event ID: ${ev.id}`);
        console.log(`  Pubkey: ${ev.pubkey}`);
        console.log(`  Kind: ${ev.kind}`);
        console.log(`  Created At: ${ev.created_at} (${new Date(ev.created_at * 1000).toISOString()})`);
        console.log(`  Tags: ${JSON.stringify(ev.tags)}`);
        console.log('---');
    }
    process.exit(0);
}

checkRecentRides().catch(e => {
    console.error(e);
    process.exit(1);
});
