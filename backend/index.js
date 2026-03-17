import NDK, { NDKEvent, NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import { nip19 } from 'nostr-tools';
import axios from 'axios';
import cron from 'node-cron';
import dotenv from 'dotenv';
import WebSocket from "ws";
import fs from 'fs';
global.WebSocket = WebSocket;

dotenv.config();

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol'
];

const COINOS_API_URL = 'https://coinos.io/api';
const COINOS_API_KEY = process.env.COINOS_API_KEY;
const BOT_NSEC = process.env.BOT_NSEC;
const PLATFORM_FEE_PCT = 0.05; // 5% stays in Coinos as platform fee
const BOT_VERSION = '1.1.0';

// Default splits for up to 3 winners — used only when the challenge event has no 'payout' tag.
// The event's 'payout' tag always takes precedence so organizers can customize splits.
//   1 winner  → [1.0]            (100%)
//   2 winners → [0.625, 0.375]   (62.5% / 37.5%)
//   3 winners → [0.50, 0.30, 0.20]
const PAYOUT_SPLITS_BASE = [0.50, 0.30, 0.20];

/**
 * Returns normalized payout fractions for the given winner count.
 * If the challenge event has a 'payout' tag (e.g. ["payout","70","30","0"]),
 * those percentages are used instead of the defaults.
 */
function getPayoutSplits(winnerCount, eventPayoutTag) {
    if (winnerCount <= 0) return [];

    let base = PAYOUT_SPLITS_BASE;

    // Read from event tag if present and valid
    if (eventPayoutTag && eventPayoutTag.length >= 2) {
        const parsed = eventPayoutTag.slice(1).map(Number).filter(n => !isNaN(n) && n >= 0);
        if (parsed.length > 0) base = parsed.map(n => n / 100);
    }

    const count = Math.min(winnerCount, base.length);
    const raw = base.slice(0, count);
    const total = raw.reduce((a, b) => a + b, 0);
    if (total === 0) return raw.map(() => 0);
    return raw.map(s => s / total);
}

// ─────────────────────────────────────────────
// Persistence — processed contests & pending payouts
// ─────────────────────────────────────────────
const PROCESSED_FILE = './processed_contests.json';
const PENDING_PAYOUTS_FILE = './pending_payouts.json';

function loadProcessedContests() {
    try {
        if (fs.existsSync(PROCESSED_FILE))
            return new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8')));
    } catch (e) {
        console.warn('[Bot] Could not read processed contests file, starting fresh:', e.message);
    }
    return new Set();
}

function saveProcessedContest(contestId) {
    try {
        const existing = loadProcessedContests();
        existing.add(contestId);
        fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...existing], null, 2));
    } catch (e) {
        console.error('[Bot] CRITICAL: Could not save processed contest ID. Risk of double payout!', e.message);
    }
}

// Pending payouts: { [nudgeNoteId]: { pubkey, splitSats, contestId, contestName } }
function loadPendingPayouts() {
    try {
        if (fs.existsSync(PENDING_PAYOUTS_FILE))
            return JSON.parse(fs.readFileSync(PENDING_PAYOUTS_FILE, 'utf8'));
    } catch (e) {
        console.warn('[Bot] Could not read pending payouts file:', e.message);
    }
    return {};
}

function savePendingPayout(noteId, data) {
    const existing = loadPendingPayouts();
    existing[noteId] = data;
    fs.writeFileSync(PENDING_PAYOUTS_FILE, JSON.stringify(existing, null, 2));
}

function removePendingPayout(noteId) {
    const existing = loadPendingPayouts();
    delete existing[noteId];
    fs.writeFileSync(PENDING_PAYOUTS_FILE, JSON.stringify(existing, null, 2));
}

// ─────────────────────────────────────────────
// NDK
// ─────────────────────────────────────────────
async function initializeNDK() {
    let signer;
    if (BOT_NSEC) {
        signer = new NDKPrivateKeySigner(BOT_NSEC);
        console.log('[Bot] Initialized with NSEC Signer.');
    }
    const ndk = new NDK({ explicitRelayUrls: RELAYS, signer });

    console.log('[Bot] Connecting to Nostr relays...');
    try {
        await Promise.race([
            ndk.connect(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('NDK Connect Timeout')), 30000))
        ]);
        console.log('[Bot] Connected to Nostr relays.');
    } catch (e) {
        console.warn('[Bot] Some relays timed out, proceeding with available:', e.message);
    }
    return ndk;
}

