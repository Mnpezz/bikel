import 'react-native-get-random-values';
import { TextEncoder, TextDecoder } from 'text-encoding';
import NDK, { NDKNip07Signer, NDKEvent, NDKPrivateKeySigner, NDKUser, NDKZapper } from "@nostr-dev-kit/ndk";
import type { NDKFilter } from "@nostr-dev-kit/ndk";
// @ts-ignore - Types missing upstream
import { NDKNWCWallet } from "@nostr-dev-kit/ndk-wallet";
import * as SecureStore from 'expo-secure-store';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

// Polyfill for React Native crypto
if (typeof global.TextEncoder === 'undefined') {
    global.TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
    global.TextDecoder = TextDecoder as any;
}

const SECURE_STORE_KEY = 'bikel_private_key';

export const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol',
];

export const ESCROW_PUBKEY = "cc130b7120d00ded76d065bf0bd27e3a36a38d5268208078a1e99aa29ac44adf";

let globalNdk: NDK | null = null;
let globalSigner: NDKPrivateKeySigner | null = null;

// Convert Uint8Array to Hex String
const bytesToHex = (bytes: Uint8Array) =>
    bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');

/**
 * Initializes a Nostr Keypair. Loads from SecureStore, or generates a new one.
 */
export async function getSigner(): Promise<NDKPrivateKeySigner> {
    if (globalSigner) return globalSigner;

    let hexKey = await SecureStore.getItemAsync(SECURE_STORE_KEY);

    if (!hexKey) {
        console.log('[Nostr] No key found. Generating new anonymity key...');
        const secretKey = generateSecretKey();
        hexKey = bytesToHex(secretKey);
        await SecureStore.setItemAsync(SECURE_STORE_KEY, hexKey);
    }

    globalSigner = new NDKPrivateKeySigner(hexKey);
    return globalSigner;
}

/**
 * Initializes and connects to the global NDK instance.
 */
export async function connectNDK(): Promise<NDK> {
    if (globalNdk) return globalNdk;

    const signer = await getSigner();

    globalNdk = new NDK({
        explicitRelayUrls: DEFAULT_RELAYS,
        signer,
    });

    console.log('[Nostr] Connecting to relays...');
    await globalNdk.connect().catch(e => console.error('[Nostr] Connection error:', e));
    console.log('[Nostr] Connected.');

    return globalNdk;
}

/**
 * Basic heuristic to score the confidence that a ride was actually on a bicycle.
 * Returns a score between 0.0 and 1.0
 */
export function calculateRideConfidence(distanceMiles: number, durationSeconds: number, routePoints: { lat: number; lng: number }[] = []): number {
    if (distanceMiles <= 0 || durationSeconds <= 0) return 0;

    let baseConfidence = 1.0;

    // 1. Max Velocity Check (Average speed in mph)
    const avgSpeedMph = distanceMiles / (durationSeconds / 3600);

    if (avgSpeedMph > 45) {
        baseConfidence -= 0.8; // Almost certainly a car on a highway
    } else if (avgSpeedMph > 30) {
        baseConfidence -= 0.4;  // E-bikes can hit this, but fast for normal pedaling
    } else if (avgSpeedMph < 2) {
        baseConfidence -= 0.3;   // Very slow, maybe a walk
    }

    // 2. Data Density Check
    if (routePoints.length > 0) {
        // Require at least a few points per mile for a tracked ride to have high confidence
        const pointsPerMile = routePoints.length / distanceMiles;
        if (pointsPerMile < 2) {
            baseConfidence -= 0.6; // Extremely sparse, likely a spoof or start/stop only
        } else if (pointsPerMile < 5) {
            baseConfidence -= 0.3; // Very sparse
        }
    } else {
        // If they provided no points but claim high distance, we can't mathematically verify it
        baseConfidence -= 0.9;
    }

    return Math.max(0, Math.min(1.0, baseConfidence));
}

/**
 * Publishes a completed ride to Nostr.
 * Uses a parameterized replaceable event (Kind 33301 arbitrarily chosen for MVP).
 */
