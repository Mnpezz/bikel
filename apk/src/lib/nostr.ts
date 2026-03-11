import 'react-native-get-random-values';
import { TextEncoder, TextDecoder } from 'text-encoding';
import NDK, { NDKNip07Signer, NDKEvent, NDKPrivateKeySigner, NDKUser, NDKZapper, NDKBlossomList } from "@nostr-dev-kit/ndk";
import { NDKBlossom } from "@nostr-dev-kit/ndk-blossom";
import type { NDKFilter } from "@nostr-dev-kit/ndk";
// @ts-ignore - Types missing upstream
import { NDKNWCWallet } from "@nostr-dev-kit/ndk-wallet";
import * as SecureStore from 'expo-secure-store';
import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { Buffer } from 'buffer';
import * as Crypto from 'expo-crypto';
import type { SHA256Calculator } from "@nostr-dev-kit/ndk-blossom";

/**
 * Custom SHA256 calculator for React Native using expo-crypto.
 * The default implementation uses crypto.subtle which is often missing in RN.
 */
class ReactNativeSHA256Calculator implements SHA256Calculator {
    async calculateSha256(file: File | Blob | Uint8Array): Promise<string> {
        let bytes: Uint8Array;
        if (file instanceof Uint8Array) {
            bytes = file;
        } else if (file && typeof file === 'object' && 'arrayBuffer' in (file as any)) {
            const buffer = await (file as any).arrayBuffer();
            bytes = new Uint8Array(buffer);
        } else {
            throw new Error('Unsupported file type for SHA256 calculation');
        }

        const hashBuffer = await Crypto.digest(
            Crypto.CryptoDigestAlgorithm.SHA256,
            bytes as any
        );
        return Buffer.from(hashBuffer).toString('hex');
    }
}

// Polyfill for React Native crypto
if (typeof global.TextEncoder === 'undefined') {
    global.TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
    global.TextDecoder = TextDecoder as any;
}

// Polyfill for btoa/atob (required by Blossom auth)
if (typeof global.btoa === 'undefined') {
    global.btoa = (str: string) => Buffer.from(str, 'utf8').toString('base64');
}
if (typeof global.atob === 'undefined') {
    global.atob = (str: string) => Buffer.from(str, 'base64').toString('utf8');
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
    // connect() resolves before relays finish the WebSocket handshake.
    // Wait for at least one relay to be ready before returning, max 3s.
    await new Promise<void>(resolve => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        globalNdk!.pool.on('relay:ready', done);
        setTimeout(done, 3000);
    });
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
        const pointsPerMile = routePoints.length / distanceMiles;
        if (pointsPerMile < 2) {
            baseConfidence -= 0.6; // Extremely sparse, likely a spoof or start/stop only
        } else if (pointsPerMile < 5) {
            baseConfidence -= 0.3; // Very sparse
        }
    } else {
        baseConfidence -= 0.9;
    }

    return Math.max(0, Math.min(1.0, baseConfidence));
}

/**
 * Publishes a completed ride to Nostr as Kind 33301.
 */
export async function publishRide(
    distanceMiles: number,
    durationSeconds: number,
    routePoints: { lat: number; lng: number }[],
    visibility: 'full' | 'blurred' | 'hidden' = 'full',
    title: string = "",
    description: string = "",
    image: string = "",
    overrideConfidence?: number
) {
    const ndk = await connectNDK();
    const event = new NDKEvent(ndk);
    event.kind = 33301;

    const confidence = overrideConfidence !== undefined
        ? overrideConfidence
        : calculateRideConfidence(distanceMiles, durationSeconds, routePoints);

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

    if (visibility === 'full' && routePoints.length > 0) {
        const step = Math.ceil(routePoints.length / 1000);
        const compressedGeo = routePoints
            .filter((_, index) => index % step === 0 || index === routePoints.length - 1)
            .map(p => [Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6))]);
        event.content = JSON.stringify({ route: compressedGeo });
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
        // @ts-ignore
        nwcWallet = new NDKNWCWallet(ndk, { pairingCode });
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject("NWC connection timeout"), 10000);
            nwcWallet!.once("ready", () => { clearTimeout(timeout); resolve(); });
        });
        // @ts-ignore
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
    if (!currentWallet) throw new Error("No Lightning Wallet Connected");

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
        zapper.on("notice", (msg) => { console.log("[Zap Notice]", msg); lastNotice = msg; });
        zapper.zap().catch(e => console.warn(`[Zap - Mobile] Background Zap Promise Rejection (Ignored):`, e));
        console.log(`[Zap - Mobile] Payment dispatched. Returning Pseudo-Success.`);
        return true;
    } catch (e: any) {
        console.error("[Zap - Mobile] Failed to zap event", e);
        if (lastNotice) throw new Error(`Lightning node error: ${lastNotice}`);
        else if (e.message?.includes("All zap attempts failed")) throw new Error("This rider has not linked a Lightning Address to their Nostr profile!");
        else throw e;
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
    route: number[][];
    title?: string;
    description?: string;
    image?: string;
    kind: 33301;
    confidence?: number;
}

