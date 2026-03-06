import { connectNDK, fetchRecentRides, fetchScheduledRides } from './src/lib/nostr';

async function run() {
    try {
        console.log("Connecting...");
        await connectNDK();
        console.log("Fetching global rides...");
        const globalRides = await fetchRecentRides();
        console.log(`Global rides found: ${globalRides.length}`);

        console.log("Fetching scheduled rides...");
        const schedRides = await fetchScheduledRides();
        console.log(`Scheduled rides found: ${schedRides.length}`);
        for (const r of schedRides) {
            console.log("Sched ride:", r.id, r.name, r.startTime, r.pubkey);
        }
    } catch (e) {
        console.error("Error:", e);
    }
    process.exit(0);
}
run();