export async function publishRide(
    distanceMiles: number,
    durationSeconds: number,
    routePoints: { lat: number; lng: number }[],
    visibility: 'full' | 'blurred' | 'hidden' = 'full',
    title: string = "",
    description: string = "",
    image: string = ""
) {
    const ndk = await connectNDK();

    const event = new NDKEvent(ndk);
    event.kind = 33301;

    const confidence = calculateRideConfidence(distanceMiles, durationSeconds, routePoints);

    // Basic tags
    event.tags = [
        ['d', Date.now().toString()],
        ['distance', distanceMiles.toFixed(2)],
        ['duration', durationSeconds.toString()],
        ['visibility', visibility],
        ['confidence', confidence.toFixed(2)],
        ['client', 'bikel'],
        ['t', 'cycling'],
        ['t', 'bikel'],
        ['t', 'bikeride']
    ];
    if (title) event.tags.push(['title', title]);
    if (description) event.tags.push(['summary', description]);
    if (image) event.tags.push(['image', image]);

    // For the MVP, if visibility is full, let's just dump the route in content as a lightweight JSON
    if (visibility === 'full' && routePoints.length > 0) {
        // Compressed geo data (6 decimals = ~11cm precision):
        const compressedGeo = routePoints.map(p => [Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6))]);
        event.content = JSON.stringify({
            route: compressedGeo
        });
    } else {
        event.content = "";
    }

    console.log('[Nostr] Signing and publishing ride event...');
    await event.publish();
    console.log(`[Nostr] Ride published successfully! ID: ${event.id}`);

    // Dual-publish to Kind 1301 for RunSTR Interoperability
    try {
        const runstrEvent = new NDKEvent(ndk);
        runstrEvent.kind = 1301;
        runstrEvent.tags = [...event.tags];
        runstrEvent.content = event.content;
        await runstrEvent.publish();
        console.log(`[Nostr] RunSTR Event (Kind 1301) published successfully! ID: ${runstrEvent.id}`);
    } catch (e) {
        console.warn("[Nostr] Failed to dual-publish RunSTR event", e);
    }

    return event.id;
}

let nwcWallet: NDKNWCWallet | null = null;

export async function connectNWC(pairingCode: string): Promise<boolean> {
    const ndk = await connectNDK();
    try {
        // @ts-ignore - NDK versioning mismatch between wallet and core interfaces
        nwcWallet = new NDKNWCWallet(ndk, { pairingCode });

        // Wait for connection ready event
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject("NWC connection timeout"), 10000);
            nwcWallet!.once("ready", () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        // @ts-ignore - NDK NDKWalletInterface mismatch
        ndk.wallet = nwcWallet;
        console.log("[NWC - Mobile] Wallet connected and ready");
        return true;
    } catch (e) {
        console.error("[NWC - Mobile] Failed to connect wallet", e);
        nwcWallet = null;
        ndk.wallet = undefined;
        return false;
    }
}

