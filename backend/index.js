import NDK, { NDKEvent, NDKPrivateKeySigner } from '@nostr-dev-kit/ndk';
import { nip19 } from 'nostr-tools';
import axios from 'axios';
import cron from 'node-cron';
import dotenv from 'dotenv';
import WebSocket from "ws";
import fs from 'fs';
import { createWalletProvider } from './wallet.mjs';
global.WebSocket = WebSocket;

dotenv.config();

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const WALLET_PROVIDER = process.env.WALLET_PROVIDER || 'coinos';
const ENABLE_NUTZAPS = process.env.ENABLE_NUTZAPS === 'true';

let primaryWallet; // Main treasury (Lightning or eCash)
let nutzapWallet;  // Dedicated eCash pocket for NIP-61
let nutzapMonitor; // Autonomous eCash collector

const RELAYS = [
    'ws://127.0.0.1:7777', // Local bikel.ink relay (internal strfry)
    'wss://relay.bikel.ink', // External bikel.ink
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol',
    'wss://relay.snort.social',
    'wss://purplepag.es'
];

const BOT_NSEC = process.env.BOT_NSEC;
const TREASURY_LUD16 = process.env.TREASURY_LUD16; // e.g. "bikel@coinos.io"
const PLATFORM_FEE_PCT = 0.05; // 5% markup for platform
const BOT_VERSION = '1.1.1';

// Default splits for up to 3 winners — used only when the challenge event has no 'payout' tag.
// The event's 'payout' tag always takes precedence so organizers can customize splits.
//   1 winner  → [1.0]            (100%)
//   2 winners → [0.625, 0.375]   (62.5% / 37.5%)
//   3 winners → [0.50, 0.30, 0.20]
const PAYOUT_SPLITS_BASE = [0.50, 0.30, 0.20];
const ANNOUNCEMENTS_FILE = './processed_announcements.json';
const LOCK_FILE = './bot.lock';

/**
 * Calculates the Haversine distance between two coordinates in meters.
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180;
    const dl = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
        Math.cos(p1) * Math.cos(p2) *
        Math.sin(dl / 2) * Math.sin(dl / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

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
const CHECKPOINT_PAYOUTS_FILE = './checkpoint_payouts.json';

function loadCheckpointPayouts() {
    try {
        if (fs.existsSync(CHECKPOINT_PAYOUTS_FILE))
            return JSON.parse(fs.readFileSync(CHECKPOINT_PAYOUTS_FILE, 'utf8'));
    } catch (e) {
        console.warn('[Bot] Could not read checkpoint payouts file:', e.message);
    }
    return {};
}

function loadAnnouncements() {
    try {
        if (fs.existsSync(ANNOUNCEMENTS_FILE))
            return new Set(JSON.parse(fs.readFileSync(ANNOUNCEMENTS_FILE, 'utf8')));
    } catch (e) {
        console.warn('[Bot] Could not read announcements file:', e.message);
    }
    return new Set();
}

function saveAnnouncement(id) {
    const s = loadAnnouncements();
    s.add(id);
    fs.writeFileSync(ANNOUNCEMENTS_FILE, JSON.stringify(Array.from(s)));
}

async function announceBot(ndk) {
    try {
        const botUser = await ndk.signer?.user();
        if (!botUser) return;

        console.log('[Bot] Publishing decentralized announcement (Kind 33400)...');
        const event = new NDKEvent(ndk);
        event.kind = 33400; // Bikel Bot Announcement Kind
        event.content = "Official Bikel Sponsorship & Contest Bot";
        event.tags = [
            ['d', `bikel-bot-${botUser.pubkey.substring(0, 8)}`],
            ['t', 'bikel-bot'],
            ['name', 'Bikel'],
            ['description', 'Automated sponsorship and contest payouts for the Bikel community.'],
            ['image', 'https://bikel.ink/bikel_logo.png'], // Default fallback
            ['version', BOT_VERSION],
            ['fee', (PLATFORM_FEE_PCT * 100).toString()]
        ];

        // Add expiration tag for liveness (2 hours from now)
        const expiration = Math.floor(Date.now() / 1000) + (2 * 60 * 60);
        event.tags.push(['expiration', expiration.toString()]);

        await event.publish();
        console.log('[Bot] Announcement published successfully.');
    } catch (e) {
        console.warn('[Bot] Failed to publish announcement:', e.message);
    }
}

async function publishRelayList(ndk) {
    try {
        const botUser = await ndk.signer?.user();
        if (!botUser) return;

        console.log('[Bot] Publishing Relay List (NIP-65 / Kind 10002)...');
        const event = new NDKEvent(ndk);
        event.kind = 10002;
        event.tags = RELAYS.map(r => ['r', r]);
        await event.publish();
        console.log('[Bot] Relay list published successfully.');
    } catch (e) {
        console.warn('[Bot] Failed to publish relay list:', e.message);
    }
}

function saveCheckpointPayout(cpId, winnerPubkey, timestamp, amount, rideId) {
    const existing = loadCheckpointPayouts();
    if (!existing[cpId]) existing[cpId] = {};
    if (!existing[cpId][winnerPubkey]) existing[cpId][winnerPubkey] = [];
    existing[cpId][winnerPubkey].push({ ts: timestamp, amount: amount, rideId: rideId });
    fs.writeFileSync(CHECKPOINT_PAYOUTS_FILE, JSON.stringify(existing, null, 2));
}

/**
 * Real-time listener for Kind 1301 and 33301 events.
 */
async function startRideSubscriber(ndk) {
    console.log('[Bot] Starting real-time ride subscriber...');
    const now = Math.floor(Date.now() / 1000);
    const sub = ndk.subscribe(
        { kinds: [1301, 33301], since: now },
        { closeOnEose: false }
    );

    sub.on('event', async (event) => {
        try {
            // Filter for Bikel-specific events
            const isBikel = event.getMatchingTags('t').some(t => t[1] === 'bikel') ||
                event.getMatchingTags('client').some(c => c[1] === 'bikel');

            if (!isBikel) return;

            console.log(`[Bot] ⚡ Real-time ride detected: ${event.id.substring(0, 8)} by ${event.pubkey.substring(0, 8)}`);

            // Wait a few seconds for propagation/RSVPs if needed, but usually we can process immediately
            setTimeout(async () => {
                await processSingleRide(ndk, event);
            }, 5000);

        } catch (e) {
            console.error('[Bot] Error in ride subscriber:', e.message);
        }
    });

    console.log('[Bot] Subscription active for Bikel rides.');
}