// Subscription-based fetch with timeout to avoid infinite hangs on slow relays
async function fetchWithTimeout(ndk, filter, timeoutMs = 20000) {
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
                console.log(`[Bot] Fetch timeout (${timeoutMs}ms) — returning ${events.size} events.`);
                isDone = true;
                sub.stop(); // Stop subscription on timeout
                resolve(events);
            }
        }, timeoutMs);
    });
}

// ─────────────────────────────────────────────
// Coinos — pay a bolt11 invoice via POST /payments
// ─────────────────────────────────────────────
async function payLightningInvoice(invoice) {
    if (!COINOS_API_KEY) {
        console.error('[Bot] COINOS_API_KEY missing. Cannot process payout.');
        return false;
    }
    try {
        console.log(`[Bot] Paying invoice: ${invoice.substring(0, 20)}...`);
        const response = await axios.post(
            `${COINOS_API_URL}/payments`,
            { payreq: invoice },
            { headers: { 'Authorization': `Bearer ${COINOS_API_KEY}`, 'content-type': 'application/json' } }
        );
        console.log('[Bot] Payout successful!', response.data);
        return true;
    } catch (error) {
        console.error('[Bot] Payout failed:', error?.response?.data || error.message);
        return false;
    }
}

// ─────────────────────────────────────────────
// Coinos payment verification
// Checks that an incoming payment of the right amount arrived around the
// time of the RSVP. Uses Coinos GET /payments with start/end query params
// to narrow the window server-side.
//
// Notes on the Coinos API:
// - Amounts are in SATS (not msats)
// - Positive amount = incoming, negative = outgoing
// - No dedicated "memo" field exposed — we match by amount + time window only
// - start/end query params are Unix timestamps
//
// FAILS OPEN: if Coinos is unreachable we accept the RSVP — the app already
// verified the zap succeeded before publishing the RSVP, so this is a
// second-layer sanity check, not the primary gate.
// ─────────────────────────────────────────────

/**
 * Fetch Coinos incoming payments within a time window.
 * Uses start/end query params to avoid loading the full payment history.
 */
async function fetchCoinosPaymentsInWindow(startTs, endTs) {
    if (!COINOS_API_KEY) return null; // null = API key missing, fail open
    try {
        const response = await axios.get(
            `${COINOS_API_URL}/payments`,
            {
                headers: { 'Authorization': `Bearer ${COINOS_API_KEY}`, 'content-type': 'application/json' },
                params: { start: startTs, end: endTs, limit: 100 }
            }
        );
        const payments = Array.isArray(response.data) ? response.data : (response.data?.payments || []);
        return payments;
    } catch (e) {
        console.warn('[Bot] Could not fetch Coinos payments:', e.message);
        return null; // null = fetch failed, fail open
    }
}

/**
 * Verifies that a contest entry fee arrived in the Coinos account.
 * Matches: incoming payment (amount > 0) with amount >= feeSats
 * within a ±2 hour window around the RSVP timestamp.
 *
 * Fails open if: fee is 0, Coinos API is unavailable, or API key is missing.
 */
async function verifyContestPayment(contestId, feeSats, rsvpCreatedAt) {
    if (feeSats <= 0) return true; // Free contest — no payment needed

    // Wide window: 1 hour before RSVP, 24 hours after (covers delayed NWC payments
    // and cases where the payment arrived before the RSVP was published)
    const windowSecs = 3600;
    const startTs = rsvpCreatedAt - windowSecs;
    const endTs = rsvpCreatedAt + (windowSecs * 24);

    // Coinos API uses milliseconds — convert from Unix seconds
    const payments = await fetchCoinosPaymentsInWindow(startTs * 1000, endTs * 1000);

    // Fail open if API unavailable
    if (payments === null) {
        console.log(`[Bot]   ⚠️ Coinos API unavailable — cannot verify payment, accepting RSVP (fail open)`);
        return true;
    }

    if (payments.length === 0) {
        console.log(`[Bot]   ⚠️ No Coinos payments found in window [${new Date(startTs * 1000).toISOString()} → ${new Date(endTs * 1000).toISOString()}] — accepting RSVP (fail open)`);
        return true;
    }

    // Find an incoming payment of at least feeSats
    // Coinos amounts are in sats. Positive = incoming, negative = outgoing.
    const match = payments.find(p => {
        const amount = typeof p.amount === 'number' ? p.amount : parseInt(p.amount, 10);
        if (isNaN(amount) || amount <= 0) return false; // outgoing or invalid
        if (amount < feeSats) return false;
        return true;
    });

    if (match) {
        console.log(`[Bot]   ✅ Payment verified for contest ${contestId.substring(0, 8)}: ${match.amount} sats received`);
        return true;
    }

    console.log(`[Bot]   ❌ No incoming payment >= ${feeSats} sats found for contest ${contestId.substring(0, 8)} in window — rejecting RSVP`);
    return false;
}

