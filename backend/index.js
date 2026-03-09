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

// Base splits for up to 3 winners — renormalized dynamically for fewer entrants.
//   1 winner  → [1.0]            (100%)
//   2 winners → [0.625, 0.375]   (62.5% / 37.5%)
//   3 winners → [0.50, 0.30, 0.20]
const PAYOUT_SPLITS_BASE = [0.50, 0.30, 0.20];

function getPayoutSplits(winnerCount) {
    if (winnerCount <= 0) return [];
    const count = Math.min(winnerCount, PAYOUT_SPLITS_BASE.length);
    const raw = PAYOUT_SPLITS_BASE.slice(0, count);
    const total = raw.reduce((a, b) => a + b, 0);
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
// Keyed by the public "set your lud16" note ID so the reply listener can look them up.
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
// Returns true on success, false on any failure
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
// Runs as a persistent subscription for the lifetime of the process
// ─────────────────────────────────────────────
async function startReplyListener(ndk) {
    const pending = loadPendingPayouts();
    const noteIds = Object.keys(pending);

    if (noteIds.length === 0) {
        console.log('[Bot] No pending payouts — reply listener not needed.');
        return;
    }

    console.log(`[Bot] Listening for replies on ${noteIds.length} pending payout note(s)...`);

    // closeOnEose: false keeps the subscription alive to catch future replies
    const sub = ndk.subscribe({ kinds: [1], '#e': noteIds }, { closeOnEose: false });

    sub.on('event', async (reply) => {
        // Find which pending nudge note this reply tags
        const referencedNoteId = reply.tags
            .find(t => t[0] === 'e' && noteIds.includes(t[1]))?.[1];
        if (!referencedNoteId) return;

        const payout = pending[referencedNoteId];
        if (!payout) return;

        // Only the winner themselves can trigger the retry
        if (reply.pubkey !== payout.pubkey) return;

        console.log(`[Bot] Winner ${payout.pubkey.substring(0, 8)} replied — retrying ${payout.splitSats} sat payout...`);

        const success = await payoutWinner(ndk, payout.pubkey, payout.splitSats);

        if (success) {
            removePendingPayout(referencedNoteId);
            delete pending[referencedNoteId]; // update in-memory copy too

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
// Upcoming contest announcements
// Posts a hype note for contests starting within the next hour
// ─────────────────────────────────────────────
async function announceUpcomingContests(ndk) {
    console.log('[Bot] Checking for contests starting soon...');

    const now = Math.floor(Date.now() / 1000);
    const oneHour = 60 * 60;
    const contestsRaw = await fetchWithTimeout(ndk, { kinds: [31924], '#t': ['bikel'] }, 15000);

    const startingSoon = Array.from(contestsRaw).filter(c => {
        const start = parseInt(c.getMatchingTags('start')[0]?.[1] || '0', 10);
        return start > now && start <= now + oneHour;
    });

    if (startingSoon.length === 0) {
        console.log('[Bot] No contests starting in the next hour.');
        return;
    }

    for (const contest of startingSoon) {
        const name = contest.getMatchingTags('name')[0]?.[1] || 'Community Contest';
        const parameter = contest.getMatchingTags('parameter')[0]?.[1] || 'max_distance';
        const feeSats = contest.getMatchingTags('fee')[0]?.[1] || '0';
        const nevent = nip19.neventEncode({ id: contest.id, relays: RELAYS });

        const paramLabel = parameter === 'max_distance' ? 'most miles'
            : parameter === 'max_elevation' ? 'most elevation'
                : parameter === 'fastest_mile' ? 'fastest mile'
                    : parameter;

        const feeText = parseInt(feeSats) > 0
            ? `Entry: ${feeSats} sats. Top riders split the prize pool! ⚡`
            : `This contest is free to enter!`;

        const content =
            `🚴 A Bikel contest is starting soon!\n\n` +
            `📋 ${name}\n` +
            `🏆 Metric: ${paramLabel}\n` +
            `${feeText}\n\n` +
            `Join now and get your legs ready 👇\n` +
            `nostr:${nevent}`;

        await publishNote(ndk, content, [['e', contest.id, RELAYS[0], 'mention']]);
        console.log(`[Bot] Announced upcoming contest: "${name}"`);
    }
}

// ─────────────────────────────────────────────
// Main — process finished contests
// ─────────────────────────────────────────────
async function processFinishedContests() {
    console.log('[Bot] Running finished contest aggregator...');

    const processedContests = loadProcessedContests();
    console.log(`[Bot] ${processedContests.size} contest(s) already processed (will skip).`);

    try {
        const ndk = await initializeNDK();
        const now = Math.floor(Date.now() / 1000);
        const yesterday = now - (24 * 60 * 60);

        // Announce upcoming contests and start reply listener each run
        await announceUpcomingContests(ndk);
        await startReplyListener(ndk);

        const contestsRaw = await fetchWithTimeout(ndk, { kinds: [31924], '#t': ['bikel'] }, 15000);

        const finishedContests = Array.from(contestsRaw).filter(c => {
            const end = parseInt(c.getMatchingTags('end')[0]?.[1] || '0', 10);
            return end < now && end > yesterday;
        });

        if (finishedContests.length === 0) {
            console.log('[Bot] No finished contests in the last 24 hours.');
            return;
        }

        console.log(`[Bot] Found ${finishedContests.length} finished contest(s).`);

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
            const contestName = contest.getMatchingTags('name')[0]?.[1] || 'Community Contest';

            console.log(`\n[Bot] Processing: "${contestName}" (${parameter}, ${feeSats} sat fee)`);

            // ── Participants ──────────────────────────────
            const rsvps = await fetchWithTimeout(ndk, {
                kinds: [31925],
                '#a': [`31924:${contest.pubkey}:${dTag}`],
                limit: 1000
            }, 10000);

            const participantPubkeys = Array.from(rsvps).map(r => r.pubkey);

            if (participantPubkeys.length === 0) {
                console.log('[Bot] No participants — skipping.');
                continue;
            }

            // ── Rides ─────────────────────────────────────
            const rides = await fetchWithTimeout(ndk, {
                kinds: [33301],
                authors: participantPubkeys,
                since: startTimestamp,
                until: endTimestamp,
                limit: 5000
            }, 15000);

            console.log(`[Bot] ${rides.size} ride(s) from ${participantPubkeys.length} participant(s).`);

            // ── Leaderboard ───────────────────────────────
            const leaderboard = new Map();

            for (const ride of rides) {
                const confidence = parseFloat(ride.getMatchingTags('confidence')[0]?.[1] || '0');
                if (confidence < 0.85) continue;

                const distance = parseFloat(ride.getMatchingTags('distance')[0]?.[1] || '0');
                const duration = parseInt(ride.getMatchingTags('duration')[0]?.[1] || '0', 10);
                const pubkey = ride.pubkey;

                if (parameter === 'max_distance' || parameter === 'max_elevation') {
                    leaderboard.set(pubkey, (leaderboard.get(pubkey) || 0) + distance);
                } else if (parameter === 'fastest_mile' && distance >= 1) {
                    const pace = distance / (duration / 3600);
                    if (pace > (leaderboard.get(pubkey) || 0)) leaderboard.set(pubkey, pace);
                }
            }

            const sortedLeaderboard = Array.from(leaderboard.entries()).sort((a, b) => b[1] - a[1]);
            const topWinners = sortedLeaderboard.slice(0, 3);
            const payoutSplits = getPayoutSplits(topWinners.length);

            console.log(`[Bot] Leaderboard:`, sortedLeaderboard);
            console.log(`[Bot] ${topWinners.length} winner(s) — splits: ${payoutSplits.map(s => (s * 100).toFixed(1) + '%').join(', ')}`);

            // ── Prize pool ────────────────────────────────
            // Solo contest (1 entrant, 1 rider) = full refund, no platform fee
            const isSoloContest = participantPubkeys.length === 1 && topWinners.length === 1;
            let totalPrizePoolSats = feeSats > 0 ? participantPubkeys.length * feeSats : 0;
            let platformFeeSats = 0;

            if (isSoloContest && feeSats > 0) {
                console.log(`[Bot] Solo contest — full refund of ${totalPrizePoolSats} sats. No platform fee taken.`);
            } else if (feeSats > 0) {
                platformFeeSats = Math.ceil(totalPrizePoolSats * PLATFORM_FEE_PCT);
                totalPrizePoolSats = totalPrizePoolSats - platformFeeSats;
                console.log(`[Bot] Pool: ${participantPubkeys.length} × ${feeSats} = ${participantPubkeys.length * feeSats} sats. Keeping ${platformFeeSats} (5%), distributing ${totalPrizePoolSats} sats.`);
            }

            // ── Payouts ───────────────────────────────────
            const suffix = parameter.includes('distance') ? 'mi'
                : parameter === 'fastest_mile' ? 'mph'
                    : 'pts';
            const nevent = nip19.neventEncode({ id: contest.id, relays: RELAYS });
            const noLud16Winners = []; // winners who need a lud16 nudge

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
            console.log(`[Bot] Contest ${contest.id.substring(0, 12)}... marked as processed.`);

            // ── Results note ──────────────────────────────
            if (ndk.signer) {
                let summaryText = `🏆 Results are in for: ${contestName}!\n\n`;

                if (topWinners.length === 0) {
                    summaryText += `No valid rides were recorded for this contest.\n`;
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

                // ── Per-winner lud16 nudge notes + DMs ────
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

                    // Save pending payout keyed by nudge note ID for the reply listener
                    if (nudgeNote) {
                        savePendingPayout(nudgeNote.id, { pubkey, splitSats, contestId: contest.id, contestName });
                    }
                }
            }
        }
    } catch (e) {
        console.error('[Bot] Error processing contests:', e);
    }

    console.log('[Bot] Contest processing complete.\n');
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
    console.log('[Bot] Scheduled cron — running every hour.');
    cron.schedule('0 * * * *', processFinishedContests);
}