export async function zapRideEvent(eventId: string, targetPubkey: string, targetKind: number, amountSats: number, comment = "Great ride!"): Promise<boolean> {
    const ndk = await connectNDK();
    const currentWallet = ndk.wallet || nwcWallet;
    if (!currentWallet) {
        throw new Error("No Lightning Wallet Connected");
    }

    let lastNotice = "";

    try {
        const event = new NDKEvent(ndk);
        event.id = eventId;
        event.pubkey = targetPubkey;
        event.kind = targetKind;

        let zapSigner = ndk.signer;
        if (!zapSigner) {
            zapSigner = NDKPrivateKeySigner.generate();
            ndk.signer = zapSigner;
        }

        console.log(`[Zap - Mobile] Requesting ${amountSats} sat zap for event ${eventId}...`);
        const zapper = new NDKZapper(event, amountSats * 1000, 'msat', {
            comment,
            ndk,
            lnPay: currentWallet.lnPay ? currentWallet.lnPay.bind(currentWallet) : undefined
        });

        zapper.on("notice", (msg) => {
            console.log("[Zap Notice]", msg);
            lastNotice = msg;
        });

        // Fire off the zap request to the NWC wallet
        zapper.zap().catch(e => console.warn(`[Zap - Mobile] Background Zap Promise Rejection (Ignored due to custom 9735 tracker):`, e));

        // Create an explicit Promise to track the cryptographic Kind 9735 (Zap Receipt) from the relays
        const verifiedReceipt = await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                resolve({ error: "Timeout: Nostr relays did not index a cryptographic Zap Receipt (Kind 9735) within 30 seconds. Your payment was either dropped by your node or is still routing." });
            }, 30000);

            // Subscribe to the Escrow node's receipts matching the event ID
            const sub = ndk.subscribe(
                {
                    kinds: [9735 as any],
                    "#p": [targetPubkey], // The Escrow bot pubkey
                    "#e": [eventId],      // The exact contest ID
                    since: Math.floor(Date.now() / 1000) - 5
                },
                { closeOnEose: false }
            );

            sub.on("event", (zapEvent: NDKEvent) => {
                // Verify the Zap Receipt was actually authored by the payer (or matches our invoice)
                console.log(`[Zap - Mobile] VERIFIED: Cryptographic Kind 9735 Receipt indexed on relays! ID: ${zapEvent.id}`);
                clearTimeout(timeoutId);
                sub.stop();
                resolve({ success: true, event: zapEvent });
            });
        });

        // @ts-ignore
        if (verifiedReceipt.error) {
            // @ts-ignore
            throw new Error(verifiedReceipt.error);
        }

        console.log(`[Zap - Mobile] Payment cryptographically verified!`);
        return true;
    } catch (e: any) {
        console.error("[Zap - Mobile] Failed to zap event", e);
        if (lastNotice) {
            throw new Error(`Lightning node error: ${lastNotice}`);
        } else if (e.message && e.message.includes("All zap attempts failed")) {
            throw new Error("This rider has not linked a Lightning Address to their Nostr profile!");
        }
        throw e;
    }
}

export interface RideEvent {
    id: string;
    pubkey: string;
    hexPubkey: string;
    time: number;
    distance: string;
    duration: string;
    visibility: string;
    route: number[][]; // [lat, lng][]
    title?: string;
    description?: string;
    image?: string;
    kind: 33301;
}

/**
 * Fetches the user's own published rides from the relays.
 */
export async function fetchMyRides(): Promise<RideEvent[]> {
    const ndk = await connectNDK();
    const signer = await getSigner();

    // We need the user's pubkey. Wait for the user object to resolve.
    const user = await signer.user();

    // Create a filter for this specific user's rides
    const filter = {
        kinds: [33301 as any],
        authors: [user.pubkey],
        limit: 50
    };

    console.log('[Nostr] Fetching personal ride history...');
    const events = await ndk.fetchEvents(filter);

    const rides: RideEvent[] = [];

    for (const event of events) {
        try {
            const distance = event.getMatchingTags("distance")[0]?.[1] || "0";
            const durationSecs = parseInt(event.getMatchingTags("duration")[0]?.[1] || "0", 10);
            const visibility = event.getMatchingTags("visibility")[0]?.[1] || "full";
            const title = event.getMatchingTags("title")[0]?.[1];
            const description = event.getMatchingTags("summary")[0]?.[1];
            const image = event.getMatchingTags("image")[0]?.[1];

            const mins = Math.floor(durationSecs / 60);
            const secs = durationSecs % 60;
            const durationStr = `${mins}m ${secs}s`;

            let route: number[][] = [];
            if (visibility === 'full' && event.content) {
                try {
                    const parsed = JSON.parse(event.content);
                    if (parsed.route && Array.isArray(parsed.route)) {
                        route = parsed.route;
                    }
                } catch (e) {
                    // Content might not be JSON or might be encrypted
                }
            }

            rides.push({
                id: event.id,
                pubkey: event.author.npub,
                hexPubkey: event.pubkey,
                time: event.created_at || Math.floor(Date.now() / 1000),
                distance,
                duration: durationStr,
                visibility,
                route,
                kind: 33301,
                title,
                description,
                image,
            });
        } catch (e) {
            console.warn("Failed to parse personal event", event.id);
        }
    }

    return rides.sort((a, b) => b.time - a.time);
}