export async function fetchMyRides(): Promise<RideEvent[]> {
    const ndk = await connectNDK();
    const signer = await getSigner();
    const user = await signer.user();

    const filter = { kinds: [33301 as any], authors: [user.pubkey], limit: 50 };
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
            const confidenceRaw = event.getMatchingTags("confidence")[0]?.[1];
            const confidence = confidenceRaw ? parseFloat(confidenceRaw) : undefined;
            const mins = Math.floor(durationSecs / 60);
            const secs = durationSecs % 60;
            let route: number[][] = [];
            if (visibility === 'full' && event.content) {
                try { const parsed = JSON.parse(event.content); if (parsed.route && Array.isArray(parsed.route)) route = parsed.route; } catch (e) { }
            }
            rides.push({ id: event.id, pubkey: event.author.npub, hexPubkey: event.pubkey, time: event.created_at || Math.floor(Date.now() / 1000), distance, duration: `${mins}m ${secs}s`, visibility, route, kind: 33301, title, description, image, confidence });
        } catch (e) { console.warn("Failed to parse personal event", event.id); }
    }
    return rides.sort((a, b) => b.time - a.time);
}

export async function fetchUserRides(targetPubkey: string): Promise<RideEvent[]> {
    const ndk = await connectNDK();
    const filter = { kinds: [33301 as any], authors: [targetPubkey], limit: 50 };
    console.log(`[Nostr] Fetching rides for user: ${targetPubkey.substring(0, 8)}`);
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
            const confidenceRaw = event.getMatchingTags("confidence")[0]?.[1];
            const confidence = confidenceRaw ? parseFloat(confidenceRaw) : undefined;
            const mins = Math.floor(durationSecs / 60);
            const secs = durationSecs % 60;
            let route: number[][] = [];
            if (visibility === 'full' && event.content) {
                try { const parsed = JSON.parse(event.content); if (parsed.route && Array.isArray(parsed.route)) route = parsed.route; } catch (e) { }
            }
            rides.push({ id: event.id, pubkey: event.author.npub, hexPubkey: event.pubkey, time: event.created_at || Math.floor(Date.now() / 1000), distance, duration: `${mins}m ${secs}s`, visibility, route, kind: 33301, title, description, image, confidence });
        } catch (e) { console.warn("Failed to parse user event", event.id); }
    }
    return rides.sort((a, b) => b.time - a.time);
}

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
    return getPublicKey(bytes);
}

export async function setPrivateKey(keyStr: string): Promise<void> {
    let hexKey = keyStr;
    if (keyStr.startsWith('nsec1')) {
        try {
            const decoded = nip19.decode(keyStr);
            if (decoded.type === 'nsec') hexKey = bytesToHex(decoded.data as Uint8Array);
            else throw new Error();
        } catch (e) { throw new Error("Invalid nsec provided."); }
    }
    if (!/^[0-9a-f]{64}$/i.test(hexKey)) throw new Error("Invalid private key format. Must be an nsec or 64-character hex string.");
    await SecureStore.setItemAsync(SECURE_STORE_KEY, hexKey);
    console.log("[Nostr] New private key saved.");
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
    distance?: string;
    duration?: string;
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
    kind: 33401; // ← updated from 31924
}