// ─────────────────────────────────────────────
// Payout helper — fetch lud16, get invoice, pay
// ─────────────────────────────────────────────
async function payoutWinner(ndk, pubkey, splitSats) {
    const splitMsats = splitSats * 1000;

    const userObj = ndk.getUser({ pubkey });
    let profile;
    try {
        profile = await userObj.fetchProfile();
    } catch (err) {
        console.warn(`[Bot] Could not fetch profile for ${pubkey.substring(0, 8)}:`, err.message);
    }

    const lud16 = profile?.lud16;
    if (!lud16 || !lud16.includes('@')) return false;

    const [user, domain] = lud16.split('@');
    try {
        const lnurlpRes = await axios.get(`https://${domain}/.well-known/lnurlp/${user}`);
        const callback = lnurlpRes.data.callback;
        if (!callback) return false;

        const invoiceRes = await axios.get(`${callback}?amount=${splitMsats}`);
        const pr = invoiceRes.data.pr;
        if (!pr) return false;

        return await payLightningInvoice(pr);
    } catch (err) {
        console.error(`[Bot] Failed to get invoice for ${lud16}:`, err.message);
        return false;
    }
}

// ─────────────────────────────────────────────
// Nostr helpers — public note
// ─────────────────────────────────────────────
async function publishNote(ndk, content, extraTags = []) {
    if (!ndk.signer) return null;
    try {
        const note = new NDKEvent(ndk);
        note.kind = 1;
        note.content = content;
        note.tags = [
            ['client', 'bikel'],
            ['t', 'bikel'],
            ['t', 'cycling'],
            ...extraTags
        ];
        await note.publish();
        console.log(`[Bot] Published note: ${note.id}`);
        return note;
    } catch (err) {
        console.error('[Bot] Failed to publish note:', err.message);
        return null;
    }
}

// ─────────────────────────────────────────────
// Reply listener — retries pending payouts when
// a winner replies to their "set your lud16" note
// ─────────────────────────────────────────────
async function startReplyListener(ndk) {
    const pending = loadPendingPayouts();
    const noteIds = Object.keys(pending);

    if (noteIds.length === 0) {
        console.log('[Bot] No pending payouts — reply listener not needed.');
        return;
    }

    console.log(`[Bot] Listening for replies on ${noteIds.length} pending payout note(s)...`);

    const sub = ndk.subscribe({ kinds: [1], '#e': noteIds }, { closeOnEose: false });

    sub.on('event', async (reply) => {
        const referencedNoteId = reply.tags
            .find(t => t[0] === 'e' && noteIds.includes(t[1]))?.[1];
        if (!referencedNoteId) return;

        const payout = pending[referencedNoteId];
        if (!payout) return;
        if (reply.pubkey !== payout.pubkey) return;

        console.log(`[Bot] Winner ${payout.pubkey.substring(0, 8)} replied — retrying ${payout.splitSats} sat payout...`);

        const success = await payoutWinner(ndk, payout.pubkey, payout.splitSats);

        if (success) {
            removePendingPayout(referencedNoteId);
            delete pending[referencedNoteId];

            const npub = nip19.npubEncode(payout.pubkey);
            await publishNote(ndk,
                `✅ Payout of ${payout.splitSats} sats sent to nostr:${npub} for "${payout.contestName}"! ⚡`,
                [['p', payout.pubkey]]
            );
            console.log(`[Bot] Retry payout successful for ${payout.pubkey.substring(0, 8)}.`);
        } else {
            console.log(`[Bot] Retry still failed for ${payout.pubkey.substring(0, 8)} — lud16 may still not be set.`);
        }
    });
}