/**
 * Retrieves the raw private key hex string for exporting.
 */
export async function getPrivateKeyHex(): Promise<string | null> {
    return await SecureStore.getItemAsync(SECURE_STORE_KEY);
}

export async function getPrivateKeyNsec(): Promise<string | null> {
    const hex = await getPrivateKeyHex();
    if (!hex) return null;
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    return nip19.nsecEncode(bytes);
}

export async function getPublicKeyNpub(): Promise<string | null> {
    const hex = await getPrivateKeyHex();
    if (!hex) return null;
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    return nip19.npubEncode(getPublicKey(bytes));
}

export async function getPublicKeyHex(): Promise<string | null> {
    const hex = await getPrivateKeyHex();
    if (!hex) return null;
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    return getPublicKey(bytes); // nostr-tools returns the hex pubkey directly
}

/**
 * Saves a new private key (importing an existing key).
 * Handles both nsec and raw hex formats.
 */
export async function setPrivateKey(keyStr: string): Promise<void> {
    let hexKey = keyStr;

    // Convert nsec to hex if needed
    if (keyStr.startsWith('nsec1')) {
        try {
            const decoded = nip19.decode(keyStr);
            if (decoded.type === 'nsec') {
                hexKey = bytesToHex(decoded.data as Uint8Array);
            } else {
                throw new Error();
            }
        } catch (e) {
            throw new Error("Invalid nsec provided.");
        }
    }

    // Basic validation (Nostr hex keys are 64 characters)
    if (!/^[0-9a-f]{64}$/i.test(hexKey)) {
        throw new Error("Invalid private key format. Must be an nsec or 64-character hex string.");
    }

    await SecureStore.setItemAsync(SECURE_STORE_KEY, hexKey);
    console.log("[Nostr] New private key saved.");

    // We need to re-initialize the signer with the new key
    if (globalNdk) {
        const secretKeyBytes = new Uint8Array(hexKey.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
        globalSigner = new NDKPrivateKeySigner(secretKeyBytes);
        globalNdk.signer = globalSigner;
    }
}

export interface ScheduledRideEvent {
    id: string;
    pubkey: string;
    hexPubkey: string;
    dTag: string;
    name: string;
    description: string;
    startTime: number;
    locationStr: string;
    createdAt: number;
    attendees: string[];
    kind: 31923;
    route?: number[][];
    timezone?: string;
    image?: string;
}

export interface ContestEvent {
    id: string;
    pubkey: string;
    hexPubkey: string;
    dTag: string;
    name: string;
    description: string;
    startTime: number;
    endTime: number;
    parameter: string;
    feeSats: number;
    invitedPubkeys: string[];
    createdAt: number;
    attendees: string[];
    kind: 31924;
}

export async function fetchRecentRides(): Promise<RideEvent[]> {
    const ndk = await connectNDK();
    const filters: NDKFilter[] = [
        {
            kinds: [33301 as any],
            limit: 100,
        }
    ];
    console.log("[Nostr] Fetching global Bikel rides...");
    const events = await ndk.fetchEvents(filters);

    const rides: RideEvent[] = [];
    for (const event of events) {
        const hasBikelClient = event.getMatchingTags("client").some(t => t[1] === "bikel");
        const hasCyclingTag = event.getMatchingTags("t").some(t => ["cycling", "bikel", "bikeride"].includes(t[1]));
        if (!hasBikelClient && !hasCyclingTag) continue;

        try {
            const distance = event.getMatchingTags("distance")[0]?.[1] || "0";
            const durationSecs = parseInt(event.getMatchingTags("duration")[0]?.[1] || "0", 10);
            const visibility = event.getMatchingTags("visibility")[0]?.[1] || "full";
            const title = event.getMatchingTags("title")[0]?.[1];
            const description = event.getMatchingTags("summary")[0]?.[1];
            const image = event.getMatchingTags("image")[0]?.[1];
            const mins = Math.floor(durationSecs / 60);
            const secs = durationSecs % 60;
            let route: number[][] = [];

            if (visibility === 'full' && event.content) {
                try {
                    const parsed = JSON.parse(event.content);
                    if (parsed.route && Array.isArray(parsed.route)) route = parsed.route;
                } catch (e) { }
            }

            rides.push({
                id: event.id,
                pubkey: event.author.npub,
                hexPubkey: event.pubkey,
                time: event.created_at || Math.floor(Date.now() / 1000),
                distance,
                duration: `${mins}m ${secs}s`,
                visibility,
                route,
                title,
                description,
                image,
                kind: 33301
            });
        } catch (e) {
            console.warn("Failed to parse a recent ride", event.id);
        }
    }
    return rides.sort((a, b) => b.time - a.time);
}

export async function fetchScheduledRides(): Promise<ScheduledRideEvent[]> {
    const ndk = await connectNDK();

    // Fetch both legacy Bikel events and any external NIP-52 cycling events
    const filters: NDKFilter[] = [
        {
            kinds: [31923 as any],
            limit: 100,
        }
    ];

    console.log("[Nostr] Fetching scheduled Bikel & Cycling rides (Kind 31923)...");
    const events = await ndk.fetchEvents(filters);

    const scheduledRides: ScheduledRideEvent[] = [];
    const aTagsToFetch: string[] = [];

    for (const event of events) {
        const hasBikelClient = event.getMatchingTags("client").some(t => t[1] === "bikel");
        const hasCyclingTag = event.getMatchingTags("t").some(t => ["cycling", "bikel", "bikeride"].includes(t[1]));
        if (!hasBikelClient && !hasCyclingTag) continue;

        try {
            const name = event.getMatchingTags("name")[0]?.[1] || "Untitled Ride";
            const startTime = parseInt(event.getMatchingTags("start")[0]?.[1] || "0", 10);
            const locationStr = event.getMatchingTags("location")[0]?.[1] || "TBD";
            const dTag = event.getMatchingTags("d")[0]?.[1];
            if (!dTag) continue;

            const aTag = `31923:${event.pubkey}:${dTag}`;
            aTagsToFetch.push(aTag);

            if (startTime > (Date.now() / 1000) - (86400 * 30)) { // show up to 30 days old just in case
                let parsedRoute: number[][] = [];
                const routeTag = event.getMatchingTags("route")[0]?.[1];
                if (routeTag) {
                    try { parsedRoute = JSON.parse(routeTag); } catch (e) { }
                }
                const tzTag = event.getMatchingTags("start_tz")[0]?.[1];
                const imageTag = event.getMatchingTags("image")[0]?.[1];

                scheduledRides.push({
                    id: event.id,
                    pubkey: event.author.npub,
                    hexPubkey: event.pubkey,
                    dTag,
                    name,
                    description: event.content || "",
                    startTime,
                    locationStr,
                    createdAt: event.created_at || Math.floor(Date.now() / 1000),
                    attendees: [],
                    kind: 31923,
                    route: parsedRoute,
                    timezone: tzTag,
                    image: imageTag
                });
            }
        } catch (e) { }
    }

    if (aTagsToFetch.length > 0) {
        const rsvpEvents = await ndk.fetchEvents({ kinds: [31925 as any], "#a": aTagsToFetch });
        for (const rsvp of rsvpEvents) {
            const aTagMatch = rsvp.getMatchingTags("a")[0]?.[1];
            if (aTagMatch && rsvp.getMatchingTags("l")[0]?.[1] === "accepted") {
                const ride = scheduledRides.find(r => `31923:${r.hexPubkey}:${r.dTag}` === aTagMatch);
                if (ride && !ride.attendees.includes(rsvp.pubkey)) ride.attendees.push(rsvp.pubkey);
            }
        }
    }
    return scheduledRides.sort((a, b) => a.startTime - b.startTime);
}

export async function publishRSVP(eventObj: ScheduledRideEvent | ContestEvent): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) return false;

    const event = new NDKEvent(ndk);
    event.kind = 31925;
    event.tags = [
        ['a', `${eventObj.kind}:${eventObj.hexPubkey}:${eventObj.dTag}`],
        ['l', 'accepted'],
        ['client', 'bikel']
    ];
    event.content = "";

    try {
        await event.publish();
        return true;
    } catch {
        return false;
    }
}