export async function fetchRecentRides(): Promise<RideEvent[]> {
    const ndk = await connectNDK();
    const filters: NDKFilter[] = [{ kinds: [33301 as any], limit: 100 }];
    console.log("[Nostr] Fetching global Bikel rides...");
    const events = await Promise.race([
        ndk.fetchEvents(filters),
        new Promise<Set<NDKEvent>>((resolve) => setTimeout(() => resolve(new Set()), 8000))
    ]) as Set<NDKEvent>;
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
            const confidenceRaw = event.getMatchingTags("confidence")[0]?.[1];
            const confidence = confidenceRaw ? parseFloat(confidenceRaw) : undefined;
            const mins = Math.floor(durationSecs / 60);
            const secs = durationSecs % 60;
            let route: number[][] = [];
            if (visibility === 'full' && event.content) {
                try { const parsed = JSON.parse(event.content); if (parsed.route && Array.isArray(parsed.route)) route = parsed.route; } catch (e) { }
            }
            rides.push({ id: event.id, pubkey: event.author.npub, hexPubkey: event.pubkey, time: event.created_at || Math.floor(Date.now() / 1000), distance, duration: `${mins}m ${secs}s`, visibility, route, title, description, image, kind: 33301, confidence });
        } catch (e) { console.warn("Failed to parse a recent ride", event.id); }
    }
    return rides.sort((a, b) => b.time - a.time);
}

