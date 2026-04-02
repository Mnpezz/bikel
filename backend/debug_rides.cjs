
const NDK = require('@nostr-dev-kit/ndk').default;

const RELAYS = [
    'wss://relay.bikel.ink',
    'wss://relay.damus.io',
    'wss://relay.primal.net'
];

async function checkRecentRides() {
    const ndk = new NDK({ explicitRelayUrls: RELAYS });
    await ndk.connect();
    
    const now = Math.floor(Date.now() / 1000);
    console.log(`Checking for Kind 1301/33301 rides since ${new Date((now - 7200) * 1000).toISOString()}...`);
    
    const events = await ndk.fetchEvents({
        kinds: [1301, 33301],
        since: now - 7200, // Check last 2 hours
        limit: 10
    });
    
    console.log(`Found ${events.size} events.`);
    for (const ev of events) {
        console.log(`- Event ID: ${ev.id}`);
        console.log(`  Pubkey: ${ev.pubkey}`);
        console.log(`  Kind: ${ev.kind}`);
        console.log(`  Created At: ${new Date(ev.created_at * 1000).toISOString()}`);
        console.log(`  Tags: ${JSON.stringify(ev.tags.filter(t => ['client', 'checkpoint_hit', 'route'].includes(t[0])))}`);
        console.log('---');
    }
    process.exit(0);
}

checkRecentRides().catch(e => {
    console.error(e);
    process.exit(1);
});