async function processSingleRide(ndk, ride) {
    try {
        console.log(`[Bot] 🔍 Processing ride ${ride.id.substring(0, 8)} by ${ride.pubkey.substring(0, 8)}...`);

        // 1. Get active checkpoints (with 5-minute cache)
        const now = Math.floor(Date.now() / 1000);
        if (now - ndk.activeCheckpointsCache.lastFetch > 300) {
            console.log('[Bot] Refreshing active checkpoints cache...');

            // Optimization: Filter by #bot tag to only get checkpoints we are tracking
            const botUser = await ndk.signer?.user();
            const myPubkey = botUser?.pubkey;

            // Tiered fetch: Fast 24h scan first, then deeper 30d scan
            console.log(`[Bot] Subscription Cache Refresh - Tier 1: Scanning last 24h...`);
            const cpRecent = await fetchWithTimeout(ndk, { kinds: [33402], since: now - 86400 }, 10000);

            console.log(`[Bot] Subscription Cache Refresh - Tier 2: Scanning last 30d background...`);
            const cpHistory = await fetchWithTimeout(ndk, { kinds: [33402], since: now - (30 * 86400) }, 15000);

            // Dedupe by ID (different relays/tiers might return different event instances)
            const uniqueCPs = new Map();
            [...Array.from(cpRecent), ...Array.from(cpHistory)].forEach(c => uniqueCPs.set(c.id, c));

            ndk.activeCheckpointsCache.data = Array.from(uniqueCPs.values()).filter(c => {
                const end = parseInt(c.getMatchingTags('end')[0]?.[1] || '0', 10);
                return end > now;
            }).map(cp => {
                const loc = cp.getMatchingTags('location')[0]?.[1] || '';
                const [lat, lng] = loc.split(',').map(Number);
                return {
                    event: cp, id: cp.id, lat, lng,
                    reward: parseInt(cp.getMatchingTags('reward')[0]?.[1] || '0', 10),
                    radius: parseInt(cp.getMatchingTags('radius')[0]?.[1] || '20', 10),
                    title: cp.getMatchingTags('title')[0]?.[1] || 'POI Checkpoint',
                    frequency: cp.getMatchingTags('frequency')[0]?.[1] || 'daily',
                    limit: parseInt(cp.getMatchingTags('limit')[0]?.[1] || '100', 10),
                    bot: cp.getMatchingTags('bot')[0]?.[1],
                    set: cp.getMatchingTags('set')[0]?.[1],
                    route_id: cp.getMatchingTags('route_id')[0]?.[1],
                    route_index: parseInt(cp.getMatchingTags('route_index')[0]?.[1] || '-1', 10),
                    rsvp_required: cp.getMatchingTags('rsvp')[0]?.[1] === 'required',
                    streak_reward: parseInt(cp.getMatchingTags('streak_reward')[0]?.[1] || '0', 10)
                };
            }).filter(cp => !isNaN(cp.lat) && !isNaN(cp.lng) && cp.reward > 0);
            ndk.activeCheckpointsCache.lastFetch = now;
        }

        const activeCheckpoints = [...ndk.activeCheckpointsCache.data];

        // 1.1 FAST-PASS: If ride has an explicit hit tag for a checkpoint NOT in our cache, fetch it specifically
        const explicitHitId = ride.getMatchingTags('checkpoint_hit')[0]?.[1];
        if (explicitHitId && !activeCheckpoints.find(cp => cp.id === explicitHitId)) {
            console.log(`[Bot] ⚡ FAST-PASS: Fetching missing checkpoint ${explicitHitId.substring(0, 8)} by ID...`);
            const fastPassRaw = await fetchWithTimeout(ndk, { ids: [explicitHitId] }, 10000);
            const fastPassCP = Array.from(fastPassRaw).map(cp => {
                const loc = cp.getMatchingTags('location')[0]?.[1] || '';
                const [lat, lng] = loc.split(',').map(Number);
                return {
                    event: cp, id: cp.id, lat, lng,
                    reward: parseInt(cp.getMatchingTags('reward')[0]?.[1] || '0', 10),
                    radius: parseInt(cp.getMatchingTags('radius')[0]?.[1] || '20', 10),
                    title: cp.getMatchingTags('title')[0]?.[1] || 'POI Checkpoint (Fast-Pass)',
                    frequency: cp.getMatchingTags('frequency')[0]?.[1] || 'daily',
                    limit: parseInt(cp.getMatchingTags('limit')[0]?.[1] || '100', 10),
                    bot: cp.getMatchingTags('bot')[0]?.[1],
                    set: cp.getMatchingTags('set')[0]?.[1],
                    route_id: cp.getMatchingTags('route_id')[0]?.[1],
                    route_index: parseInt(cp.getMatchingTags('route_index')[0]?.[1] || '-1', 10),
                    rsvp_required: cp.getMatchingTags('rsvp')[0]?.[1] === 'required',
                    streak_reward: parseInt(cp.getMatchingTags('streak_reward')[0]?.[1] || '0', 10)
                };
            }).filter(cp => !isNaN(cp.lat) && !isNaN(cp.lng) && cp.reward > 0)[0];

            if (fastPassCP) {
                console.log(`[Bot] ⚡ FAST-PASS: Successfully retrieved "${fastPassCP.title}".`);
                activeCheckpoints.push(fastPassCP);
            } else {
                console.log(`[Bot] ⚡ FAST-PASS: Could not find checkpoint ${explicitHitId.substring(0, 8)} on relays.`);
            }
        }

        if (activeCheckpoints.length === 0) return;

        // 2. Fetch RSVPs for this specific user
        const userRsvps = await fetchWithTimeout(ndk, {
            kinds: [31925],
            authors: [ride.pubkey],
            '#t': ['bikel-rsvp']
        }, 10000);

        const joinedSet = new Set();
        for (const rsvp of userRsvps) {
            rsvp.tags.forEach(t => {
                if ((t[0] === 'a' || t[0] === 'e') && t[1]) joinedSet.add(t[1]);
            });
        }

        // 3. Detect hits
        const allHistory = loadCheckpointPayouts();
        const hitsThisRide = [];

        for (const cp of activeCheckpoints) {
            const userHistory = (allHistory[cp.id] || {})[ride.pubkey] || [];

            // Deduplication
            if (userHistory.find(h => h.rideId === ride.id)) continue;

            // RSVP Check
            if (cp.rsvp_required) {
                const cpCoordinate = `33402:${cp.event.pubkey}:${cp.event.getMatchingTags('d')[0]?.[1]}`;
                const hasRsvp = joinedSet.has(cpCoordinate) || joinedSet.has(cp.id);
                if (!hasRsvp) continue;
            }

            // Hit Logic
            let hitIdx = -1;
            const explicitHitId = ride.getMatchingTags('checkpoint_hit')[0]?.[1];
            if (explicitHitId && (explicitHitId === cp.id || cp.id.startsWith(explicitHitId))) {
                console.log(`[Bot]   -> 🎯 Fast-Pass Hit! (${cp.title})`);
                hitIdx = 0;
            } else {
                const routeTag = ride.getMatchingTags('route')[0]?.[1];
                let coords = [];
                try {
                    const parsed = JSON.parse(routeTag);
                    coords = Array.isArray(parsed) ? parsed : (parsed.route || []);
                } catch (e) { }

                for (let i = 0; i < coords.length; i++) {
                    const p = coords[i];
                    const lat = Number(p.lat ?? p[0]);
                    const lng = Number(p.lng ?? p[1]);
                    if (calculateDistance(cp.lat, cp.lng, lat, lng) <= cp.radius) {
                        hitIdx = i; break;
                    }
                }
            }

            if (hitIdx !== -1) {
                // Frequeny Check
                if (cp.frequency === 'once' && userHistory.length > 0) continue;
                if (cp.frequency === 'daily' && userHistory.find(h => h.ts > now - 86400)) continue;

                // PAY!
                console.log(`[Bot] 💰 Payout triggered for ${cp.title} (+${cp.reward} sats)`);
                const paid = await payoutWinner(ndk, ride.pubkey, cp.reward, cp.id);
                if (paid) {
                    saveCheckpointPayout(cp.id, ride.pubkey, now, cp.reward, ride.id);
                    await publishNote(ndk, `🎯 Checkpoint Reached!\nnostr:${nip19.npubEncode(ride.pubkey)} visited "${cp.title}" and earned ${cp.reward} sats! ⚡🚲`, [
                        ['e', cp.id, RELAYS[0], 'mention'],
                        ['e', ride.id, RELAYS[0], 'mention'],
                        ['p', ride.pubkey],
                        ['t', 'bikel_reward'],
                        ['amount', (cp.reward * 1000).toString()]
                    ]);
                }
            }
        }

    } catch (e) {
        console.error('[Bot] Error processing single ride:', e.message);
    }
}