export async function fetchScheduledRides(): Promise<ScheduledRideEvent[]> {
    const ndk = await connectNDK();
    const filters: NDKFilter[] = [{ kinds: [31923 as any], limit: 100 }];
    console.log("[Nostr] Fetching scheduled rides (Kind 31923)...");
    const events = await Promise.race([
        ndk.fetchEvents(filters),
        new Promise<Set<NDKEvent>>((resolve) => setTimeout(() => resolve(new Set()), 6000))
    ]) as Set<NDKEvent>;

    const scheduledRides: ScheduledRideEvent[] = [];
    const aTagsToFetch: string[] = [];

    for (const event of events) {
        const hasBikelClient = event.getMatchingTags("client").some(t => t[1] === "bikel");
        const hasCyclingTag = event.getMatchingTags("t").some(t => ["cycling", "bikel", "bikeride"].includes(t[1]));
        if (!hasBikelClient && !hasCyclingTag) continue;
        try {
            const name = event.getMatchingTags("name")[0]?.[1] || event.getMatchingTags("title")[0]?.[1] || "Untitled Ride";
            const startTime = parseInt(event.getMatchingTags("start")[0]?.[1] || "0", 10);
            const locationStr = event.getMatchingTags("location")[0]?.[1] || "TBD";
            const dTag = event.getMatchingTags("d")[0]?.[1];
            if (!dTag) continue;
            const aTag = `31923:${event.pubkey}:${dTag}`;
            aTagsToFetch.push(aTag);
            if (startTime > (Date.now() / 1000) - (86400 * 30)) {
                let parsedRoute: number[][] = [];
                const routeTag = event.getMatchingTags("route")[0]?.[1];
                if (routeTag) { try { parsedRoute = JSON.parse(routeTag); } catch (e) { } }
                scheduledRides.push({
                    id: event.id, pubkey: event.author.npub, hexPubkey: event.pubkey, dTag, name,
                    description: event.content || "", startTime, locationStr,
                    createdAt: event.created_at || Math.floor(Date.now() / 1000), attendees: [],
                    route: parsedRoute,
                    timezone: event.getMatchingTags("start_tz")[0]?.[1],
                    image: event.getMatchingTags("image")[0]?.[1],
                    distance: event.getMatchingTags("distance")[0]?.[1],
                    duration: event.getMatchingTags("duration")[0]?.[1],
                    kind: 31923
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
    try { await event.publish(); return true; } catch { return false; }
}

export async function publishScheduledRide(
    name: string, description: string, startTimestamp: number, locationStr: string,
    routePoints?: { lat: number; lng: number }[], imageUrl?: string, distance?: number, duration?: number
): Promise<string> {
    const ndk = await connectNDK();
    const event = new NDKEvent(ndk);
    event.kind = 31923;
    const dTag = `bikel-ride-${Date.now()}`;
    event.tags = [
        ['d', dTag], ['name', name], ['title', name],
        ['start', startTimestamp.toString()], ['location', locationStr],
        ['t', 'cycling'], ['t', 'bikel'], ['client', 'bikel'],
    ];
    if (imageUrl) event.tags.push(['image', imageUrl]);
    if (distance !== undefined) event.tags.push(['distance', distance.toString()]);
    if (duration !== undefined) {
        const h = Math.floor(duration / 3600); const m = Math.floor((duration % 3600) / 60); const s = duration % 60;
        event.tags.push(['duration', h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`]);
    }
    try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (tz) event.tags.push(['start_tz', tz]); } catch (e) { }
    if (routePoints && routePoints.length > 0) {
        const compressedGeo = routePoints.map(p => [Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6))]);
        event.tags.push(['route', JSON.stringify(compressedGeo)]);
    }
    event.content = description;
    console.log('[Nostr] Publishing scheduled ride event...');
    await event.publish();
    console.log(`[Nostr] Scheduled ride published! ID: ${event.id}`);
    return event.id;
}

/**
 * Deletes a ride event using NIP-09 (Kind 5).
 */
export async function deleteRideEvent(ride: ScheduledRideEvent): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) return false;

    const event = new NDKEvent(ndk);
    event.kind = 5;
    event.content = "Ride deleted by organizer";
    event.tags = [
        ['e', ride.id],
        ['a', `31923:${ride.hexPubkey}:${ride.dTag}`],
        ['k', '31923']
    ];

    try {
        console.log(`[Nostr] Deleting ride ${ride.id}...`);
        await event.publish();
        return true;
    } catch (e) {
        console.error('[Nostr] Error deleting ride:', e);
        return false;
    }
}

/**
 * Publishes a Bikel Challenge Event (Kind 33401).
 * Self-describing protocol: escrow pubkey, payout split, sport, and unit are
 * all embedded in the event so any compatible bot can process it without
 * reading Bikel source code.
 */
export async function publishContestEvent(
    name: string,
    description: string,
    startTimestamp: number,
    endTimestamp: number,
    parameter: string,   // "max_distance" | "max_elevation" | "fastest_mile"
    feeSats: number,
    invitedPubkeys: string[],
    sport: string = "cycling",
    unit: string = "imperial",
    payoutSplit: [number, number, number] = [50, 30, 20],
    minConfidence: number = 0.7,
    prizeSats?: number
): Promise<string> {
    const ndk = await connectNDK();
    const event = new NDKEvent(ndk);

    event.kind = 33401; // ← Bikel custom challenge kind

    const dTag = `bikel-challenge-${Date.now()}`;

    event.tags = [
        ['d', dTag],
        ['title', name],
        ['start', startTimestamp.toString()],
        ['end', endTimestamp.toString()],
        ['parameter', parameter],
        ['sport', sport],
        ['unit', unit],
        ['fee', feeSats.toString()],
        ['escrow', ESCROW_PUBKEY],
        ['payout', ...payoutSplit.map(String)],
        ['min_confidence', minConfidence.toFixed(1)],
        ['client', 'bikel'],
        ['t', 'bikel-challenge'],
        ['t', 'bikel'],
    ];

    if (prizeSats !== undefined) {
        event.tags.push(['prize', prizeSats.toString()]);
    }

    for (const pubkey of invitedPubkeys) {
        event.tags.push(['p', pubkey]);
    }

    event.content = description;

    console.log('[Nostr] Publishing challenge event (Kind 33401)...');
    await event.publish();
    console.log(`[Nostr] Challenge published! ID: ${event.id}`);
    return event.id;
}

export async function fetchContests(): Promise<ContestEvent[]> {
    const ndk = await connectNDK();

    const filters: NDKFilter[] = [{ kinds: [33401 as any], limit: 100 }];

    console.log("[Nostr] Fetching Bikel Challenges (Kind 33401)...");
    const events = await Promise.race([
        ndk.fetchEvents(filters),
        new Promise<Set<NDKEvent>>((resolve) => setTimeout(() => resolve(new Set()), 5000))
    ]) as Set<NDKEvent>;

    const contests: ContestEvent[] = [];
    const aTagsToFetch: string[] = [];

    for (const event of events) {
        const hasBikelClient = event.getMatchingTags("client").some(t => t[1] === "bikel");
        const hasChallengeTag = event.getMatchingTags("t").some(t => ["bikel-challenge", "bikel"].includes(t[1]));
        if (!hasBikelClient && !hasChallengeTag) continue;

        try {
            const name = event.getMatchingTags("title")[0]?.[1] || "Untitled Challenge";
            const startTime = parseInt(event.getMatchingTags("start")[0]?.[1] || "0", 10);
            const endTime = parseInt(event.getMatchingTags("end")[0]?.[1] || "0", 10);
            const parameter = event.getMatchingTags("parameter")[0]?.[1] || "max_distance";
            const feeSats = parseInt(event.getMatchingTags("fee")[0]?.[1] || "0", 10);
            const invitedPubkeys = event.getMatchingTags("p").map(t => t[1]);
            const dTag = event.getMatchingTags("d")[0]?.[1];
            if (!dTag) continue;

            const aTag = `33401:${event.pubkey}:${dTag}`;
            aTagsToFetch.push(aTag);

            if (endTime > (Date.now() / 1000) - 86400) {
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
                    kind: 33401
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
                const contest = contests.find(c => `33401:${c.hexPubkey}:${c.dTag}` === aTagMatch);
                if (contest && !contest.attendees.includes(rsvp.pubkey)) contest.attendees.push(rsvp.pubkey);
            }
        }
    }

    return contests.sort((a, b) => b.createdAt - a.createdAt);
}

export async function fetchRideLeaderboard(attendees: string[], startTime: number, endTime: number, parameter: string): Promise<{ pubkey: string, value: number }[]> {
    if (attendees.length === 0) return [];
    const ndk = await connectNDK();
    const filters: NDKFilter[] = [{
        kinds: [33301 as any],
        authors: attendees.map(a => a.startsWith("npub") ? new NDKUser({ npub: a }).pubkey : a),
        since: startTime,
        until: endTime
    }];
    console.log(`[Nostr] Fetching rides for leaderboard... Attendees: ${attendees.length}`);
    const events = await Promise.race([
        ndk.fetchEvents(filters),
        new Promise<Set<NDKEvent>>((resolve) => setTimeout(() => resolve(new Set()), 8000))
    ]) as Set<NDKEvent>;
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
                scores[pubkey] = (scores[pubkey] || 0) + distance;
            } else if (parameter === "fastest_mile") {
                if (distance >= 1) {
                    const pace = distance / (duration / 3600);
                    if (!scores[pubkey] || pace > scores[pubkey]) scores[pubkey] = pace;
                }
            }
        } catch (e) { }
    }

    return Object.keys(scores).map(pubkey => ({ pubkey, value: scores[pubkey] })).sort((a, b) => b.value - a.value);
}

export interface RideComment {
    id: string;
    pubkey: string;
    hexPubkey?: string;
    content: string;
    createdAt: number;
}

export async function fetchComments(eventId: string): Promise<RideComment[]> {
    const ndk = await connectNDK();
    const filter: NDKFilter = { kinds: [1], "#e": [eventId], limit: 100 };
    console.log(`[Nostr - Mobile] Fetching comments for event ${eventId}...`);
    const events = await Promise.race([
        ndk.fetchEvents(filter),
        new Promise<Set<NDKEvent>>((resolve) => setTimeout(() => resolve(new Set()), 5000))
    ]) as Set<NDKEvent>;
    const comments: RideComment[] = [];
    for (const event of events) {
        comments.push({ id: event.id, pubkey: event.author?.npub || event.pubkey, hexPubkey: event.pubkey, content: event.content, createdAt: event.created_at || Math.floor(Date.now() / 1000) });
    }
    return comments.sort((a, b) => a.createdAt - b.createdAt);
}

export async function publishComment(eventId: string, content: string): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) return false;
    const event = new NDKEvent(ndk);
    event.kind = 1;
    event.content = content;
    event.tags = [['e', eventId, '', 'reply'], ['client', 'bikel']];
    try { await event.publish(); return true; } catch (e) { console.error("[Nostr - Mobile] Failed to publish comment", e); return false; }
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
    const currentUser = await ndk.signer.user();
    let hexPubkey = withPubkey;
    let otherUser: NDKUser;
    if (withPubkey.startsWith('npub1')) { otherUser = ndk.getUser({ npub: withPubkey }); hexPubkey = otherUser.pubkey; }
    else { otherUser = ndk.getUser({ pubkey: withPubkey }); }
    const filterSent: NDKFilter = { kinds: [4], authors: [currentUser.pubkey], "#p": [hexPubkey], limit: 50 };
    const filterReceived: NDKFilter = { kinds: [4], authors: [hexPubkey], "#p": [currentUser.pubkey], limit: 50 };
    const events = await Promise.race([
        ndk.fetchEvents([filterSent, filterReceived]),
        new Promise<Set<NDKEvent>>((resolve) => setTimeout(() => resolve(new Set()), 8000))
    ]) as Set<NDKEvent>;
    const messages: DMessage[] = [];
    for (const event of events) {
        try {
            await event.decrypt(otherUser, ndk.signer, 'nip04');
            messages.push({ id: event.id, sender: event.pubkey, recipient: event.getMatchingTags('p')[0]?.[1] || '', text: event.content, createdAt: event.created_at || Math.floor(Date.now() / 1000) });
        } catch (e) { console.warn(`[Nostr - Mobile] Failed to decrypt DM ${event.id}`, e); }
    }
    return messages.sort((a, b) => a.createdAt - b.createdAt);
}

export async function sendDM(toPubkey: string, text: string): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) throw new Error("Must be signed in to send DMs");
    let hexPubkey = toPubkey;
    let recipient: NDKUser;
    if (toPubkey.startsWith('npub1')) { recipient = ndk.getUser({ npub: toPubkey }); hexPubkey = recipient.pubkey; }
    else { recipient = ndk.getUser({ pubkey: toPubkey }); }
    const event = new NDKEvent(ndk);
    event.kind = 4;
    event.content = text;
    event.tags = [['p', hexPubkey]];
    try { await event.encrypt(recipient, ndk.signer, 'nip04'); await event.publish(); return true; }
    catch (e) { console.error("[Nostr - Mobile] Failed to send DM", e); return false; }
}

export interface EditableProfile {
    name?: string;
    about?: string;
    picture?: string;
    nip05?: string;
    lud16?: string;
}

export async function publishProfile(updates: EditableProfile): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) throw new Error("Must be signed in to edit profile");
    const user = await ndk.signer.user();
    const existingEvents = await ndk.fetchEvents({ kinds: [0 as any], authors: [user.pubkey] });
    let currentProfile: any = {};
    if (existingEvents.size > 0) {
        const sorted = Array.from(existingEvents).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        try { currentProfile = JSON.parse(sorted[0].content); } catch (e) { }
    }
    const event = new NDKEvent(ndk);
    event.kind = 0;
    event.content = JSON.stringify({ ...currentProfile, ...updates });
    try { await event.publish(); return true; }
    catch (e) { console.error("[Nostr - Mobile] Failed to publish profile update", e); return false; }
}

// ── Blossom image upload via NDKBlossom ──────────────────────────────────�// using NDKBlossom which handles auth signing and server selection.
export async function uploadPhoto(uri: string): Promise<string> {
    const ndk = await connectNDK();

    // 1. Get base64 string using ImageManipulator
    console.log('[Bikel-Photo-v4] Converting to base64...');
    const result = await ImageManipulator.manipulateAsync(
        uri,
        [],
        { base64: true, format: ImageManipulator.SaveFormat.JPEG }
    );

    if (!result.base64) throw new Error('Failed to capture image data (base64 empty).');
    console.log('[Bikel-Photo-v4] Base64 length:', result.base64.length);

    // 2. Decode base64 to Uint8Array for hashing
    console.log('[Bikel-Photo-v7] Decoding base64 for hash...');
    const bytes = Buffer.from(result.base64, 'base64');

    // 3. Calculate SHA256 manually using expo-crypto (native)
    const hashBuffer = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as any);
    const hash = Buffer.from(hashBuffer).toString('hex');
    // 4. v13 Fix: Use the Buffer (Uint8Array) directly as the fetch body
    // This bypasses both the crashing FileSystem.uploadAsync AND the unreliable fetch(localUri)
    console.log('[Bikel-Photo-v13] Using memory buffer for upload. Size:', bytes.length);

    const servers = [
        'https://blossom.band',
        'https://blossom.nostr.build',
        'https://blosstr.com',
        'https://blossom.primal.net',
        'https://cdn.satellite.earth',
        'https://nostr.download',
        'https://mibo.us.nostria.app'
    ];

    const failures: string[] = [];

    for (const server of servers) {
        try {
            console.log(`[Bikel-Photo-v13] Trying ${server}...`);
            const baseUrl = server.replace(/\/$/, '');
            const putHashUrl = `${baseUrl}/${hash}`;
            
            // 5. Create Blossom Auth Event (MUST be signed per URL for NIP-98 compliance)
            const authEvent = new NDKEvent(ndk);
            authEvent.kind = 24242; // Blossom Blob Auth
            authEvent.created_at = Math.floor(Date.now() / 1000);
            authEvent.content = "Upload upload.jpg";
            authEvent.tags = [
                ["t", "upload"],
                ["x", hash],
                ["u", putHashUrl],
                ["method", "PUT"],
                ["expiration", (Math.floor(Date.now() / 1000) + 3600).toString()],
            ];
            await authEvent.sign();
            const authHeader = `Nostr ${global.btoa(JSON.stringify(authEvent.rawEvent()))}`;

            const commonHeaders: Record<string, string> = {
                'Content-Type': 'image/jpeg',
                'X-SHA-256': hash,
                'X-Content-Type': 'image/jpeg',
                'X-Content-Length': bytes.length.toString(),
            };

            // Blossom standard BUD-01 is PUT /<hash>
            let response = await fetch(putHashUrl, {
                method: 'PUT',
                body: bytes, // Uint8Array works in fetch
                headers: {
                    ...commonHeaders,
                    'Authorization': authHeader
                }
            });

            // If that fails, try /upload endpoint (used by some implementations)
            if (response.status < 200 || response.status >= 300) {
                const xReason = response.headers.get('x-reason') || 'No reason given';
                console.log(`[Bikel-Photo-v13] PUT /${hash} at ${server} failed (${response.status}): ${xReason}. Trying /upload...`);
                
                const uploadUrl = `${baseUrl}/upload`;
                // Re-sign for new URL
                const authEventUpload = new NDKEvent(ndk);
                authEventUpload.kind = 24242;
                authEventUpload.created_at = Math.floor(Date.now() / 1000);
                authEventUpload.content = "Upload upload.jpg";
                authEventUpload.tags = [
                    ["t", "upload"],
                    ["x", hash],
                    ["u", uploadUrl],
                    ["method", "PUT"],
                    ["expiration", (Math.floor(Date.now() / 1000) + 3600).toString()],
                ];
                await authEventUpload.sign();
                const authHeaderUpload = `Nostr ${global.btoa(JSON.stringify(authEventUpload.rawEvent()))}`;

                response = await fetch(uploadUrl, {
                    method: 'PUT',
                    body: bytes,
                    headers: {
                        ...commonHeaders,
                        'Authorization': authHeaderUpload
                    }
                });
            }

            if (response.status >= 200 && response.status < 300) {
                console.log(`[Bikel-Photo-v13] SUCCESS on ${server}`);
                try {
                    const data = await response.json();
                    if (data.url) return data.url;
                } catch (e) { }
                
                // Fallback: standard Blossom URL is server/hash
                return `${baseUrl}/${hash}`;
            } else {
                const xReason = response.headers.get('x-reason') || 'No reason given';
                const bodyText = await response.text().catch(() => '');
                const errorDetail = `Server ${server} (${response.status}): ${xReason}. Body: ${bodyText.substring(0, 50)}`;
                console.warn(`[Bikel-Photo-v13] Fail: ${errorDetail}`);
                failures.push(errorDetail);
            }
        } catch (e: any) {
            console.warn(`[Bikel-Photo-v13] Upload error on ${server}:`, e.message);
            failures.push(`${server}: ${e.message}`);
        }
    }

    const finalError = failures.length > 0 
        ? `Upload failed. Rejection reasons:\n${failures.slice(0, 3).join('\n')}`
        : 'All Blossom servers failed even with Fetch upload. Check your connection.';
    
    throw new Error(finalError);
}
