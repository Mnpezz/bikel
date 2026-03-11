import NDK from "@nostr-dev-kit/ndk";
import WebSocket from "ws";
global.WebSocket = WebSocket;

const RELAYS = [
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol"
];

const ndk = new NDK({ explicitRelayUrls: RELAYS });

// Mirrors the fetchWithTimeout helper from index.js.
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

    // Kind 33401 — Bikel custom challenge kind
    console.log("\n--- Querying kind 33401 (Bikel Challenges) ---");
    const contestEvents = await fetchWithTimeout({ kinds: [33401], limit: 20 });
    console.log("33401 challenge events found:", contestEvents.size);
    for (const e of contestEvents) {
        const title = e.getMatchingTags('title')[0]?.[1] ?? '(no title)';
        const end = e.getMatchingTags('end')[0]?.[1] ?? '(no end)';
        const fee = e.getMatchingTags('fee')[0]?.[1] ?? '0';
        const dTag = e.getMatchingTags('d')[0]?.[1] ?? '(no d)';
        const minConfidence = e.getMatchingTags('min_confidence')[0]?.[1] ?? '0.7';
        const payout = e.getMatchingTags('payout')[0]?.slice(1).join('/') ?? '50/30/20';
        console.log(`  id=${e.id.substring(0, 12)}... title="${title}" end=${end} fee=${fee} min_confidence=${minConfidence} payout=${payout} d=${dTag}`);
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

    // Your rides — full tag dump for debugging challenge eligibility
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

    // Challenge window checker — paste a challenge's start/end/min_confidence to debug eligibility.
    // MIN_CONFIDENCE should match the 'min_confidence' tag on the challenge event (default: 0.7).
    console.log("\n--- Challenge Window Check ---");
    const CHALLENGE_START = 1772746248; // update to match your active challenge
    const CHALLENGE_END = 1772919048;   // update to match your active challenge
    const MIN_CONFIDENCE = 0.7;         // update to match the challenge's min_confidence tag
    console.log(`Window: ${new Date(CHALLENGE_START * 1000).toISOString()} → ${new Date(CHALLENGE_END * 1000).toISOString()}`);
    console.log(`Min confidence: ${MIN_CONFIDENCE}`);
    let eligible = 0;
    for (const e of myRides) {
        const inWindow = e.created_at >= CHALLENGE_START && e.created_at <= CHALLENGE_END;
        const confidence = parseFloat(e.getMatchingTags('confidence')[0]?.[1] ?? '0');
        const passing = inWindow && confidence >= MIN_CONFIDENCE;
        console.log(`  id=${e.id.substring(0, 12)}... inWindow=${inWindow} confidence=${confidence} ✅eligible=${passing}`);
        if (passing) eligible++;
    }
    console.log(`${eligible} ride(s) would score in this challenge.`);

    console.log("\n--- Querying kind 31925 (Challenge RSVPs) ---");
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