const SET_PAYOUTS_FILE = './set_payouts.json';

function loadSetPayouts() {
    try {
        if (fs.existsSync(SET_PAYOUTS_FILE))
            return JSON.parse(fs.readFileSync(SET_PAYOUTS_FILE, 'utf8'));
    } catch (e) {
        console.warn('[Bot] Could not read set payouts file:', e.message);
    }
    return {};
}

function saveSetPayout(setName, pubkey) {
    const existing = loadSetPayouts();
    if (!existing[setName]) existing[setName] = {};
    existing[setName][pubkey] = Math.floor(Date.now() / 1000);
    fs.writeFileSync(SET_PAYOUTS_FILE, JSON.stringify(existing, null, 2));
}

// Global singleton to prevent double-connections
if (typeof global.sharedNDK === 'undefined') {
    global.sharedNDK = null;
}

// ─────────────────────────────────────────────
// NDK
// ─────────────────────────────────────────────
async function initializeNDK() {
    if (global.sharedNDK) return global.sharedNDK;

    let signer;
    if (BOT_NSEC) {
        signer = new NDKPrivateKeySigner(BOT_NSEC);
        console.log('[Bot] Initialized with NSEC Signer.');
    }
    const ndk = new NDK({ explicitRelayUrls: RELAYS, signer });

    // 1. Initialize Primary Wallet (Main Pocket)
    primaryWallet = createWalletProvider({
        provider: WALLET_PROVIDER,
        apiKey: WALLET_PROVIDER === 'lnbits' ? process.env.LNBITS_API_KEY : process.env.COINOS_API_KEY,
        apiUrl: WALLET_PROVIDER === 'lnbits' ? process.env.LNBITS_URL : process.env.COINOS_API_URL,
        mintUrl: process.env.CASHU_MINT_URL
    }, ndk);

    // 2. Initialize secondary eCash pocket if needed
    if (ENABLE_NUTZAPS) {
        try {
            if (primaryWallet.canSendNutzap) {
                nutzapWallet = primaryWallet; // Already an eCash-capable wallet
            } else {
                console.log('[Bot] Initializing secondary eCash pocket for Nutzaps...');
                nutzapWallet = createWalletProvider({
                    provider: 'cashu',
                    mintUrl: process.env.CASHU_MINT_URL
                }, ndk);
            }

            // Initialize Manual Nutzap Collector
            if (nutzapWallet.wallet) {
                const botUser = await ndk.signer?.user();
                if (!botUser) throw new Error("NDK Signer required for Nutzap Collection");
                
                // Start manual monitoring for Kind 9321 (Nutzaps)
                startManualNutzapCollector(ndk);

                // Announce support to the world
                await announceBotCapabilities(ndk, nutzapWallet.mintUrls);
            }
        } catch (e) {
            console.warn('[Bot] Nutzap Monitor failed to start, skipping...', e.message);
        }
    }

    // Cache for checkpoints to avoid relay spam in real-time
    ndk.activeCheckpointsCache = { data: [], lastFetch: 0 };

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

    global.sharedNDK = ndk;
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
// Unified Wallet — pay a bolt11 invoice
// ─────────────────────────────────────────────
async function payLightningInvoice(invoice) {
    return await primaryWallet.pay(invoice);
}

// ─────────────────────────────────────────────
// Wallet payment verification
// Checks that an incoming payment of the right amount arrived around the
// time of the RSVP.
//
// FAILS OPEN: if the wallet API is unreachable we accept the RSVP — the app already
// verified the zap succeeded before publishing the RSVP, so this is a
// second-layer sanity check, not the primary gate.
// ─────────────────────────────────────────────

/**
 * Verifies that a contest entry fee arrived in the wallet.
 * Matches: incoming payment with amount >= feeSats
 * within a ±2 hour window around the RSVP timestamp.
 *
 * Fails open if: fee is 0 or Wallet API is unavailable.
 */
async function verifyContestPayment(contestId, feeSats, rsvpCreatedAt) {
    if (feeSats <= 0) return true; // Free contest — no payment needed

    // Wide window: 1 hour before RSVP, 24 hours after (covers delayed NWC payments
    // and cases where the payment arrived before the RSVP was published)
    const windowSecs = 3600;
    const startTs = (rsvpCreatedAt - windowSecs) * 1000;
    const endTs = (rsvpCreatedAt + (windowSecs * 24)) * 1000;

    const payments = await primaryWallet.getPayments(startTs, endTs);

    // Fail open if API unavailable
    if (payments === null) {
        console.log(`[Bot]   ⚠️ Wallet API unavailable — cannot verify payment, accepting RSVP (fail open)`);
        return true;
    }

    if (payments.length === 0) {
        console.log(`[Bot]   ⚠️ No payments found in window — accepting RSVP (fail open)`);
        return true;
    }

    // Find an incoming payment of at least feeSats
    const match = payments.find(p => {
        if (isNaN(p.amount) || p.amount <= 0) return false; // outgoing or invalid
        if (p.amount < feeSats) return false;
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
// Payout helper — Hybrid Nutzap/Lightning
// ─────────────────────────────────────────────
async function payoutWinner(ndk, pubkey, splitSats, eventId, eventKind = 33402) {
    const botUser = await ndk.signer?.user();
    if (pubkey === botUser?.pubkey) {
        console.log(`[Bot] Skipping payout to self (${pubkey.substring(0, 8)}) — this is likely a fee/budget refund to the bot.`);
        return true;
    }

    // 1. Try Nutzap (NIP-61) if enabled
    if (ENABLE_NUTZAPS && nutzapWallet) {
        try {
            // Check for Nutzap Info (Kind 10019)
            const nutzapInfo = await ndk.fetchEvent({ kinds: [10019], authors: [pubkey] });
            if (nutzapInfo) {
                const success = await nutzapWallet.sendNutzap(pubkey, splitSats, eventId);
                if (success) {
                    console.log(`[Bot] ✅ Nutzap payout successful for ${pubkey.substring(0, 8)}`);
                    return true;
                }
            }
        } catch (e) {
            console.warn(`[Bot] Nutzap attempt failed, falling back to Lightning:`, e.message);
        }
    }

    // 2. Fallback to Lightning (LUD-16 / Invoice) via Primary Wallet
    const splitMsats = splitSats * 1000;
    const userObj = ndk.getUser({ pubkey });
    let profile;
    try {
        profile = await userObj.fetchProfile();
    } catch (err) {
        console.warn(`[Bot] Could not fetch profile for ${pubkey.substring(0, 8)}:`, err.message);
    }

    const lud16 = profile?.lud16;
    if (!lud16 || !lud16.includes('@')) {
        console.error(`[Bot] ❌ No Lightning address (lud16) found for user ${pubkey.substring(0, 8)}.`);
        return false;
    }

    const [user, domain] = lud16.split('@');
    try {
        // 1. Fetch LNURLp Metadata
        const lnurlpRes = await axios.get(`https://${domain}/.well-known/lnurlp/${user}`);
        const { callback, allowsNostr, nostrPubkey } = lnurlpRes.data;
        if (!callback) return false;

        let zapUrl = `${callback}?amount=${splitMsats}`;

        // 2. NIP-57 Zap Request (if supported)
        if (allowsNostr && nostrPubkey && eventId) {
            console.log(`[Bot] ⚡ Creating NIP-57 Zap Request for event ${eventId.substring(0, 8)}...`);
            try {
                const zapRequest = new NDKEvent(ndk);
                zapRequest.kind = 9734;
                zapRequest.content = "Bikel Reward! ⚡🚲";
                zapRequest.tags = [
                    ['p', pubkey],
                    ['amount', splitMsats.toString()],
                    ['relays', ...RELAYS]
                ];
                if (eventId) {
                    zapRequest.tags.push(['e', eventId]);
                }
                await zapRequest.sign();
                const zapEventSerialized = JSON.stringify(zapRequest.rawEvent());
                zapUrl += `&nostr=${encodeURIComponent(zapEventSerialized)}`;
            } catch (zapErr) {
                console.warn(`[Bot]   ⚠️ Could not sign zap request: ${zapErr.message}. Falling back to raw LNURL.`);
            }
        }

        // 3. Get Invoice
        const invoiceRes = await axios.get(zapUrl);
        const pr = invoiceRes.data.pr;
        if (!pr) return false;

        // 4. Pay Invoice via Primary Wallet
        const success = await payLightningInvoice(pr);
        if (success && TREASURY_LUD16 && PLATFORM_FEE_PCT > 0) {
            const feeSats = Math.max(1, Math.floor(splitSats * PLATFORM_FEE_PCT));
            console.log(`[Bot] 💎 Sending ${feeSats} sat markup fee to treasury (${TREASURY_LUD16})...`);
            await payoutByLud16(TREASURY_LUD16, feeSats);
        }
        return success;
    } catch (e) {
        console.error(`[Bot] ❌ Payout failed for ${lud16}:`, e.message);
        return false;
    }
}

/**
 * Generic payout by LUD-16
 */
async function payoutByLud16(lud16, sats) {
    if (!lud16 || !lud16.includes('@')) return false;

    // Self-payout guard for LUD-16
    if (lud16 === TREASURY_LUD16) {
        console.log(`[Bot] Skipping treasury payout — already in treasury account (${lud16}).`);
        return true;
    }

    const [user, domain] = lud16.split('@');
    try {
        const lnurlpRes = await axios.get(`https://${domain}/.well-known/lnurlp/${user}`);
        const callback = lnurlpRes.data.callback;
        if (!callback) return false;
        const invoiceRes = await axios.get(`${callback}?amount=${sats * 1000}`);
        const pr = invoiceRes.data.pr;
        if (!pr) return false;
        return await payLightningInvoice(pr);
    } catch (err) {
        console.error(`[Bot] Failed payout to ${lud16}:`, err.message);
        return false;
    }
}

// ─────────────────────────────────────────────
// Manual Nutzap Collector (Bypassing broken NDKNutzapMonitor)
// ─────────────────────────────────────────────
async function startManualNutzapCollector(ndk) {
    const botUser = await ndk.signer?.user();
    if (!botUser) return;
    
    console.log('[Bot] Manual Nutzap Collector active.');
    const sub = ndk.subscribe({
        kinds: [9321],
        '#p': [botUser.pubkey],
        since: Math.floor(Date.now() / 1000)
    }, { closeOnEose: false });

    sub.on('event', async (event) => {
        try {
            console.log(`[Bot] ⚡ Incoming Nutzap detected: ${event.id.substring(0, 8)}`);
            // Attempt to redeem via the nutzapWallet's internal NDKCashuWallet
            if (nutzapWallet?.wallet?.redeem) {
                await nutzapWallet.wallet.redeem(event);
                console.log(`[Bot] ✅ Nutzap redeemed successfully!`);
            } else {
                 console.warn(`[Bot] Could not redeem Nutzap: Wallet redeem method not found.`);
            }
        } catch (e) {
            console.warn(`[Bot] Failed to redeem Nutzap:`, e.message);
        }
    });
}

// ─────────────────────────────────────────────
// Bot Identity — Announce Nutzap Info (Kind 10019)
// Tells everyone which mints the bot trusts for eCash
// ─────────────────────────────────────────────
async function announceBotCapabilities(ndk, mintUrls = []) {
    if (!ndk.signer || mintUrls.length === 0) return;
    try {
        const botUser = await ndk.signer.user();
        console.log(`[Bot] Announcing Nutzap support for ${mintUrls.length} mint(s)...`);

        const announce = new NDKEvent(ndk);
        announce.kind = 10019;
        announce.content = "";
        announce.tags = [
            // List all trusted mints
            ...mintUrls.map(url => ['mint', url]),
            // Add a client tag for Bikel
            ['client', 'bikel']
        ];

        await announce.publish();
        console.log(`[Bot] ✅ Nutzap info published: ${announce.id}`);
    } catch (err) {
        console.warn('[Bot] Failed to announce Nutzap support:', err.message);
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

        const success = await payoutWinner(ndk, payout.pubkey, payout.splitSats, payout.contestId || payout.eventId);

        if (success) {
            removePendingPayout(referencedNoteId);
            delete pending[referencedNoteId];

            if (!payout.pubkey) return;
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
    const contestsRaw = await fetchWithTimeout(ndk, { kinds: [33401] }, 30000);

    const announced = loadAnnouncements();
    const startingSoon = Array.from(contestsRaw).filter(c => {
        if (announced.has(c.id)) return false;
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
        saveAnnouncement(contest.id);
        console.log(`[Bot] Announced upcoming challenge: "${name}"`);
    }
}

// ─────────────────────────────────────────────
// Main — process finished challenges
// ─────────────────────────────────────────────
async function processFinishedContests() {
    if (fs.existsSync(LOCK_FILE)) {
        try {
            const lockData = fs.readFileSync(LOCK_FILE, 'utf8');
            const oldPid = parseInt(lockData);
            if (oldPid && !isNaN(oldPid)) {
                // Check if process is actually running
                try {
                    process.kill(oldPid, 0);
                    console.log(`[Bot] LOCK FILE EXISTS (PID ${oldPid}) — instance still active. Skipping.`);
                    return;
                } catch (e) {
                    console.log(`[Bot] Stale lock file found (PID ${oldPid} not running). Overwriting.`);
                }
            }
        } catch (e) {
            console.log('[Bot] Error reading lock file. Removing.');
        }
        try { fs.unlinkSync(LOCK_FILE); } catch (err) { }
    }
    fs.writeFileSync(LOCK_FILE, process.pid.toString());

    console.log('[Bot] Running finished challenge aggregator...');

    const processedContests = loadProcessedContests();
    console.log(`[Bot] ${processedContests.size} challenge(s) already processed (will skip).`);

    try {
        const ndk = await initializeNDK();
        const botUser = await ndk.signer?.user();
        const myPubkey = botUser?.pubkey;

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

        // Mapping: Challenge Title -> Challenge a-tag coordinate
        const challengeIdMap = {};
        for (const contest of contestsRaw) {
            const title = contest.getMatchingTags('title')[0]?.[1];
            const dTag = contest.getMatchingTags('d')[0]?.[1];
            if (title && dTag) {
                challengeIdMap[title.trim().toLowerCase()] = `33401:${contest.pubkey}:${dTag}`;
            }
        }
        if (Object.keys(challengeIdMap).length > 0) {
            console.log(`[Bot] Scavenger Hunt Mapping: ${JSON.stringify(challengeIdMap)}`);
        }

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
                // Silently skip old/grace challenges to prevent log flooding
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
            const RIDE_FETCH_BUFFER = 43200; // 12 hour buffer after contest end
            const rides = await fetchWithTimeout(ndk, {
                kinds: [33301, 1301],
                authors: participantPubkeys,
                since: startTimestamp,
                until: endTimestamp + RIDE_FETCH_BUFFER,
                limit: 5000
            }, 45000);

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
                if (!pubkey) {
                    console.warn(`[Bot]   - Ride ${ride.id.substring(0, 8)} has no pubkey, skipping.`);
                    continue;
                }

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

            // ── Prize pool ──
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

            // ── Payouts ──
            const nevent = nip19.neventEncode({ id: contest.id, relays: RELAYS });
            const noLud16Winners = [];

            for (let i = 0; i < topWinners.length; i++) {
                const [pubkey, score] = topWinners[i];
                const splitSats = Math.floor(totalPrizePoolSats * payoutSplits[i]);
                if (splitSats <= 0) continue;

                const place = ['🥇', '🥈', '🥉'][i] ?? `#${i + 1}`;
                const paid = await payoutWinner(ndk, pubkey, splitSats, contest.id, 33401);
                if (!paid) {
                    console.log(`[Bot] No lud16 for ${pubkey.substring(0, 8)} — queuing pending payout.`);
                    noLud16Winners.push({ pubkey, splitSats, score, place });
                }
            }

            saveProcessedContest(contest.id);
            console.log(`[Bot] Challenge ${contest.id.substring(0, 12)}... marked as processed.`);

            // ── Results note ──────────
            if (ndk.signer && topWinners.length > 0) {
                let summaryText = `🏆 Results are in for: ${contestName}!\n\n`;
                for (let i = 0; i < topWinners.length; i++) {
                    const [pubkey, score] = topWinners[i];
                    if (!pubkey) continue;
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

                // ── Nudges ──────────
                for (const { pubkey, splitSats, place } of noLud16Winners) {
                    if (!pubkey) continue;
                    const npub = nip19.npubEncode(pubkey);
                    const nudgeContent = `${place} nostr:${npub} — you won ${splitSats} sats in "${contestName}"! 🎉\n\n` +
                        `We couldn't send your payout because you don't have a Lightning address set on your Nostr profile.\n\n` +
                        `👉 Add a Lightning address (lud16) to your profile, then reply to this note and we'll send your ${splitSats} sats automatically! ⚡`;
                    const nudgeNote = await publishNote(ndk, nudgeContent, [['p', pubkey], ['e', contest.id, RELAYS[0], 'mention']]);
                    if (nudgeNote) savePendingPayout(nudgeNote.id, { pubkey, splitSats, contestId: contest.id, contestName });
                }
            }
        }

        // ── Kind 33402: Sponsored Checkpoints 🤖📍 ──────
        console.log('[Bot] Checking for active Sponsored Checkpoints (Kind 33402)...');

        // Tiered fetch for reliability: Scan last 24h first for new points, then go deeper.
        const cpRecentRaw = await fetchWithTimeout(ndk, { kinds: [33402], since: now - 86400 }, 15000);
        console.log(`[Bot] Tier 1 Discovery: Found ${cpRecentRaw.size} recent checkpoint(s).`);

        const cpHistoryRaw = await fetchWithTimeout(ndk, { kinds: [33402], since: now - (30 * 86400) }, 20000);
        console.log(`[Bot] Tier 2 Discovery: Found ${cpHistoryRaw.size} historical checkpoint(s).`);

        const checkpointsRawInstances = [...Array.from(cpRecentRaw), ...Array.from(cpHistoryRaw)];
        const uniqueCPMap = new Map();
        checkpointsRawInstances.forEach(c => uniqueCPMap.set(c.id, c));

        // ── Kind 33401 Scavenger Hunts 🧩 ──────
        // Fetch active Scavenger Hunts to link to checkpoints
        const huntsRaw = await fetchWithTimeout(ndk, { kinds: [33401], since: now - (30 * 86400) }, 15000);
        console.log(`[Bot] Discovery: Found ${huntsRaw.size} scavenger hunts/challenges.`);

        const cpToHuntMap = new Map(); // checkpointId -> Array of hunt info
        for (const hunt of huntsRaw) {
            const huntTitle = hunt.getMatchingTags('title')[0]?.[1] || 'Scavenger Hunt';
            const bonus = parseInt(hunt.getMatchingTags('set_reward')[0]?.[1] ||
                hunt.getMatchingTags('set_bonus')[0]?.[1] || '0', 10);

            hunt.tags.forEach(t => {
                if ((t[0] === 'e' || t[0] === 'a') && t[1]) {
                    const cpIdOrCoord = t[1];
                    const cleanId = cpIdOrCoord.split(':').pop(); // Handle NIP-01 and NIP-33
                    if (!cpToHuntMap.has(cleanId)) cpToHuntMap.set(cleanId, []);
                    cpToHuntMap.get(cleanId).push({ id: hunt.id, title: huntTitle, bonus });
                }
            });
        }


        const activeCheckpoints = Array.from(uniqueCPMap.values()).filter(c => {
            const end = parseInt(c.getMatchingTags('end')[0]?.[1] || '0', 10);
            return end > now;
        }).map(cp => {
            const loc = cp.getMatchingTags('location')[0]?.[1] || '';
            const [lat, lng] = loc.split(',').map(Number);
            return {
                event: cp, id: cp.id, lat, lng,
                reward: parseInt(cp.getMatchingTags('reward')[0]?.[1] || '0', 10),
                radius: parseInt(cp.getMatchingTags('radius')[0]?.[1] || '20', 10),
                title: cp.getMatchingTags('title')[0]?.[1] || 'POI Checkpoint',
                frequency: cp.getMatchingTags('frequency')[0]?.[1] || 'daily',
                limit: parseInt(cp.getMatchingTags('limit')[0]?.[1] || '100', 10),
                bot: cp.getMatchingTags('bot')[0]?.[1],
                set: cp.getMatchingTags('set')[0]?.[1],
                route_id: cp.getMatchingTags('route_id')[0]?.[1],
                route_index: parseInt(cp.getMatchingTags('route_index')[0]?.[1] || '-1', 10),
                rsvp_required: cp.getMatchingTags('rsvp')[0]?.[1] === 'required',
                streak_reward: parseInt(cp.getMatchingTags('streak_reward')[0]?.[1] || '0', 10),
                hunts: (() => {
                    const dTag = cp.getMatchingTags('d')[0]?.[1];
                    const h1 = cpToHuntMap.get(cp.id) || [];
                    const h2 = dTag ? (cpToHuntMap.get(dTag) || []) : [];
                    // Deduplicate by hunt ID
                    const combined = [...h1, ...h2];
                    const seen = new Set();
                    return combined.filter(h => {
                        if (seen.has(h.id)) return false;
                        seen.add(h.id);
                        return true;
                    });
                })()
            };


        }).filter(cp => {
            const isMine = (!cp.bot || cp.bot === myPubkey);
            const isValid = !isNaN(cp.lat) && !isNaN(cp.lng) && cp.reward > 0;
            if (isMine && isValid) {
                console.log(`[Bot]   📍 Active: "${cp.title}" (ID: ${cp.id.substring(0, 8)})`);
            }
            return isMine && isValid;
        });

        console.log(`[Bot] Found ${activeCheckpoints.length} active checkpoint(s) for this bot.`);
        if (activeCheckpoints.length > 0) {
            const hourlyRides = await fetchWithTimeout(ndk, {
                kinds: [1301, 33301],
                since: now - 86400, // Broaden to last 24h for reliability
                limit: 1000
            }, 30000);

            const rawRideEvents = Array.from(hourlyRides);
            const rideEvents = rawRideEvents.filter(r => {
                const isBikel = r.tags.some(t => (t[0] === 't' && t[1] === 'bikel') || (t[0] === 'client' && t[1] === 'bikel'));
                const isTargetUser = r.pubkey.startsWith('00033a93');
                if (isTargetUser) console.log(`[Bot] Found event from Target User! Kind: ${r.kind}, Bikel-Tagged: ${isBikel}`);
                return r.kind === 33301 || isBikel;
            });

            if (rideEvents.length > 0) {
                const k1301 = rideEvents.filter(r => r.kind === 1301).length;
                const k33301 = rideEvents.filter(r => r.kind === 33301).length;
                console.log(`[Bot] Processing ${rideEvents.length} Bikel-relevant ride events (${k1301} kind-1301, ${k33301} kind-33301)`);
            }

            // Fetch RSVPs for all active riders (Synchronized with Web App Logic)
            const riderPubkeys = Array.from(new Set(rideEvents.map(r => r.pubkey)));
            const riderJoinedMap = new Map(); // pubkey -> Set(Event IDs or Coordinates)

            if (riderPubkeys.length > 0) {
                console.log(`[Bot] Syncing RSVPs for ${riderPubkeys.length} active rider(s)...`);
                const userRsvps = await fetchWithTimeout(ndk, {
                    kinds: [31925],
                    authors: riderPubkeys,
                    '#t': ['bikel-rsvp']
                }, 15000);

                for (const rsvp of userRsvps) {
                    if (!riderJoinedMap.has(rsvp.pubkey)) riderJoinedMap.set(rsvp.pubkey, new Set());
                    const set = riderJoinedMap.get(rsvp.pubkey);
                    rsvp.tags.forEach(t => {
                        if ((t[0] === 'a' || t[0] === 'e') && t[1]) set.add(t[1]);
                    });
                }
            }

            const allHistory = loadCheckpointPayouts();
            for (const ride of rideEvents) {
                const hitsThisRide = [];
                for (const cp of activeCheckpoints) {
                    const userHistory = (allHistory[cp.id] || {})[ride.pubkey] || [];
                    const totalHits = Object.values(allHistory[cp.id] || {}).reduce((acc, h) => acc + h.length, 0);

                    // 0. Deduplication: Did we process THIS RIDE for THIS CHECKPOINT already?
                    const alreadyProcessed = userHistory.find(h => h.rideId === ride.id);
                    if (alreadyProcessed) {
                        console.log(`[Bot]   📍 Skip "${cp.title}": Already processed this specific ride (${ride.id.substring(0, 8)}). Adding to virtual hit list for set evaluation.`);
                        hitsThisRide.push({ cp, index: 0, isExisting: true });
                        continue;
                    }


                    // 1. Global limit check (after deduping same ride)
                    if (totalHits >= cp.limit) {
                        console.log(`[Bot]   📍 Skip "${cp.title}": Global limit reached (${totalHits}/${cp.limit})`);
                        continue;
                    }

                    // 2. RSVP Check (Synchronized with App Logic)
                    let hasRsvp = false;
                    const userJoinedSet = riderJoinedMap.get(ride.pubkey);
                    const cpCoordinate = `33402:${cp.event.pubkey}:${cp.event.getMatchingTags('d')[0]?.[1]}`;
                    const parentChallengeCoordinate = cp.set ? (challengeIdMap[cp.set.trim().toLowerCase()] || `33401:${cp.event.pubkey}:${cp.set}`) : null;

                    if (cp.rsvp_required) {
                        if (userJoinedSet) {
                            hasRsvp = userJoinedSet.has(cpCoordinate) ||
                                userJoinedSet.has(cp.event.id) ||
                                (parentChallengeCoordinate && userJoinedSet.has(parentChallengeCoordinate));
                        }
                    } else {
                        hasRsvp = true;
                    }

                    if (cp.rsvp_required && !hasRsvp) {
                        console.log(`[Bot]   📍 Skip "${cp.title}": Ride by ${ride.pubkey.substring(0, 8)} missing RSVP.`);
                        continue;
                    }

                    console.log(`[Bot] Checking Hit for ${ride.pubkey.substring(0, 8)} (Ride Kind: ${ride.kind}) on "${cp.title}" (RSVP: OK)...`);

                    // 3. Frequency check
                    if (cp.frequency === 'once' && userHistory.length > 0) { console.log(`[Bot]   -> Skip: Paid already (once).`); continue; }
                    if (cp.frequency === 'daily' && userHistory.find(ts => (ts.ts || ts) > now - 86400)) { console.log(`[Bot]   -> Skip: Paid already today.`); continue; }
                    if (cp.frequency === 'hourly' && userHistory.find(ts => (ts.ts || ts) > now - 3600)) { console.log(`[Bot]   -> Skip: Paid already this hour.`); continue; }
                    if (cp.frequency === 'hourly' && userHistory.find(ts => (ts.ts || ts) > now - 3600)) { console.log(`[Bot]   -> Skip: Paid already this hour.`); continue; }

                    let hitIdx = -1;
                    const explicitHitId = ride.getMatchingTags('checkpoint_hit')[0]?.[1];
                    if (explicitHitId && (explicitHitId === cp.id || cp.id.startsWith(explicitHitId))) {
                        console.log(`[Bot]   -> 🎯 Explicit Hit Tag found! (${explicitHitId})`);
                        hitIdx = 0;
                    } else {
                        // REFACTORED ROBUST COORDINATE EXTRACTION
                        const routeTag = ride.getMatchingTags('route')[0]?.[1];
                        const gTag = ride.getMatchingTags('g')[0]?.[1];
                        const rawData = routeTag || gTag;

                        let coords = [];
                        if (rawData) {
                            try {
                                const parsed = JSON.parse(rawData);
                                coords = Array.isArray(parsed) ? parsed : (parsed.route || []);
                            } catch (e) { }
                        }
                        // Fallback: check content for JSON (Common in Live Tracking Kind 33301)
                        if (coords.length === 0 && ride.content && (ride.content.includes('"route"') || ride.content.includes('"lat"'))) {
                            try {
                                const jsonMatch = ride.content.match(/\{.*?\}/s);
                                const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : ride.content);
                                coords = Array.isArray(parsed) ? parsed : (parsed.route ? parsed.route : [parsed]);
                            } catch (e) { }
                        }

                        if (coords.length > 0) {
                            let minVDist = Infinity;
                            let closestPoint = null;
                            for (let i = 0; i < coords.length; i++) {
                                const p = coords[i];
                                if (!p) continue;
                                const lat = Number(p.lat ?? p[0]);
                                const lng = Number(p.lng ?? p[1]);
                                if (isNaN(lat) || isNaN(lng)) continue;

                                const dist = calculateDistance(cp.lat, cp.lng, lat, lng);
                                if (dist < minVDist) {
                                    minVDist = dist;
                                    closestPoint = { lat, lng };
                                }

                                if (dist <= cp.radius) {
                                    console.log(`[Bot]   -> 🎯 Found proximity match! Dist: ${dist.toFixed(1)}m (Radius: ${cp.radius}m)`);
                                    hitIdx = i; break;
                                }
                            }
                            if (hitIdx === -1 && minVDist !== Infinity) {
                                console.log(`[Bot]   -> No hit. Closest: ${minVDist.toFixed(1)}m (Need <= ${cp.radius}m) CP: ${cp.lat.toFixed(6)},${cp.lng.toFixed(6)} vs PT: ${closestPoint?.lat.toFixed(6)},${closestPoint?.lng.toFixed(6)}`);
                            }
                        } else {
                            console.log(`[Bot]   -> Skip: No coordinate data found in tags or content (Kind: ${ride.kind})`);
                            if (ride.kind === 33301 && ride.content && ride.content.length > 50) {
                                console.log(`[Bot]      Content appears to be binary/Base64. Length: ${ride.content.length}`);
                            }
                        }
                    }
                    if (hitIdx !== -1) hitsThisRide.push({ cp, index: hitIdx });
                }

                if (hitsThisRide.length > 0) {
                    hitsThisRide.sort((a, b) => a.index - b.index);
                    const setsHit = {};
                    for (const h of hitsThisRide) if (h.cp.set) setsHit[h.cp.set] = (setsHit[h.cp.set] || 0) + 1;

                    for (const hitObj of hitsThisRide) {
                        const cp = hitObj.cp;
                        console.log(`[Bot] 🎯 HIT! User ${ride.pubkey.substring(0, 8)} visited "${cp.title}" (Index: ${hitObj.index}) Reward: ${cp.reward} sats`);
                        let bonusSats = 0;

                        // 1. Streak (New Hits Only)
                        if (!hitObj.isExisting) {
                            const streakDays = parseInt(cp.event.getMatchingTags('streak_days')[0]?.[1] || '5', 10);
                            const userHistory = (allHistory[cp.id] || {})[ride.pubkey] || [];
                            const lastEntry = userHistory[userHistory.length - 1];
                            const lastPayout = (typeof lastEntry === 'object' && lastEntry !== null) ? lastEntry.ts : (lastEntry || 0);

                            if (lastPayout >= now - 172800 && lastPayout <= now - 86400) {
                                if ((userHistory.length + 1) % streakDays === 0) {
                                    bonusSats = cp.streak_reward || (cp.reward * (streakDays - 1));
                                    console.log(`[Bot] 🔥 STREAK BONUS (${streakDays} days) hit for "${cp.title}"! (+${bonusSats} sats)`);
                                }
                            }
                        }

                        // 2. Set Bonus (Scavenger Hunt) - ALWAYS EVALUATE
                        // This point may belong to multiple hunts/sets
                        const targetSets = [...(cp.hunts || [])];
                        if (cp.set) targetSets.push({ id: cp.set, title: cp.set, bonus: 0 }); // Legacy support

                        if (targetSets.length > 0) {
                            const setPayouts = loadSetPayouts();

                            for (const huntInfo of targetSets) {
                                const huntId = huntInfo.id;
                                if (setPayouts[huntId]?.[ride.pubkey]) continue; // Already paid for this specific hunt

                                // Find all checkpoints belonging to this hunt
                                const setCPs = activeCheckpoints.filter(c =>
                                    c.set === huntId || c.hunts.some(h => h.id === huntId)
                                );

                                if (setCPs.length === 0) continue;

                                // Count how many CPs in this set the user has HIT (ever + in this ride)
                                const currentRideHitIds = new Set(hitsThisRide.map(h => h.cp.id));
                                let hitsCount = 0;
                                for (const scp of setCPs) {
                                    const hasHistory = (allHistory[scp.id] || {})[ride.pubkey]?.length > 0;
                                    const hittingInThisRide = currentRideHitIds.has(scp.id);
                                    if (hasHistory || hittingInThisRide) hitsCount++;
                                }

                                if (hitsCount >= setCPs.length && setCPs.length > 0) {
                                    // Hunt bonus logic: priority to huntInfo.bonus, then trial tags
                                    let setBonus = huntInfo.bonus;
                                    if (setBonus <= 0) {
                                        setBonus = parseInt(cp.event.getMatchingTags('set_reward')[0]?.[1] ||
                                            cp.event.getMatchingTags('set_bonus')[0]?.[1] || '0', 10) || 0;
                                    }

                                    // If still 0, we might want to skip or use a small default
                                    if (setBonus > 0) {
                                        bonusSats += setBonus;
                                        saveSetPayout(huntId, ride.pubkey);
                                        console.log(`[Bot] 🧩 SET COMPLETE! User ${ride.pubkey.substring(0, 8)} finished "${huntInfo.title}"! (+${setBonus} sats)`);
                                    }
                                }
                            }
                        }


                        // 3. Ordered Routing Bonus (New Hits Only)
                        if (!hitObj.isExisting && cp.route_id && cp.route_index > 0) {
                            const prevIdx = cp.route_index - 1;
                            const prevHit = hitsThisRide.find(h => h.cp.route_id === cp.route_id && h.cp.route_index === prevIdx);
                            if (prevHit && prevHit.index < hitObj.index) {
                                const orderBonus = parseInt(cp.event.getMatchingTags('order_bonus')[0]?.[1] || '0', 10) || cp.reward;
                                bonusSats += orderBonus;
                                console.log(`[Bot] 🧭 ORDER BONUS: Sequence "${prevHit.cp.title}" -> "${cp.title}"! (+${orderBonus} sats)`);
                            }
                        }

                        const finalReward = (hitObj.isExisting ? 0 : cp.reward) + bonusSats;
                        if (finalReward > 0 && await payoutWinner(ndk, ride.pubkey, finalReward, cp.id)) {
                            if (!hitObj.isExisting) saveCheckpointPayout(cp.id, ride.pubkey, now, finalReward, ride.id);

                            if (!ride.pubkey) continue;
                            const npub = nip19.npubEncode(ride.pubkey);
                            let msg = `🎯 Checkpoint Reached! nostr:${npub} visited "${cp.title}" and earned ${finalReward} sats! ⚡🚲`;
                            if (hitObj.isExisting) msg = `🧩 Scavenger Hunt Bonus! nostr:${npub} completed "${cp.title}" set and earned ${finalReward} sats! ⚡🚲`;
                            else if (bonusSats > 0) msg = `🎯 MEGA HIT! nostr:${npub} completed a bonus at "${cp.title}" and earned ${finalReward} sats! 🔥🚲`;

                            await publishNote(ndk, msg, [
                                ['p', ride.pubkey],
                                ['e', cp.id, RELAYS[0], 'mention'],
                                ['e', ride.id, RELAYS[0], 'context'],
                                ['t', 'bikel_bonus']
                            ]);

                        }

                    }
                }
            }
        }
    } catch (e) {
        console.error('[Bot] Error processing challenges:', e);
        if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
    }

    try {
        const ndk = await initializeNDK();
        await processRefunds(ndk);
    } catch (e) {
        console.error('[Bot] Error in refund job:', e);
    }

    console.log('[Bot] Challenge processing complete.\n');
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
}

/**
 * Automatically refund unspent budget for expired checkpoints
 */
async function processRefunds(ndk) {
    console.log('[Bot] Checking for expired checkpoints to refund...');
    const now = Math.floor(Date.now() / 1000);
    const myPubkey = (await ndk.signer?.user())?.pubkey;

    // Fetch checkpoints that ended in the last 48h to ensure we catch them
    const expiredRaw = await fetchWithTimeout(ndk, {
        kinds: [33402],
        until: now,
        since: now - 172800
    }, 20000);

    const processedRefunds = loadProcessedRefunds();
    const allPayouts = loadCheckpointPayouts();

    // Grouping by "Set" to handle Scavenger Hunts as a single unit
    const sets = new Map(); // Name -> { points: [], totalFunded: 0, totalDistributed: 0, latestEnd: 0, sponsor: '' }
    const soloPoints = [];

    for (const cp of Array.from(expiredRaw)) {
        if (processedRefunds.has(cp.id)) continue;
        const botTag = cp.getMatchingTags('bot')[0]?.[1];
        if (botTag && botTag !== myPubkey) continue;

        const setName = cp.getMatchingTags('set')[0]?.[1];
        const endTime = parseInt(cp.getMatchingTags('end')[0]?.[1] || '0');

        if (!setName) {
            soloPoints.push(cp);
            continue;
        }

        if (!sets.has(setName)) {
            sets.set(setName, { points: [], totalFunded: 0, totalDistributed: 0, latestEnd: 0, sponsor: cp.pubkey });
        }
        const s = sets.get(setName);
        s.points.push(cp);
        if (endTime > s.latestEnd) s.latestEnd = endTime;
    }

    // Process Sets First
    for (const [setName, s] of sets.entries()) {
        // 1-hour Grace Period for Set expiration
        if (s.latestEnd > now - 3600) {
            console.log(`[Bot] Skipping set "${setName}": Not fully expired yet (Latest End: ${new Date(s.latestEnd * 1000).toISOString()})`);
            continue;
        }

        console.log(`[Bot] Evaluating refund for expired Set: "${setName}" (${s.points.length} points)`);

        let setFunded = 0;
        let setDistributed = 0;

        for (const cp of s.points) {
            // A. Aggregate Funding for this point
            const zaps = await fetchWithTimeout(ndk, { kinds: [9735], '#e': [cp.id] }, 10000);
            for (const z of Array.from(zaps)) {
                try {
                    const inner = JSON.parse(z.getMatchingTags('description')[0]?.[1] || '');
                    const amountTag = inner.tags.find(t => t[0] === 'amount');
                    if (amountTag) setFunded += Math.floor(parseInt(amountTag[1]) / 1000);
                } catch (e) { }
            }

            // B. Aggregate Distributions for this point
            const userHistory = allPayouts[cp.id] || {};
            const baseReward = parseInt(cp.getMatchingTags('reward')[0]?.[1] || '0');
            Object.values(userHistory).forEach(history => {
                history.forEach(entry => {
                    setDistributed += (typeof entry === 'object' && entry.amount !== undefined) ? entry.amount : baseReward;
                });
            });
        }

        if (setFunded === 0) {
            console.log(`[Bot]   - No funding found for set "${setName}".`);
            s.points.forEach(p => saveProcessedRefund(p.id));
            continue;
        }

        const intendedSetBudget = Math.floor(setFunded / (1 + PLATFORM_FEE_PCT));
        const refundSats = intendedSetBudget - setDistributed;

        if (refundSats > 50) {
            if (s.sponsor === myPubkey) {
                console.log(`[Bot]   - Skipping refund for set "${setName}": sponsor is bot.`);
            } else {
                console.log(`[Bot]   - Refunding ${refundSats} sats for set "${setName}" to sponsor ${s.sponsor.substring(0, 8)}...`);
                const paid = await payoutWinner(ndk, s.sponsor, refundSats, s.set);
                if (paid) {
                    await publishNote(ndk, `♻️ Scavenger Hunt Refund: ${refundSats} sats returned for "${setName}". 🚲⚡`, [['p', s.sponsor]]);
                }
            }
        } else {
            console.log(`[Bot]   - Balance too low for set refund (${refundSats} sats).`);
        }

        // Mark all points in the set as processed regardless of refund outcome
        s.points.forEach(p => saveProcessedRefund(p.id));
    }

    // Process Solo Points
    for (const cp of soloPoints) {
        const title = cp.getMatchingTags('title')[0]?.[1] || 'Checkpoint';
        const endTime = parseInt(cp.getMatchingTags('end')[0]?.[1] || '0');

        // 1-hour Grace Period for solo points
        if (endTime > now - 3600) continue;

        console.log(`[Bot] Evaluating refund for expired solo CP: "${title}" (${cp.id.substring(0, 8)})`);

        const zaps = await fetchWithTimeout(ndk, { kinds: [9735], '#e': [cp.id] }, 15000);
        let totalFunded = 0;
        for (const z of Array.from(zaps)) {
            try {
                const inner = JSON.parse(z.getMatchingTags('description')[0]?.[1] || '');
                const amountTag = inner.tags.find(t => t[0] === 'amount');
                if (amountTag) totalFunded += Math.floor(parseInt(amountTag[1]) / 1000);
            } catch (e) { }
        }

        if (totalFunded === 0) {
            saveProcessedRefund(cp.id);
            continue;
        }

        const userHistory = allPayouts[cp.id] || {};
        let totalDistributedAll = 0;
        const baseReward = parseInt(cp.getMatchingTags('reward')[0]?.[1] || '0');

        Object.values(userHistory).forEach(history => {
            history.forEach(entry => {
                totalDistributedAll += (typeof entry === 'object' && entry.amount !== undefined) ? entry.amount : baseReward;
            });
        });

        const intendedBudget = Math.floor(totalFunded / (1 + PLATFORM_FEE_PCT));
        const refundSats = intendedBudget - totalDistributedAll;

        if (refundSats > 50) {
            if (cp.pubkey !== myPubkey) {
                console.log(`[Bot]   - Refunding ${refundSats} sats for solo CP to sponsor ${cp.pubkey.substring(0, 8)}...`);
                const paid = await payoutWinner(ndk, cp.pubkey, refundSats, cp.id);
                if (paid) {
                    await publishNote(ndk, `♻️ Checkpoint Refund: ${refundSats} sats returned for "${title}".`, [['e', cp.id, RELAYS[0], 'mention'], ['p', cp.pubkey]]);
                }
            }
        }
        saveProcessedRefund(cp.id);
    }
}

function loadProcessedRefunds() {
    try {
        if (fs.existsSync(PROCESS_REFUNDS_FILE)) return new Set(JSON.parse(fs.readFileSync(PROCESS_REFUNDS_FILE)));
    } catch (e) { }
    return new Set();
}
function saveProcessedRefund(id) {
    const s = loadProcessedRefunds();
    s.add(id);
    fs.writeFileSync(PROCESS_REFUNDS_FILE, JSON.stringify(Array.from(s)));
}
const PROCESS_REFUNDS_FILE = './processed_refunds.json';

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

    // Initialize NDK once and start listeners
    initializeNDK().then(async (ndk) => {
        startRideSubscriber(ndk);

        // Run once on startup
        console.log('[Bot] Starting initial maintenance and announcement...');
        await announceBot(ndk);
        await publishRelayList(ndk);
        await processFinishedContests();

        // Setup cron for periodic maintenance (every 10 minutes)
        cron.schedule('*/10 * * * *', () => {
            console.log(`[Bot] v${BOT_VERSION} 10m Cron Triggered: ${new Date().toISOString()}`);
            processFinishedContests();
        });

        // Setup cron for bot announcement (Kind 33400) every hour
        cron.schedule('0 * * * *', () => {
            console.log(`[Bot] 1h Announcement Cron: Refreshing Kind 33400...`);
            announceBot(ndk);
        });
    }).catch(e => {
        console.error('[Bot] Initialization failed:', e);
        process.exit(1);
    });
}
