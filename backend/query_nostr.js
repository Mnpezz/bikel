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
    const args = process.argv.slice(2);
    const TARGET_CONTEST_ID = args.find(a => !a.startsWith('--'));

    try {
        await Promise.race([
            ndk.connect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Connect timeout")), 10000))
        ]);
    } catch (e) {
        console.warn("[Query] Connect timed out, proceeding with available relays:", e.message);
    }
    console.log("Connected");

    if (TARGET_CONTEST_ID) {
        console.log(`\n--- Debugging Contest (ID or Prefix): ${TARGET_CONTEST_ID} ---`);

        let contest;
        if (TARGET_CONTEST_ID.length === 64) {
            const contests = await fetchWithTimeout({ kinds: [33401], ids: [TARGET_CONTEST_ID] });
            contest = Array.from(contests)[0];
        } else {
            console.log(`Searching for contests matching prefix "${TARGET_CONTEST_ID}"...`);
            const contests = await fetchWithTimeout({ kinds: [33401] });
            contest = Array.from(contests).find(c => c.id.startsWith(TARGET_CONTEST_ID));
        }

        if (!contest) {
            console.log("❌ Contest not found.");
            process.exit(1);
        }

        console.log(`Found Contest: ${contest.id}`);
        const title = contest.getMatchingTags('title')[0]?.[1] ?? '(no title)';
        const dTag = contest.getMatchingTags('d')[0]?.[1];
        const start = parseInt(contest.getMatchingTags('start')[0]?.[1] || '0', 10);
        const end = parseInt(contest.getMatchingTags('end')[0]?.[1] || '0', 10);
        const minConf = parseFloat(contest.getMatchingTags('min_confidence')[0]?.[1] || '0.7');

        console.log(`Title: ${title}`);
        console.log(`Window: ${new Date(start * 1000).toISOString()} -> ${new Date(end * 1000).toISOString()}`);
        console.log(`Min Confidence: ${minConf}`);

        // RSVPs
        const aTag = `33401:${contest.pubkey}:${dTag}`;
        console.log(`Looking for RSVPs with a-tag: ${aTag}`);
        const rsvps = await fetchWithTimeout({ kinds: [31925], '#a': [aTag] });
        console.log(`Participants found: ${rsvps.size}`);

        const participantPubkeys = Array.from(rsvps).map(r => r.pubkey);
        for (const p of participantPubkeys) {
            console.log(`  - Participant: ${p.substring(0, 8)}...`);
        }

        if (participantPubkeys.length > 0) {
            console.log(`\nFetching rides for these participants...`);
            const rides = await fetchWithTimeout({
                kinds: [33301],
                authors: participantPubkeys,
                since: start - 86400, // Look a bit before just in case
                until: end + 86400    // Look a bit after just in case
            });
            console.log(`Total rides found in expanded window: ${rides.size}`);

            for (const ride of rides) {
                const rStart = ride.created_at;
                const dist = ride.getMatchingTags('distance')[0]?.[1] ?? '0';
                const conf = parseFloat(ride.getMatchingTags('confidence')[0]?.[1] || '0');

                const inWin = rStart >= start && rStart <= end;
                const confOk = conf >= minConf;

                console.log(`  Ride ${ride.id.substring(0, 8)} by ${ride.pubkey.substring(0, 8)}...`);
                console.log(`    Created: ${new Date(rStart * 1000).toISOString()} (In window: ${inWin})`);
                console.log(`    Distance: ${dist}, Confidence: ${conf} (Conf OK: ${confOk})`);
                console.log(`    STATUS: ${inWin && confOk ? '✅ ELIGIBLE' : '❌ REJECTED'}`);
            }
        }
        process.exit(0);
    }

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

    process.exit(0);
}

run().catch(e => {
    console.error("[Query] Fatal error:", e);
    process.exit(1);
});