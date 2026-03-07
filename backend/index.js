import NDK, { NDKEvent, NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import axios from 'axios';
import cron from 'node-cron';
import dotenv from 'dotenv';
import WebSocket from "ws";
global.WebSocket = WebSocket;

dotenv.config();

const RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol'
];

const COINOS_API_URL = 'https://coinos.io/api';
const COINOS_API_KEY = process.env.COINOS_API_KEY;
const BOT_NSEC = process.env.BOT_NSEC;

// Example split for top 3 (1 = 60%, 2 = 30%, 3 = 10%)
const PAYOUT_SPLITS = [0.50, 0.30, 0.20];

async function initializeNDK() {
    let signer;
    if (BOT_NSEC) {
        signer = new NDKPrivateKeySigner(BOT_NSEC);
        console.log('[Bot] Initialized with NSEC Signer.');
    }
    const ndk = new NDK({ explicitRelayUrls: RELAYS, signer });
    await ndk.connect();
    console.log('[Bot] Connected to Nostr Relays');
    return ndk;
}

// Very basic Coinos API function
async function payLightningInvoice(invoice) {
    if (!COINOS_API_KEY) {
        console.error('[Bot] COINOS_API_KEY missing. Cannot process payout.');
        return false;
    }

    try {
        console.log(`[Bot] Attempting Coinos Payment for Invoice: ${invoice.substring(0, 15)}...`);
        const response = await axios.post(`${COINOS_API_URL}/lightning/send`, {
            payreq: invoice
        }, {
            headers: {
                'Authorization': `Bearer ${COINOS_API_KEY}`
            }
        });
        console.log('[Bot] Payout successful!', response.data);
        return true;
    } catch (error) {
        console.error('[Bot] Payout failed:', error?.response?.data || error.message);
        return false;
    }
}

