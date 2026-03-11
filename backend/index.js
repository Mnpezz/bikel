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
            new Promise((_, reject) => setTimeout(() => reject(new Error('NDK Connect Timeout')), 10000))
        ]);
        console.log('[Bot] Connected to Nostr relays.');
    } catch (e) {
        console.warn('[Bot] Some relays timed out, proceeding with available:', e.message);
    }
    return ndk;
}

// Subscription-based fetch with timeout to avoid infinite hangs on slow relays
async function fetchWithTimeout(ndk, filter, timeoutMs = 10000) {
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
                if (isGracePeriod) console.log(`[Bot]   - "${title}" (${c.id.substring(0, 8)}): Waiting for 1h grace period (ends ${new Date((end + GRACE_PERIOD) * 1000).toISOString()})`);
                else if (isTooOld) console.log(`[Bot]   - "${title}" (${c.id.substring(0, 8)}): Too old to process (ended ${new Date(end * 1000).toISOString()})`);
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
            }, 10000);

            const participantPubkeys = Array.from(rsvps)
                .filter(r => r.created_at <= endTimestamp)
                .map(r => r.pubkey);

            if (participantPubkeys.length === 0) {
                console.log(`[Bot] No participants found for contest "${contestName}" — skipping.`);
                continue;
            }

            console.log(`[Bot] Found ${participantPubkeys.length} participants for "${contestName}": ${participantPubkeys.map(p => p.substring(0, 8)).join(', ')}`);

            // ── Rides ─────────────────────────────────────
            const rides = await fetchWithTimeout(ndk, {
                kinds: [33301],
                authors: participantPubkeys,
                since: startTimestamp,
                // We remove 'until' here to catch rides published after the endTimestamp 
                // but that happened during the window (checked by created_at).
                // Since the bot now runs with a GRACE_PERIOD, this is safer.
                limit: 5000
            }, 30000); // Increased to 30s for relay lag

            console.log(`[Bot] ${rides.size} ride(s) from ${participantPubkeys.length} participant(s).`);

            // ── Leaderboard ───────────────────────────────
            const leaderboard = new Map();
            const suffix = parameter.includes('distance') ? 'mi'
                : parameter === 'fastest_mile' ? 'mph'
                    : 'pts';

            for (const ride of rides) {
                const confidence = parseFloat(ride.getMatchingTags('confidence')[0]?.[1] || '0');
                const pubkey = ride.pubkey;

                // Use min_confidence from the challenge event, not a hardcoded value
                if (confidence < minConfidence) {
                    console.log(`[Bot]   - Ride ${ride.id.substring(0, 8)} by ${pubkey.substring(0, 8)} rejected: low confidence (${confidence} < ${minConfidence})`);
                    continue;
                }

                const distance = parseFloat(ride.getMatchingTags('distance')[0]?.[1] || '0');
                const duration = parseInt(ride.getMatchingTags('duration')[0]?.[1] || '0', 10);

                if (parameter === 'max_distance' || parameter === 'max_elevation') {
                    leaderboard.set(pubkey, (leaderboard.get(pubkey) || 0) + distance);
                    console.log(`[Bot]   - Ride ${ride.id.substring(0, 8)} by ${pubkey.substring(0, 8)} accepted: ${distance.toFixed(2)} ${suffix}`);
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
            if (ndk.signer) {
                let summaryText = `🏆 Results are in for: ${contestName}!\n\n`;

                if (topWinners.length === 0) {
                    summaryText += `No valid rides were recorded for this challenge.\n`;
                } else {
                    for (let i = 0; i < topWinners.length; i++) {
                        const [pubkey, score] = topWinners[i];
                        const npub = nip19.npubEncode(pubkey);
                        const place = ['🥇', '🥈', '🥉'][i] ?? `#${i + 1}`;
                        summaryText += `${place} nostr:${npub} — ${score.toFixed(1)} ${suffix}\n`;
                    }
                }

                if (isSoloContest && feeSats > 0) {
                    summaryText += `\nOnly one rider entered — entry fee fully refunded. ♻️\n`;
                } else if (totalPrizePoolSats > 0) {
                    summaryText += `\n⚡ ${totalPrizePoolSats} sats distributed by Bikel Escrow!\n`;
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