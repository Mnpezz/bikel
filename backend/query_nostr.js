import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = [
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol"
];

const ndk = new NDK({ explicitRelayUrls: RELAYS });

// FIX 1: Mirrors the fetchWithTimeout helper from index.js.
// Raw ndk.fetchEvents() can hang indefinitely on relays like Damus
// that are slow to send EOSE, so we use a subscription with a timeout instead.
function fetchWithTimeout(filter, timeoutMs = 10000) {
    return new Promise((resolve) => {
        const events = new Set();
        const sub = ndk.subscribe(filter, { closeOnEose: true });
        let isDone = false;

        sub.on('event', (e) => events.add(e));
        sub.on('eose', () => {
            if (!isDone) { isDone = true; resolve(events); }
        });

        setTimeout(() => {
            if (!isDone) {
                console.log(`[Query] Timeout after ${timeoutMs}ms — returning ${events.size} events.`);
                isDone = true;
                resolve(events);
            }
        }, timeoutMs);
    });
}

async function run() {
    try {
        await Promise.race([
            ndk.connect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Connect timeout")), 10000))
        ]);
    } catch (e) {
        console.warn("[Query] Connect timed out, proceeding with available relays:", e.message);
    }
    console.log("Connected");

    // FIX 2: Was querying kind 31923 — the bot uses kind 31924 for contests.
    // 31923 is the NIP-52 calendar event kind (not what Bikel uses).
    // Changed to 31924 to match index.js contest events.
    console.log("\n--- Querying kind 31924 (Bikel Contests) ---");
    const contestEvents = await fetchWithTimeout({ kinds: [31924], limit: 20 });
    console.log("31924 contest events found:", contestEvents.size);
    for (const e of contestEvents) {
        const name = e.getMatchingTags('name')[0]?.[1] ?? '(no name)';
        const end = e.getMatchingTags('end')[0]?.[1] ?? '(no end)';
        const fee = e.getMatchingTags('fee')[0]?.[1] ?? '0';
        const dTag = e.getMatchingTags('d')[0]?.[1] ?? '(no d)';
        console.log(`  id=${e.id.substring(0, 12)}... name="${name}" end=${end} fee=${fee} d=${dTag}`);
        console.log(`  tags:`, e.tags);
    }

    // Kind 33301 — ride events (unchanged, correct)
    console.log("\n--- Querying kind 33301 (Ride Events) ---");
    const rideEvents = await fetchWithTimeout({ kinds: [33301], limit: 20 });
    console.log("33301 ride events found:", rideEvents.size);
    for (const e of rideEvents) {
        const distance = e.getMatchingTags('distance')[0]?.[1] ?? '?';
        const confidence = e.getMatchingTags('confidence')[0]?.[1] ?? '?';
        console.log(`  id=${e.id.substring(0, 12)}... pubkey=${e.pubkey.substring(0, 8)}... distance=${distance} confidence=${confidence}`);
    }

    // Your rides — full tag dump for debugging contest eligibility
    const MY_PUBKEY = '9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83';
    console.log("\n--- Your Recent Rides (full tags) ---");
    const myRides = await fetchWithTimeout({ kinds: [33301], authors: [MY_PUBKEY], limit: 10 }, 10000);
    console.log(`Found ${myRides.size} ride(s):`);
    for (const e of myRides) {
        const distance = e.getMatchingTags('distance')[0]?.[1] ?? '(missing)';
        const confidence = e.getMatchingTags('confidence')[0]?.[1] ?? '(missing)';
        const duration = e.getMatchingTags('duration')[0]?.[1] ?? '(missing)';
        const date = new Date(e.created_at * 1000).toISOString();
        console.log(`  id=${e.id.substring(0, 12)}... created=${date} distance=${distance} confidence=${confidence} duration=${duration}`);
    }

    // Contest window checker — paste a contest's start/end to see which rides fall inside
    console.log("\n--- Contest Window Check ---");
    const CONTEST_START = 1772746248; // update these to match your active contest
    const CONTEST_END = 1772919048;
    console.log(`Window: ${new Date(CONTEST_START * 1000).toISOString()} → ${new Date(CONTEST_END * 1000).toISOString()}`);
    let eligible = 0;
    for (const e of myRides) {
        const inWindow = e.created_at >= CONTEST_START && e.created_at <= CONTEST_END;
        const confidence = parseFloat(e.getMatchingTags('confidence')[0]?.[1] ?? '0');
        const passing = inWindow && confidence >= 0.85;
        console.log(`  id=${e.id.substring(0, 12)}... inWindow=${inWindow} confidence=${confidence} ✅eligible=${passing}`);
        if (passing) eligible++;
    }
    console.log(`${eligible} ride(s) would score in this contest.`);
    console.log("\n--- Querying kind 31925 (Contest RSVPs) ---");
    const rsvpEvents = await fetchWithTimeout({ kinds: [31925], limit: 20 });
    console.log("31925 RSVP events found:", rsvpEvents.size);
    for (const e of rsvpEvents) {
        const aTag = e.getMatchingTags('a')[0]?.[1] ?? '(no a tag)';
        console.log(`  pubkey=${e.pubkey.substring(0, 8)}... a="${aTag}"`);
    }

    process.exit(0);
}

run().catch(e => {
    console.error("[Query] Fatal error:", e);
    process.exit(1);
});