async function processFinishedContests() {
    console.log('[Bot] Running finished contest aggregator...');

    try {
        const ndk = await initializeNDK();
        const now = Math.floor(Date.now() / 1000);
        const yesterday = now - (24 * 60 * 60);

        // 1. Fetch all Contests that ended in the last 24 hours
        // In a real production system, you'd want to store a DB flag if a contest was "processed"
        // to avoid double payouts. We'll rely on a 24-hr sliding window script run daily here.
        const contestFilter = {
            kinds: [31924],
            "#client": ["bikel"]
        };
        const contestsRaw = await ndk.fetchEvents(contestFilter);

        const finishedContests = Array.from(contestsRaw).filter(c => {
            const end = parseInt(c.getMatchingTags('end')[0]?.[1] || '0', 10);
            return end < now && end > yesterday;
        });

        if (finishedContests.length === 0) {
            console.log('[Bot] No finished contests found in the last 24 hours.');
            return;
        }

        console.log(`[Bot] Found ${finishedContests.length} recently finished contests.`);

        for (const contest of finishedContests) {
            const startTimestamp = parseInt(contest.getMatchingTags('start')[0]?.[1] || '0', 10);
            const endTimestamp = parseInt(contest.getMatchingTags('end')[0]?.[1] || Date.now().toString(), 10);
            const parameter = contest.getMatchingTags('parameter')[0]?.[1] || 'max_distance';
            const feeSats = parseInt(contest.getMatchingTags('fee')[0]?.[1] || '0', 10);
            const dTag = contest.getMatchingTags('d')[0]?.[1];

            console.log(`\n[Bot] Processing contest: ${contest.id} (Param: ${parameter}, Fee: ${feeSats})`);

            // 2. Fetch all RSVPs to this contest
            const rsvpFilter = {
                kinds: [31925],
                "#a": [`31924:${contest.pubkey}:${dTag}`],
                limit: 1000
            };
            const rsvps = await ndk.fetchEvents(rsvpFilter);
            const participantPubkeys = Array.from(rsvps).map(r => r.pubkey);

            if (participantPubkeys.length === 0) {
                console.log('[Bot] No participants found for this contest. Skipping...');
                continue;
            }

            // 3. Fetch all Rides for those participants within the time window
            const ridesFilter = {
                kinds: [33301],
                authors: participantPubkeys,
                since: startTimestamp,
                until: endTimestamp,
                limit: 5000
            };

            const rides = await ndk.fetchEvents(ridesFilter);
            console.log(`[Bot] Fetched ${rides.size} total rides from participants.`);

            // 4 & 5. Filter rides by confidence > 0.85 and calculate leaderboard dynamically
            const leaderboard = new Map(); // pubkey -> max score

            for (const ride of rides) {
                const confidenceStr = ride.getMatchingTags('confidence')[0]?.[1] || '0';
                const confidence = parseFloat(confidenceStr);

                if (confidence >= 0.85) {
                    const distanceStr = ride.getMatchingTags('distance')[0]?.[1] || '0';
                    const distance = parseFloat(distanceStr);
                    const durationStr = ride.getMatchingTags('duration')[0]?.[1] || '0';
                    const duration = parseInt(durationStr, 10);

                    const pubkey = ride.pubkey;

                    if (parameter === 'max_distance' || parameter === 'max_elevation') {
                        const currentTotal = leaderboard.get(pubkey) || 0;
                        leaderboard.set(pubkey, currentTotal + distance);
                    } else if (parameter === 'fastest_mile') {
                        if (distance >= 1) { // must ride at least 1 mile
                            const pace = distance / (duration / 3600); // mph
                            const currentBest = leaderboard.get(pubkey) || 0;
                            if (pace > currentBest) {
                                leaderboard.set(pubkey, pace);
                            }
                        }
                    }
                }
            }

            // Sort leaderboard descending
            const sortedLeaderboard = Array.from(leaderboard.entries()).sort((a, b) => b[1] - a[1]);
            console.log(`[Bot] Final Leaderboard for ${contest.id}:`, sortedLeaderboard);

            // 6, 7, 8. Payout logic
            const top3 = sortedLeaderboard.slice(0, 3);

            // Dynamic Prize Pool based on entries
            // If fee is 0, let's substitute a 1000 sat sponsor pool for now if we want, or just be 0.
            let totalPrizePoolSats = feeSats > 0 ? (participantPubkeys.length * feeSats) : 0;

            // Assume the platform takes a 5% cut of community contests as escrow fee, the rest goes to pot
            if (feeSats > 0) {
                totalPrizePoolSats = Math.floor(totalPrizePoolSats * 0.95);
                console.log(`[Bot] Dynamic Prize Pool calculation: ${participantPubkeys.length} entries * ${feeSats} sats - 5% fee = ${totalPrizePoolSats} sats pot.`);
            }

            for (let i = 0; i < top3.length; i++) {
                const [pubkey, score] = top3[i];
                const splitSats = Math.floor(totalPrizePoolSats * PAYOUT_SPLITS[i]);
                if (splitSats <= 0) continue;

                const splitMsats = splitSats * 1000;

                console.log(`[Bot] Winner #${i + 1}: ${pubkey} (Score: ${score.toFixed(1)}) -> ${splitSats} sats`);

                // 6. Fetch Lightning Address (lud16) from Winner's Kind 0 Profile
                const userObj = ndk.getUser({ pubkey });
                const profile = await userObj.fetchProfile();
                const lud16 = profile?.lud16;

                if (!lud16 || !lud16.includes('@')) {
                    console.log(`[Bot] Skipping payout for ${pubkey.substring(0, 8)} - No valid Lightning Address (lud16) found.`);
                    continue; // In a robust app, we should retry or dm them to set lud16
                }

                // 7. Request Invoice via LNURL-Pay spec
                const [user, domain] = lud16.split('@');
                const lnurlpUrl = `https://${domain}/.well-known/lnurlp/${user}`;

                try {
                    const lnurlpRes = await axios.get(lnurlpUrl);
                    const callback = lnurlpRes.data.callback;

                    if (callback) {
                        // Fetch the bolt11 invoice
                        const invoiceRes = await axios.get(`${callback}?amount=${splitMsats}`);
                        const pr = invoiceRes.data.pr;

                        if (pr) {
                            // 8. Execute payout via Coinos
                            await payLightningInvoice(pr);
                        }
                    }
                } catch (err) {
                    console.error(`[Bot] Failed to get invoice for ${lud16}:`, err.message || err);
                }
            }

            // 9. Publish Contest Results Note
            if (ndk.signer && sortedLeaderboard.length > 0) {
                console.log(`[Bot] Publishing contest results note for ${contest.id}...`);

                const contestName = contest.getMatchingTags('name')[0]?.[1] || "Community Contest";
                let summaryText = `🏆 Results are in for: ${contestName}! \n\n`;

                const suffix = parameter.includes('distance') ? 'mi' : (parameter === 'fastest_mile' ? 'mph' : 'pts');

                for (let i = 0; i < Math.min(top3.length, 3); i++) {
                    const [pubkey, score] = top3[i];
                    const npub = ndk.getUser({ pubkey }).npub;
                    summaryText += `#${i + 1}: nostr:${npub} - ${score.toFixed(1)} ${suffix}\n`;
                }

                if (totalPrizePoolSats > 0) {
                    summaryText += `\nA total prize pot of ${totalPrizePoolSats} sats has been distributed automatically by Bikel Escrow! ⚡\n`;
                }

                summaryText += `\nnostr:${contest.id}`;

                const note = new NDKEvent(ndk);
                note.kind = 1;
                note.content = summaryText;
                note.tags = [
                    ['client', 'bikel'],
                    ['e', contest.id, '', 'root'],
                    ['t', 'bikel'],
                    ['t', 'cycling']
                ];

                try {
                    await note.publish();
                    console.log(`[Bot] Successfully published results note: ${note.id}`);
                } catch (err) {
                    console.error('[Bot] Failed to publish results note:', err);
                }
            }
        }
    } catch (e) {
        console.error('[Bot] Error processing contests:', e);
    }

    console.log('[Bot] Contest processing complete.\n');
}

// Run the script immediately for testing if called directly
if (process.argv.includes('--run-now')) {
    processFinishedContests()
        .then(() => {
            console.log('[Bot] Exiting cleanly after one-off execution.');
            process.exit(0);
        })
        .catch(e => {
            console.error('[Bot] Fatal execution error:', e);
            process.exit(1);
        });
} else {
    // Schedule to run every hour to check for finished contests
    console.log('[Bot] Scheduled cron job for contest payouts. Waiting for trigger...');
    cron.schedule('0 * * * *', processFinishedContests);
}