/**
 * Publishes a NIP-52 Calendar Event (Time-based, Kind 31923) for organizing a group ride
 */
export async function publishScheduledRide(
    name: string,
    description: string,
    startTimestamp: number,
    locationStr: string,
    routePoints?: { lat: number; lng: number }[]
): Promise<string> {
    const ndk = await connectNDK();
    const event = new NDKEvent(ndk);

    event.kind = 31923; // NIP-52 Date-Based Calendar Event

    // We need a unique 'd' tag to identify this specific event
    const dTag = `bikel-ride-${Date.now()}`;

    event.tags = [
        ['d', dTag],
        ['name', name],
        ['title', name],
        ['start', startTimestamp.toString()],
        ['location', locationStr],
        ['t', 'cycling'],
        ['t', 'bikel'],
        ['client', 'bikel'],
        ['image', 'https://bikel.com/bikelLogo.jpg']
    ];

    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) event.tags.push(['start_tz', tz]);
    } catch (e) { }

    if (routePoints && routePoints.length > 0) {
        const compressedGeo = routePoints.map(p => [Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6))]);
        event.tags.push(['route', JSON.stringify(compressedGeo)]);
    }

    event.content = description;

    console.log('[Nostr] Signing and publishing scheduled ride event...');
    await event.publish();
    console.log(`[Nostr] Scheduled ride published successfully! ID: ${event.id}`);

    return event.id;
}

