import { connectNDK, fetchRecentRides, fetchScheduledRides, fetchUserRides } from './src/lib/nostr';

async function run() {
    await connectNDK();
    
    // The user's npub according to Plektos is likely something specific. But we can just fetch all global rides.
    console.log("Fetching global rides...");
    const globalRides = await fetchRecentRides();
    console.log(`Global rides found: ${globalRides.length}`);

    console.log("Fetching scheduled rides...");
    const schedRides = await fetchScheduledRides();
    console.log(`Scheduled rides found: ${schedRides.length}`);
    for (const r of schedRides) {
        console.log("Sched ride:", r.id, r.name, r.startTime, r.pubkey);
    }
    
    // Find Plektos's latest event on relay.damus.io or primal.net. 
    process.exit(0);
}
run();