// ─────────────────────────────────────────────
// Upcoming challenge announcements
// Posts a hype note for challenges starting within the next hour
// ─────────────────────────────────────────────
async function announceUpcomingContests(ndk) {
    console.log('[Bot] Checking for challenges starting soon...');

    const now = Math.floor(Date.now() / 1000);
    const oneHour = 60 * 60;

    // Kind 33401 — Bikel custom challenge kind
    const contestsRaw = await fetchWithTimeout(ndk, { kinds: [33401] }, 20000);

    const startingSoon = Array.from(contestsRaw).filter(c => {
        const start = parseInt(c.getMatchingTags('start')[0]?.[1] || '0', 10);
        const hasBikelTag = c.getMatchingTags('t').some(t => t[1] === 'bikel' || t[1] === 'bikel-challenge');
        if (!hasBikelTag) return false;

        return start > now && start <= now + oneHour;
    });

    if (startingSoon.length === 0) {
        console.log('[Bot] No challenges starting in the next hour.');
        return;
    }

    for (const contest of startingSoon) {
        // 'title' tag — kind 33401 uses 'title', not 'name'
        const name = contest.getMatchingTags('title')[0]?.[1] || 'Community Challenge';
        const parameter = contest.getMatchingTags('parameter')[0]?.[1] || 'max_distance';
        const feeSats = contest.getMatchingTags('fee')[0]?.[1] || '0';
        const nevent = nip19.neventEncode({ id: contest.id, relays: RELAYS });

        const paramLabel = parameter === 'max_distance' ? 'most miles'
            : parameter === 'max_elevation' ? 'most elevation'
                : parameter === 'fastest_mile' ? 'fastest mile'
                    : parameter;

        const feeText = parseInt(feeSats) > 0
            ? `Entry: ${feeSats} sats. Top riders split the prize pool! ⚡`
            : `This challenge is free to enter!`;

        const content =
            `🚴 A Bikel challenge is starting soon!\n\n` +
            `📋 ${name}\n` +
            `🏆 Metric: ${paramLabel}\n` +
            `${feeText}\n\n` +
            `Join now and get your legs ready 👇\n` +
            `nostr:${nevent}`;

        await publishNote(ndk, content, [['e', contest.id, RELAYS[0], 'mention']]);
        console.log(`[Bot] Announced upcoming challenge: "${name}"`);
    }
}