/**
 * Publishes a NIP-52 style Contest Event (Kind 31924)
 * Supports varied parameters mapped to distance, speed, etc., entrance fees, and optional whitelisting via 'p' tags.
 */
export async function publishContestEvent(
    name: string,
    description: string,
    startTimestamp: number,
    endTimestamp: number,
    parameter: string, // e.g. "max_distance", "max_elevation"
    feeSats: number,
    invitedPubkeys: string[]
): Promise<string> {
    const ndk = await connectNDK();
    const event = new NDKEvent(ndk);

    event.kind = 31924;

    const dTag = `bikel-contest-${Date.now()}`;

    event.tags = [
        ['d', dTag],
        ['name', name],
        ['start', startTimestamp.toString()],
        ['end', endTimestamp.toString()],
        ['parameter', parameter],
        ['fee', feeSats.toString()],
        ['zap', ESCROW_PUBKEY, '1'],
        ['client', 'bikel'],
        ['t', 'cycling'],
        ['t', 'bikel']
    ];

    // If there are invited pubkeys, add them to restrict the contest
    for (const pubkey of invitedPubkeys) {
        event.tags.push(['p', pubkey]);
    }

    event.content = description;

    console.log('[Nostr] Signing and publishing contest event...');
    await event.publish();
    console.log(`[Nostr] Contest published successfully! ID: ${event.id}`);

    return event.id;
}

export async function fetchContests(): Promise<ContestEvent[]> {
    const ndk = await connectNDK();

    const filters: NDKFilter[] = [
        {
            kinds: [31924 as any],
            limit: 100,
        }
    ];

    console.log("[Nostr] Fetching active Contests (Kind 31924)...");
    const events = await Promise.race([
        ndk.fetchEvents(filters),
        new Promise<Set<NDKEvent>>((resolve) => setTimeout(() => resolve(new Set()), 5000))
    ]) as Set<NDKEvent>;

    const contests: ContestEvent[] = [];
    const aTagsToFetch: string[] = [];

    for (const event of events) {
        const hasBikelClient = event.getMatchingTags("client").some(t => t[1] === "bikel");
        const hasCyclingTag = event.getMatchingTags("t").some(t => ["cycling", "bikel"].includes(t[1]));
        if (!hasBikelClient && !hasCyclingTag) continue;

        try {
            const name = event.getMatchingTags("name")[0]?.[1] || "Untitled Contest";
            const startTime = parseInt(event.getMatchingTags("start")[0]?.[1] || "0", 10);
            const endTime = parseInt(event.getMatchingTags("end")[0]?.[1] || "0", 10);
            const parameter = event.getMatchingTags("parameter")[0]?.[1] || "max_distance";
            const feeSats = parseInt(event.getMatchingTags("fee")[0]?.[1] || "0", 10);
            const invitedPubkeys = event.getMatchingTags("p").map(t => t[1]);
            const dTag = event.getMatchingTags("d")[0]?.[1];
            if (!dTag) continue;

            const aTag = `31924:${event.pubkey}:${dTag}`;
            aTagsToFetch.push(aTag);

            if (endTime > (Date.now() / 1000) - 86400) { // Keep showing for a day after ending
                contests.push({
                    id: event.id,
                    pubkey: event.author.npub,
                    hexPubkey: event.pubkey,
                    dTag,
                    name,
                    description: event.content || "",
                    startTime,
                    endTime,
                    parameter,
                    feeSats,
                    invitedPubkeys,
                    createdAt: event.created_at || Math.floor(Date.now() / 1000),
                    attendees: [],
                    kind: 31924
                });
            }
        } catch (e) { }
    }

    if (aTagsToFetch.length > 0) {
        const rsvpEvents = await Promise.race([
            ndk.fetchEvents({ kinds: [31925 as any], "#a": aTagsToFetch }),
            new Promise<Set<NDKEvent>>((resolve) => setTimeout(() => resolve(new Set()), 3000))
        ]) as Set<NDKEvent>;
        for (const rsvp of rsvpEvents) {
            const aTagMatch = rsvp.getMatchingTags("a")[0]?.[1];
            if (aTagMatch && rsvp.getMatchingTags("l")[0]?.[1] === "accepted") {
                const contest = contests.find(c => `31924:${c.hexPubkey}:${c.dTag}` === aTagMatch);
                if (contest && !contest.attendees.includes(rsvp.pubkey)) contest.attendees.push(rsvp.pubkey);
            }
        }
    }

    // Most recently created first
    return contests.sort((a, b) => b.createdAt - a.createdAt);
}

export async function fetchRideLeaderboard(attendees: string[], startTime: number, endTime: number, parameter: string): Promise<{ pubkey: string, value: number }[]> {
    if (attendees.length === 0) return [];

    const ndk = await connectNDK();

    // Fetch all Kind 33301 rides from attendees that fall in the time window
    const filters: NDKFilter[] = [{
        kinds: [33301 as any],
        authors: attendees.map(a => a.startsWith("npub") ? new NDKUser({ npub: a }).pubkey : a),
        since: startTime,
        until: endTime
    }];

    console.log(`[Nostr] Fetching rides for Leaderboard calculation... Attendees: ${attendees.length}`);
    const events = await ndk.fetchEvents(filters);

    const scores: Record<string, number> = {};

    for (const event of events) {
        try {
            const distanceTag = event.getMatchingTags("distance")[0]?.[1];
            const durationTag = event.getMatchingTags("duration")[0]?.[1];
            if (!distanceTag || !durationTag) continue;

            const distance = parseFloat(distanceTag);
            const duration = parseInt(durationTag, 10);
            const pubkey = event.pubkey;

            if (parameter === "max_distance" || parameter === "max_elevation") {
                scores[pubkey] = (scores[pubkey] || 0) + distance; // Default elevation to distance sum if missing altitude logic
            } else if (parameter === "fastest_mile") {
                if (distance >= 1) { // minimum distance for fastest pace
                    const pace = distance / (duration / 3600); // mph
                    if (!scores[pubkey] || pace > scores[pubkey]) {
                        scores[pubkey] = pace;
                    }
                }
            }
        } catch (e) { }
    }

    const leaderboard = Object.keys(scores).map(pubkey => ({
        pubkey,
        value: scores[pubkey]
    }));

    return leaderboard.sort((a, b) => b.value - a.value);
}