// ─────────────────────────────────────────────
// Main — process finished challenges
// ─────────────────────────────────────────────
async function processFinishedContests() {
    console.log('[Bot] Running finished challenge aggregator...');

    const processedContests = loadProcessedContests();
    console.log(`[Bot] ${processedContests.size} challenge(s) already processed (will skip).`);

    try {
        const ndk = await initializeNDK();
        const now = Math.floor(Date.now() / 1000);
        // Expand window to 72 hours for robustness
        const cutoff = now - (72 * 60 * 60);
        // 1 hour grace period to allow relays to sync and users to upload rides
        const GRACE_PERIOD = 3600;

        await announceUpcomingContests(ndk);
        await startReplyListener(ndk);

        // Kind 33401 — Bikel custom challenge kind
        const contestsRaw = await fetchWithTimeout(ndk, { kinds: [33401] }, 20000);
        console.log(`[Bot] Found ${contestsRaw.size} raw kind-33401 events on relays.`);

        const finishedContests = Array.from(contestsRaw).filter(c => {
            const end = parseInt(c.getMatchingTags('end')[0]?.[1] || '0', 10);
            const title = c.getMatchingTags('title')[0]?.[1] || '(no title)';
            const hasBikelTag = c.getMatchingTags('t').some(t => t[1] === 'bikel' || t[1] === 'bikel-challenge');

            if (!hasBikelTag) {
                // Not a bikel challenge, ignore silently or with debug
                return false;
            }

            // Must have ended more than GRACE_PERIOD ago, but less than cutoff ago
            const isGracePeriod = end >= (now - GRACE_PERIOD);
            const isTooOld = end <= cutoff;
            const isFinished = end < now;

            if (isFinished && !isGracePeriod && !isTooOld) {
                return true;
            } else {
                if (isGracePeriod) {
                    const remainingMs = (end + GRACE_PERIOD) * 1000 - Date.now();
                    const remainingMins = Math.ceil(remainingMs / 60000);
                    console.log(`[Bot]   - "${title}" (${c.id.substring(0, 8)}): Waiting for grace period (${remainingMins}m remaining until ${new Date((end + GRACE_PERIOD) * 1000).toISOString()})`);
                } else if (isTooOld) {
                    console.log(`[Bot]   - "${title}" (${c.id.substring(0, 8)}): Too old to process (ended ${new Date(end * 1000).toISOString()})`);
                }
                // If not finished yet, we just ignore it here (it's "Upcoming" or "Active")
                return false;
            }
        });

        console.log(`[Bot] Found ${finishedContests.length} finished challenge(s).`);

        for (const contest of finishedContests) {
            if (processedContests.has(contest.id)) {
                console.log(`[Bot] Skipping ${contest.id.substring(0, 12)}... — already processed.`);
                continue;
            }

            const startTimestamp = parseInt(contest.getMatchingTags('start')[0]?.[1] || '0', 10);
            const endTimestamp = parseInt(contest.getMatchingTags('end')[0]?.[1] || '0', 10);
            const parameter = contest.getMatchingTags('parameter')[0]?.[1] || 'max_distance';
            const feeSats = parseInt(contest.getMatchingTags('fee')[0]?.[1] || '0', 10);
            const dTag = contest.getMatchingTags('d')[0]?.[1];

            // 'title' tag — kind 33401 uses 'title', not 'name'
            const contestName = contest.getMatchingTags('title')[0]?.[1] || 'Community Challenge';

            // Read min_confidence from event tag — organizer sets this, falls back to 0.7
            const minConfidence = parseFloat(contest.getMatchingTags('min_confidence')[0]?.[1] || '0.7');

            // Read payout splits from event tag — falls back to default 50/30/20
            const payoutTag = contest.getMatchingTags('payout')[0];

            console.log(`\n[Bot] Processing: "${contestName}" (${parameter}, ${feeSats} sat fee, min_confidence ${minConfidence})`);

            // ── Participants ──────────────────────────────
            // aTag uses kind 33401
            const rsvps = await fetchWithTimeout(ndk, {
                kinds: [31925],
                '#a': [`33401:${contest.pubkey}:${dTag}`],
                limit: 1000
            }, 30000);

            // Verify payments for each RSVP (async — process one at a time)
            const verifiedRsvps = [];
            for (const r of Array.from(rsvps)) {
                const isAccepted = r.getMatchingTags('l').some(t => t[1] === 'accepted');
                const isInTime = r.created_at <= endTimestamp;
                if (!isAccepted || !isInTime) continue;

                const paymentOk = await verifyContestPayment(contest.id, feeSats, r.created_at);
                if (paymentOk) {
                    verifiedRsvps.push(r);
                } else {
                    console.log(`[Bot]   ⚠️ RSVP from ${r.pubkey.substring(0, 8)} rejected — payment not verified.`);
                }
            }

            const participantPubkeys = verifiedRsvps.map(r => r.pubkey);

            if (participantPubkeys.length === 0) {
                console.log(`[Bot] No participants found for contest "${contestName}" — skipping.`);
                continue;
            }

            console.log(`[Bot] Found ${participantPubkeys.length} participants for "${contestName}": ${participantPubkeys.map(p => p.substring(0, 8)).join(', ')}`);

            // ── Rides ─────────────────────────────────────
            // Add a small buffer after endTimestamp for rides published slightly late
            const RIDE_FETCH_BUFFER = 3600; // 1 hour buffer after contest end
            const rides = await fetchWithTimeout(ndk, {
                kinds: [33301, 1301],
                authors: participantPubkeys,
                since: startTimestamp,
                until: endTimestamp + RIDE_FETCH_BUFFER,
                limit: 5000
            }, 30000);

            // Deduplicate rides by 'd' tag — Bikel dual-publishes every ride as
            // both kind 33301 and kind 1301. Without dedup the same ride scores twice.
            // Prefer kind 33301 if both exist; fall back to event id if no d tag.
            const seenRideKeys = new Map();
            for (const ride of rides) {
                const dTag = ride.getMatchingTags('d')[0]?.[1] || ride.id;
                const existing = seenRideKeys.get(dTag);
                if (!existing || (ride.kind === 33301 && existing.kind !== 33301)) {
                    seenRideKeys.set(dTag, ride);
                }
            }
            const dedupedRides = Array.from(seenRideKeys.values());
            console.log(`[Bot] ${rides.size} ride(s) from ${participantPubkeys.length} participant(s) (${dedupedRides.length} after dedup).`);

            // ── Leaderboard ───────────────────────────────
            const leaderboard = new Map();
            const suffix = parameter === 'max_distance' ? 'mi'
                : parameter === 'max_elevation' ? 'ft'
                    : parameter === 'fastest_mile' ? 'mph'
                        : 'pts';

            for (const ride of dedupedRides) {
                const pubkey = ride.pubkey;

                // Verify ride was created within the contest window
                if (ride.created_at < startTimestamp || ride.created_at > endTimestamp) {
                    console.log(`[Bot]   - Ride ${ride.id.substring(0, 8)} by ${pubkey.substring(0, 8)} rejected: outside contest window (${new Date(ride.created_at * 1000).toISOString()})`);
                    continue;
                }

                const confidence = parseFloat(ride.getMatchingTags('confidence')[0]?.[1] || '0');

                // Use min_confidence from the challenge event, not a hardcoded value
                if (confidence < minConfidence) {
                    console.log(`[Bot]   - Ride ${ride.id.substring(0, 8)} by ${pubkey.substring(0, 8)} rejected: low confidence (${confidence} < ${minConfidence})`);
                    continue;
                }

                const distance = parseFloat(ride.getMatchingTags('distance')[0]?.[1] || '0');
                const elevation = parseFloat(ride.getMatchingTags('elevation')[0]?.[1] || '0');
                // Duration stored as 'HH:MM:SS' string — convert to seconds
                const durationRaw = ride.getMatchingTags('duration')[0]?.[1] || '0';
                let duration = 0;
                if (durationRaw.includes(':')) {
                    const parts = durationRaw.split(':').map(Number);
                    duration = (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
                } else {
                    duration = parseInt(durationRaw, 10) || 0;
                }

                if (parameter === 'max_distance') {
                    leaderboard.set(pubkey, (leaderboard.get(pubkey) || 0) + distance);
                    console.log(`[Bot]   - Ride ${ride.id.substring(0, 8)} by ${pubkey.substring(0, 8)} accepted: ${distance.toFixed(2)} mi`);
                } else if (parameter === 'max_elevation') {
                    leaderboard.set(pubkey, (leaderboard.get(pubkey) || 0) + elevation);
                    console.log(`[Bot]   - Ride ${ride.id.substring(0, 8)} by ${pubkey.substring(0, 8)} accepted: ${elevation.toFixed(0)} ft`);
                } else if (parameter === 'fastest_mile' && distance >= 1) {
                    const pace = distance / (duration / 3600);
                    if (pace > (leaderboard.get(pubkey) || 0)) {
                        leaderboard.set(pubkey, pace);
                        console.log(`[Bot]   - Ride ${ride.id.substring(0, 8)} by ${pubkey.substring(0, 8)} accepted: ${pace.toFixed(2)} mph`);
                    } else {
                        console.log(`[Bot]   - Ride ${ride.id.substring(0, 8)} by ${pubkey.substring(0, 8)} skipped: slower than existing pace (${pace.toFixed(2)} mph)`);
                    }
                } else if (parameter === 'fastest_mile') {
                    console.log(`[Bot]   - Ride ${ride.id.substring(0, 8)} by ${pubkey.substring(0, 8)} rejected: distance too short for fastest mile (${distance.toFixed(2)} mi)`);
                }
            }

            const sortedLeaderboard = Array.from(leaderboard.entries()).sort((a, b) => b[1] - a[1]);
            const topWinners = sortedLeaderboard.slice(0, 3);

            // Use event's payout tag if present, otherwise default splits
            const payoutSplits = getPayoutSplits(topWinners.length, payoutTag);

            console.log(`[Bot] Leaderboard:`, sortedLeaderboard);
            console.log(`[Bot] ${topWinners.length} winner(s) — splits: ${payoutSplits.map(s => (s * 100).toFixed(1) + '%').join(', ')}`);

            // ── Prize pool ────────────────────────────────
            const isSoloContest = participantPubkeys.length === 1 && topWinners.length === 1;
            let totalPrizePoolSats = feeSats > 0 ? participantPubkeys.length * feeSats : 0;
            let platformFeeSats = 0;

            if (isSoloContest && feeSats > 0) {
                console.log(`[Bot] Solo challenge — full refund of ${totalPrizePoolSats} sats. No platform fee taken.`);
            } else if (feeSats > 0) {
                platformFeeSats = Math.ceil(totalPrizePoolSats * PLATFORM_FEE_PCT);
                totalPrizePoolSats = totalPrizePoolSats - platformFeeSats;
                console.log(`[Bot] Pool: ${participantPubkeys.length} × ${feeSats} = ${participantPubkeys.length * feeSats} sats. Keeping ${platformFeeSats} (5%), distributing ${totalPrizePoolSats} sats.`);
            }

            // ── Payouts ───────────────────────────────────
            const nevent = nip19.neventEncode({ id: contest.id, relays: RELAYS });
            const noLud16Winners = [];

            for (let i = 0; i < topWinners.length; i++) {
                const [pubkey, score] = topWinners[i];
                const splitSats = Math.floor(totalPrizePoolSats * payoutSplits[i]);
                if (splitSats <= 0) continue;

                const place = ['🥇', '🥈', '🥉'][i] ?? `#${i + 1}`;
                console.log(`[Bot] ${place} ${pubkey.substring(0, 8)}... score=${score.toFixed(1)} → ${splitSats} sats`);

                const paid = await payoutWinner(ndk, pubkey, splitSats);

                if (!paid) {
                    console.log(`[Bot] No lud16 for ${pubkey.substring(0, 8)} — queuing pending payout.`);
                    noLud16Winners.push({ pubkey, splitSats, score, place });
                }
            }

            // Mark as processed BEFORE publishing notes so re-payout can never happen
            saveProcessedContest(contest.id);
            console.log(`[Bot] Challenge ${contest.id.substring(0, 12)}... marked as processed.`);

            // ── Results note ──────────────────────────────
            if (ndk.signer && topWinners.length > 0) {
                let summaryText = `🏆 Results are in for: ${contestName}!\n\n`;

                for (let i = 0; i < topWinners.length; i++) {
                    const [pubkey, score] = topWinners[i];
                    const npub = nip19.npubEncode(pubkey);
                    const place = ['🥇', '🥈', '🥉'][i] ?? `#${i + 1}`;
                    summaryText += `${place} nostr:${npub} — ${score.toFixed(1)} ${suffix}\n`;
                }

                if (isSoloContest && feeSats > 0) {
                    summaryText += `\nOnly one rider entered — entry fee fully refunded. ♻️\n`;
                } else if (totalPrizePoolSats > 0) {
                    summaryText += `\n⚡ ${totalPrizePoolSats} sats distributed by Bikel Escrow! 🚲\n`;
                }

                if (noLud16Winners.length > 0) {
                    summaryText += `\n⚠️ Some winners couldn't be paid yet — see follow-up notes.\n`;
                }

                summaryText += `\nnostr:${nevent}`;

                await publishNote(ndk, summaryText, [['e', contest.id, RELAYS[0], 'root']]);

                // ── Per-winner lud16 nudge notes ──────────
                for (const { pubkey, splitSats, place } of noLud16Winners) {
                    const npub = nip19.npubEncode(pubkey);

                    const nudgeContent =
                        `${place} nostr:${npub} — you won ${splitSats} sats in "${contestName}"! 🎉\n\n` +
                        `We couldn't send your payout because you don't have a Lightning address set on your Nostr profile.\n\n` +
                        `👉 Add a Lightning address (lud16) to your profile, then reply to this note and we'll send your ${splitSats} sats automatically! ⚡`;

                    const nudgeNote = await publishNote(ndk, nudgeContent, [
                        ['p', pubkey],
                        ['e', contest.id, RELAYS[0], 'mention']
                    ]);

                    if (nudgeNote) {
                        savePendingPayout(nudgeNote.id, { pubkey, splitSats, contestId: contest.id, contestName });
                    }
                }
            }
        }
    } catch (e) {
        console.error('[Bot] Error processing challenges:', e);
    }

    console.log('[Bot] Challenge processing complete.\n');
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────
if (process.argv.includes('--run-now')) {
    processFinishedContests()
        .then(() => {
            console.log('[Bot] Exiting cleanly.');
            process.exit(0);
        })
        .catch(e => {
            console.error('[Bot] Fatal error:', e);
            process.exit(1);
        });
} else {
    console.log(`[Bot] v${BOT_VERSION} starting (Scheduled Cron)...`);
    cron.schedule('0 * * * *', () => {
        console.log(`[Bot] v${BOT_VERSION} Cron Triggered: ${new Date().toISOString()}`);
        processFinishedContests();
    });
    // Run once on startup
    processFinishedContests();
}