export interface RideComment {
    id: string;
    pubkey: string;
    content: string;
    createdAt: number;
}

export async function fetchComments(eventId: string): Promise<RideComment[]> {
    const ndk = await connectNDK();
    const filter: NDKFilter = {
        kinds: [1],
        "#e": [eventId],
        limit: 100,
    };

    console.log(`[Nostr - Mobile] Fetching comments for event ${eventId}...`);
    const events = await ndk.fetchEvents(filter);

    const comments: RideComment[] = [];
    for (const event of events) {
        comments.push({
            id: event.id,
            pubkey: event.author?.npub || event.pubkey,
            content: event.content,
            createdAt: event.created_at || Math.floor(Date.now() / 1000)
        });
    }

    // Sort oldest first for comment threads
    return comments.sort((a, b) => a.createdAt - b.createdAt);
}

export async function publishComment(eventId: string, content: string): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) {
        console.error("Cannot publish comment without a signer");
        return false;
    }

    const event = new NDKEvent(ndk);
    event.kind = 1; // Standard Note
    event.content = content;
    // NIP-10 standard reply tags
    event.tags = [
        ['e', eventId, '', 'reply'],
        ['client', 'bikel']
    ];

    console.log('[Nostr - Mobile] Signing and publishing Comment event...');
    try {
        await event.publish();
        console.log(`[Nostr - Mobile] Comment published! ID: ${event.id}`);
        return true;
    } catch (e) {
        console.error("[Nostr - Mobile] Failed to publish comment", e);
        return false;
    }
}

export interface DMessage {
    id: string;
    sender: string;
    recipient: string;
    text: string;
    createdAt: number;
}

export async function fetchDMs(withPubkey: string): Promise<DMessage[]> {
    const ndk = await connectNDK();
    if (!ndk.signer) throw new Error("Must be signed in to view DMs");

    // Fallback to fetch current user pubkey since signer.user() might not resolve instantly on mobile depending on implementation
    const currentUser = await ndk.signer.user();

    console.log(`[Nostr - Mobile] Fetching DMs between ${currentUser.pubkey} and ${withPubkey}...`);

    const filterSent: NDKFilter = {
        kinds: [4],
        authors: [currentUser.pubkey],
        "#p": [withPubkey],
        limit: 50,
    };
    const filterReceived: NDKFilter = {
        kinds: [4],
        authors: [withPubkey],
        "#p": [currentUser.pubkey],
        limit: 50,
    };

    const events = await ndk.fetchEvents([filterSent, filterReceived]);
    const messages: DMessage[] = [];

    const otherUser = ndk.getUser({ pubkey: withPubkey });

    for (const event of events) {
        try {
            await event.decrypt(currentUser.pubkey === event.pubkey ? otherUser : currentUser);
            messages.push({
                id: event.id,
                sender: event.pubkey,
                recipient: event.getMatchingTags('p')[0]?.[1] || '',
                text: event.content,
                createdAt: event.created_at || Math.floor(Date.now() / 1000)
            });
        } catch (e) {
            console.warn(`[Nostr - Mobile] Failed to decrypt DM ${event.id}`, e);
        }
    }

    return messages.sort((a, b) => a.createdAt - b.createdAt);
}

export async function sendDM(toPubkey: string, text: string): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) throw new Error("Must be signed in to send DMs");

    const recipient = ndk.getUser({ pubkey: toPubkey });

    const event = new NDKEvent(ndk);
    event.kind = 4; // NIP-04 Direct Message
    event.content = text;
    event.tags = [['p', toPubkey]];

    console.log('[Nostr - Mobile] Encrypting and publishing DM...');
    try {
        await event.encrypt(recipient); // NDK automagically uses the signer
        await event.publish();
        console.log(`[Nostr - Mobile] DM sent! ID: ${event.id}`);
        return true;
    } catch (e) {
        console.error("[Nostr - Mobile] Failed to send DM", e);
        return false;
    }
}

