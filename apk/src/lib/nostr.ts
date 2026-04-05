import 'react-native-get-random-values';
import { TextEncoder, TextDecoder } from 'text-encoding';
import NDK, { NDKNip07Signer, NDKEvent, NDKPrivateKeySigner, NDKUser, NDKZapper, NDKFilter, NDKSubscription } from "@nostr-dev-kit/ndk";
import type { SHA256Calculator } from "@nostr-dev-kit/ndk-blossom";
// @ts-ignore - Types missing upstream
import { NDKNWCWallet } from "@nostr-dev-kit/ndk-wallet";
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImageManipulator from 'expo-image-manipulator';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { Buffer } from 'buffer';
import * as Crypto from 'expo-crypto';


export const BIKEL_GLOBAL_CHANNEL_ID = "0fff30d212cd17652df10f9ef9dc8881a74d07d6cfb9c565ace32ba2eb519bd7";

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
    'wss://relay.bikel.ink',
    'wss://relay.damus.io',
    'wss://relay.primal.net',
    'wss://nos.lol'
];

export const AUTH_METHOD_KEY = 'bikel_auth_method';
export const AMBER_PUBKEY_KEY = 'bikel_amber_pubkey';

// Relays that support NIP-50 full-text search (search field in REQ filters).
// These are added to the pool specifically for fetchAllBikelSocial search queries.
// Regular relays silently ignore the search field, so it's safe to include both.
export const NIP50_RELAYS = [
    'wss://relay.primal.net',
    'wss://relay.nostr.wine',
    'wss://noswhere.com',
    'wss://relay.damus.io',
    'wss://relay.snort.social',
    'wss://purplepag.es'
];

export const RELAYS_STORAGE_KEY = 'bikel_custom_relays';

export async function getRelays(): Promise<string[]> {
    try {
        const stored = await AsyncStorage.getItem(RELAYS_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch (e) { console.error('[Nostr] Failed to load custom relays:', e); }
    return DEFAULT_RELAYS;
}

export async function saveRelays(relays: string[]): Promise<void> {
    try {
        await AsyncStorage.setItem(RELAYS_STORAGE_KEY, JSON.stringify(relays));
        // Reset NDK instance to force reconnect with new relays next time
        globalNdk = null;
    } catch (e) { console.error('[Nostr] Failed to save custom relays:', e); }
}

export const ESCROW_PUBKEY = "cc130b7120d00ded76d065bf0bd27e3a36a38d5268208078a1e99aa29ac44adf";

let globalNdk: NDK | null = null;
let globalSigner: (NDKPrivateKeySigner | AmberSigner) | null = null;
let globalNdkPromise: Promise<NDK> | null = null;

import { AmberSigner } from './AmberSigner';

// Convert Uint8Array to Hex String
const bytesToHex = (bytes: Uint8Array) =>
    bytes.reduce((str, byte) => str + byte.toString(16).padStart(2, '0'), '');

/**
 * Initializes a Nostr Keypair. Loads from SecureStore, or generates a new one.
 * If the user has opted for Amber, returns an AmberSigner.
 */
export async function getSigner(): Promise<NDKPrivateKeySigner | AmberSigner> {
    if (globalSigner) return globalSigner;

    const authMethod = await SecureStore.getItemAsync(AUTH_METHOD_KEY);
    
    if (authMethod === 'amber') {
        const pubkey = await SecureStore.getItemAsync(AMBER_PUBKEY_KEY);
        console.log('[Nostr] Initializing AmberSigner with pubkey:', pubkey);
        globalSigner = new AmberSigner(pubkey || undefined);
        return globalSigner;
    }

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
 * Switches the app to use Amber for signing.
 */
export async function useAmberSigner(pubkey: string) {
    await SecureStore.setItemAsync(AUTH_METHOD_KEY, 'amber');
    await SecureStore.setItemAsync(AMBER_PUBKEY_KEY, pubkey);
    globalSigner = new AmberSigner(pubkey);
    globalNdk = null; // Reset NDK to use the new signer
}

/**
 * Switches the app to use the local private key for signing.
 */
export async function useLocalSigner() {
    await SecureStore.setItemAsync(AUTH_METHOD_KEY, 'local');
    globalSigner = null;
    globalNdk = null; // Reset NDK
}

/**
 * Initializes and connects to the global NDK instance with a singleton lock.
 */
export async function connectNDK(): Promise<NDK> {
    if (globalNdk && globalNdk.pool.connectedRelays().length > 0) return globalNdk;

    if (globalNdkPromise) return globalNdkPromise;

    globalNdkPromise = (async () => {
        try {
            console.log('[Nostr] Initializing NDK singleton...');
            const signer = await getSigner();

            if (!globalNdk) {
                const relays = await getRelays();
                globalNdk = new NDK({
                    explicitRelayUrls: relays,
                    signer,
                });
            }

            if (globalNdk.pool.connectedRelays().length > 0) return globalNdk;

            console.log('[Nostr] Connecting to relays...');
            await globalNdk.connect(2000); // 2s timeout for primary connection

            // Wait for at least one relay to be ready before returning, max 4s total
            await new Promise<void>(resolve => {
                let resolved = false;
                const done = () => { if (!resolved) { resolved = true; resolve(); } };

                if (globalNdk?.pool.connectedRelays().length && globalNdk.pool.connectedRelays().length > 0) {
                    done();
                }

                globalNdk!.pool.on('relay:ready', () => {
                    done();
                });

                setTimeout(done, 4000); // 4s total fallback
            });

            return globalNdk;
        } finally {
            globalNdkPromise = null; // Clear lock so we can retry if it failed entirely
        }
    })();

    return globalNdkPromise;
}


/**
 * Fetches events with a timeout, returning whatever was collected if the timeout is reached.
 */
/**
 * Fetches events with a timeout, returning whatever was collected if the timeout is reached.
 * Supports an optional onEvent callback for streaming/incremental processing.
 */
export async function fetchEventsWithTimeout(ndk: NDK, filters: NDKFilter[], timeoutMs: number, onEvent?: (ev: NDKEvent) => void): Promise<Set<NDKEvent>> {
    const merged = new Set<NDKEvent>();
    if (filters.length === 0) return merged;

    let eoseCount = 0;
    let resolved = false;
    let resolveFn: () => void;

    const done = () => {
        if (!resolved) {
            resolved = true;
            resolveFn();
        }
    };

    const promise = new Promise<void>(resolve => { resolveFn = resolve; });

    const subs = filters.map(filter => {
        const sub = ndk.subscribe([filter], { closeOnEose: false });
        sub.on('event', (ev: NDKEvent) => {
            merged.add(ev);
            if (onEvent) onEvent(ev);
        });
        sub.on('eose', () => {
            eoseCount++;
            if (eoseCount >= filters.length) done();
        });
        return sub;
    });

    const timer = setTimeout(done, timeoutMs);

    await promise;
    clearTimeout(timer);
    subs.forEach(s => { try { s.stop(); } catch (_) { } });
    return merged;
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
 * Publishes a Kind 1 note quoting or referencing a ride.
 */
export async function publishSocialNote(content: string, rideEventId?: string) {
    const ndk = await connectNDK();
    const event = new NDKEvent(ndk);
    event.kind = 1;
    event.content = content;
    event.tags = [
        ['client', 'bikel'],
        ['t', 'bikel'],
        ['t', 'cycling']
    ];
    if (rideEventId) {
        event.tags.push(['e', rideEventId, '', 'mention']);
    }
    console.log('[Nostr] Publishing social note...');
    await event.publish();
    return event.id;
}

/**
 * Publishes a Kind 42 Channel Message (NIP-28) to the Bikel Room.
 */
export async function publishChannelMessage(content: string, rideEventId?: string) {
    const ndk = await connectNDK();
    const event = new NDKEvent(ndk);
    event.kind = 42;
    event.content = content;
    event.tags = [
        ['e', BIKEL_GLOBAL_CHANNEL_ID, '', 'root'],
        ['client', 'bikel'],
        ['t', 'bikel']
    ];
    if (rideEventId) {
        // Tag the ride event for clickable references
        event.tags.push(['e', rideEventId, '', 'mention']);
    }
    console.log('[Nostr] Publishing channel message...');
    await event.publish();
    return event.id;
}

/**
 * Fetches recent Kind 42 messages for the Bikel Global Room.
 */
export async function fetchChannelMessages(limit = 50): Promise<NDKEvent[]> {
    const ndk = await connectNDK();
    const filter: NDKFilter = {
        kinds: [42],
        '#e': [BIKEL_GLOBAL_CHANNEL_ID],
        limit
    };
    console.log(`[Nostr] Fetching channel messages for ${BIKEL_GLOBAL_CHANNEL_ID}...`);
    const events = await fetchEventsWithTimeout(ndk, [filter], 12000);
    // Sort chronologically (oldest first) for a standard chat room experience.
    return Array.from(events).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
}

/**
 * Creates a new NIP-28 Public Channel (Kind 40).
 * Run this once to establish the Bikel Global Room.
 */
export async function createBikelChannel(name = "Bikel Global", about = "The official public square for Bikel riders on Nostr.", picture = "") {
    const ndk = await connectNDK();
    const event = new NDKEvent(ndk);
    event.kind = 40;
    event.content = JSON.stringify({
        name,
        about,
        picture
    });
    console.log('[Nostr] Creating channel...');
    await event.publish();
    return event.id;
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
    overrideConfidence?: number,
    elevation?: number,
    checkpointHitId?: string,
    onLog?: (msg: string) => void
) {
    const ndk = await connectNDK();
    const event = new NDKEvent(ndk);

    const confidence = overrideConfidence !== undefined
        ? overrideConfidence
        : calculateRideConfidence(distanceMiles, durationSeconds, routePoints);

    const hrs = Math.floor(durationSeconds / 3600);
    const mins = Math.floor((durationSeconds % 3600) / 60);
    const secs = durationSeconds % 60;
    const durationStr = `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    event.kind = 1301;
    event.tags = [
        ['d', Date.now().toString()],
        ['title', title || "Bikel Ride"],
        ['exercise', 'cycling'],
        ['distance', distanceMiles.toFixed(2), 'mi'],
        ['duration', durationStr],
        ['visibility', visibility],
        ['confidence', confidence.toFixed(2)],
        ['client', 'bikel'],
        ['t', 'cycling'],
        ['t', 'bikel'],
        ['t', 'bikeride'],
        ['t', 'fitness']
    ];
    if (checkpointHitId) {
        event.tags.push(['checkpoint_hit', checkpointHitId]);
    }
    if (elevation !== undefined) {
        event.tags.push(['elevation', elevation.toString()]);
        event.tags.push(['elevation_gain', elevation.toString(), 'ft']);
    }
    if (description) event.tags.push(['summary', description]);
    if (image) event.tags.push(['image', image]);

    if (visibility === 'full' && routePoints.length > 0) {
        const step = Math.ceil(routePoints.length / 1000);
        const compressedGeo = routePoints
            .filter((_, index) => index % step === 0 || index === routePoints.length - 1)
            .map(p => [Number(p.lat.toFixed(6)), Number(p.lng.toFixed(6))]);

        if (onLog) onLog(`[Nostr] Compressed ${routePoints.length} points down to ${compressedGeo.length} (Step: ${step})`);

        // Bikel-specific route data
        event.tags.push(['route', JSON.stringify({ route: compressedGeo })]);
    }

    // Set human-friendly content
    event.content = title
        ? `${title}\n\nRode ${distanceMiles.toFixed(2)} miles in ${durationStr}! 🚲 #bikel`
        : `Rode ${distanceMiles.toFixed(2)} miles in ${durationStr}! 🚲 #bikel`;

    if (description) event.content += `\n\n${description}`;

    console.log('[Nostr] Signing and publishing ride event...');
    if (onLog) {
        try {
            const relays = Array.from(ndk.pool.relays.values());
            const relayInfo = relays.map(r => {
                const url = r.url.replace('wss://', '');
                const s = r.connectivity?.status;
                let label = 'unknown';
                if (s === 0) label = 'Disconnected';
                else if (s === 1) label = 'Connecting';
                else if (s === 2) label = 'Connected';
                else if (s === 3) label = 'Reconnecting';
                else if (s === 4) label = 'Flapping';
                else if (s === 5) label = 'Auth';
                return `${url}(${label})`;
            }).join(', ');
            onLog(`[Nostr] Relays: ${relayInfo || 'None'}`);
        } catch (err) {
            onLog(`[Nostr] Failed to log relay info: ${err}`);
        }
    }

    let kind1301Success = false;

    // --- Kind 1301 (Standard Fitness Event) ---
    try {
        if (onLog) onLog('[Nostr] Signing Kind 1301 (Standardized Fitness Event)...');
        await event.sign();

        if (onLog) onLog(`[Nostr] Event ID: ${event.id.substring(0, 8)}...`);
        if (onLog) onLog('[Nostr] Publishing...');
        
        // Don't wait strictly on network acks if they are slow
        const relaySet = await Promise.race([
            event.publish(),
            new Promise((resolve) => setTimeout(() => resolve(new Set(['optimistic'])), 3000))
        ]) as Set<any>;

        const okRelays = relaySet?.size || 1;
        if (onLog) onLog(`[Nostr] Publish Result/Timeout: ${okRelays} OK/Assumed`);
        kind1301Success = true;

    } catch (e: any) {
        if (onLog) onLog(`[Nostr] Publish Warning: ${e.message || e}. Proceeding optimisticly.`);
        kind1301Success = true;
    }

    if (!kind1301Success) {
        // Fallback safety (rarely hit now)
        throw new Error("Local signing failed. Check Debug Logs.");
    }

    return event.id;
}

let nwcWallet: NDKNWCWallet | null = null;

export async function connectNWC(pairingCode: string): Promise<boolean> {
    const ndk = await connectNDK();
    try {
        // @ts-ignore
        nwcWallet = new NDKNWCWallet(ndk, { pairingCode, timeout: 15000 });

        // Hard 5s timeout for NWC — if it fails, we keep the app moving!
        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                console.warn("[NWC] timeout triggered");
                resolve();
            }, 5000);
            nwcWallet!.once("ready", () => {
                clearTimeout(timeout);
                console.log("[NWC - Mobile] Ready event received");
                resolve();
            });
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
        const targetUser = ndk.getUser({ pubkey: targetPubkey });

        // Ensure profile is fetched before zapper starts so lud16 is known
        let profile = (targetUser.profile as any) || undefined;
        if (!profile || (!profile.lud16 && !profile.lud06)) {
            console.log(`[Zap - Mobile] Fetching profile for recipient ${targetPubkey}...`);
            // Add a timeout to avoid hanging if relays are slow
            profile = (await Promise.race([
                targetUser.fetchProfile(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000))
            ]).catch(() => undefined) as any);
        }

        // Deep discovery fallback if primary relays miss the profile
        if (!profile || (!profile.lud16 && !profile.lud06)) {
            console.warn(`[Zap - Mobile] Profile not found on primary relays, trying broader search...`);
            const discoveryNdk = new NDK({ explicitRelayUrls: NIP50_RELAYS });
            try {
                await Promise.race([
                    discoveryNdk.connect(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Connect Timeout")), 6000))
                ]);
                const discoveryUser = discoveryNdk.getUser({ pubkey: targetPubkey });
                const foundProfile = await Promise.race([
                    discoveryUser.fetchProfile(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("Fetch Timeout")), 10000))
                ]).catch(() => undefined) as any;

                if (foundProfile && (foundProfile.lud16 || foundProfile.lud06)) {
                    targetUser.profile = foundProfile;
                    profile = foundProfile;
                } else {
                    // Last ditch: Manual Kind 0 fetch
                    console.log(`[Zap - Mobile] Manual Kind 0 lookup for ${targetPubkey}...`);
                    const k0 = await discoveryNdk.fetchEvent({ kinds: [0], authors: [targetPubkey] });
                    if (k0 && k0.content) {
                        try {
                            const data = JSON.parse(k0.content);
                            if (data.lud16 || data.lud06) {
                                profile = data;
                                targetUser.profile = data;
                                console.log(`[Zap - Mobile] Manual Discovery successful: ${data.lud16 || data.lud06}`);
                            }
                        } catch (e) {
                            console.error("[Zap - Mobile] Failed to parse Kind 0", e);
                        }
                    }
                }
            } catch (e) {
                console.warn(`[Zap - Mobile] Deep discovery failed or timed out:`, e);
            } finally {
                // NDK Pool disconnect
                (discoveryNdk.pool as any).disconnect?.();
            }
        }

        // Hardcoded fallback for the Bikel Bot (Escrow Account) if discovery fails
        if ((!profile || (!profile.lud16 && !profile.lud06)) && targetPubkey === ESCROW_PUBKEY) {
            console.log(`[Zap - Mobile] Using hardcoded fallback for Bikel Bot: bikel@coinos.io`);
            profile = { ...profile, lud16: 'bikel@coinos.io' };
            targetUser.profile = profile;
        }

        if (!profile || (!(profile as any).lud16 && !(profile as any).lud06)) {
            throw new Error("This bot or user hasn't set up a Lightning Address in their profile yet, so it cannot be zapped!");
        }

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

        console.log("[Zap - Mobile] Calling zapper.zap()...");

        let resolveLnPay: (v: boolean) => void;
        const lnPaySignal = new Promise<boolean>(r => { resolveLnPay = r; });

        let lnPayInitiated = false;
        const originalLnPay = currentWallet.lnPay?.bind(currentWallet);
        const wrappedLnPay = async (payment: any) => {
            const invoice = typeof payment === 'string' ? payment : (payment.pr || payment.invoice || JSON.stringify(payment));
            console.log("[Zap - Mobile] lnPay (Wallet) called with invoice/payment:", invoice.substring(0, 50) + "...");
            lnPayInitiated = true;
            try {
                if (originalLnPay) {
                    const res = await originalLnPay(payment);
                    console.log("[Zap - Mobile] lnPay (Wallet) returned:", res);
                    if (res) {
                        console.log("[Zap - Mobile] lnPay confirmed success, signaling early return...");
                        resolveLnPay(true);
                    }
                    return res;
                }
                console.warn("[Zap - Mobile] No originalLnPay found!");
                return undefined;
            } catch (err) {
                console.error("[Zap - Mobile] lnPay (Wallet) CRASHED:", err);
                throw err;
            }
        };

        const zapper = new NDKZapper(event, amountSats * 1000, 'msat', {
            comment,
            ndk,
            lnPay: wrappedLnPay
        });
        zapper.on("notice", (msg) => { console.log("[Zap Notice]", msg); lastNotice = msg; });

        // Race between:
        // 1. Zapper's full confirmation (including receipt wait)
        // 2. Our early signal from lnPay success
        // 3. A 20-second timeout
        const success = await Promise.race([
            zapper.zap().then(c => {
                console.log("[Zap - Mobile] zapper.zap() resolved:", !!c);
                return !!c;
            }).catch(e => {
                console.warn("[Zap - Mobile] zapper.zap() promise rejected:", e);
                // IF we initiated lnPay and it timed out or failed with "All zap attempts failed"
                // AND we are zapping the Bikel Bot, we assume it worked (optimistic success)
                if (lnPayInitiated && (targetPubkey === ESCROW_PUBKEY)) {
                    console.log("[Zap - Mobile] lnPay was initiated for Bikel Bot. Assuming optimistic success.");
                    return true;
                }
                return false;
            }),
            lnPaySignal,
            new Promise<boolean>(r => setTimeout(() => {
                console.warn("[Zap - Mobile] Zapper wait timed out after 20s");
                // If we initiated payment to our bot, we're optimistic!
                if (lnPayInitiated && (targetPubkey === ESCROW_PUBKEY)) {
                    console.log("[Zap - Mobile] Timeout but lnPay was initiated for Bikel Bot. Returning true.");
                    r(true);
                } else {
                    r(false);
                }
            }, 20000))
        ]);

        if (success) {
            console.log(`[Zap - Mobile] Zap process declared SUCCESS!`);
            return true;
        } else {
            console.warn(`[Zap - Mobile] Zap process failed or timed out.`);
            // If it timed out but we called lnPay, it might have actually worked (like the user saw on Coinos)
            return false;
        }
    } catch (e: any) {
        console.error("[Zap - Mobile] Failed to zap event", e);
        if (lastNotice) throw new Error(`Lightning node error: ${lastNotice}`);

        const isTimeout = e.message?.toLowerCase().includes("timeout") || e.message?.toLowerCase().includes("timed out");
        if (isTimeout) {
            // Special case: if it worked but timed out waiting for response
            throw new Error("Zap request sent but confirmation timed out. Check your wallet balance—it may have already been sent!");
        }

        if (e.message?.includes("All zap attempts failed")) throw new Error("This recipient has not linked a Lightning Address to their Nostr profile!");
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
    rawDuration: number;
    visibility: string;
    route: number[][];
    title?: string;
    description?: string;
    image?: string;
    kind: 33301 | 1301 | 1;
    confidence?: number;
    elevation?: string;
    client?: string;
    checkpointHitId?: string | null;
}

/**
 * Helper to parse a RideEvent from a generic NDKEvent.
 * Supports legacy JSON-in-content and new Bikel JSON-in-tag 'g'.
 */
function parseRideEvent(event: NDKEvent): RideEvent | null {
    // Skip Kind 1 replies
    if (event.kind === 1 && event.getMatchingTags("e").length > 0) return null;
    try {
        const distanceTag = event.getMatchingTags("distance")[0];
        const distanceVal = parseFloat(distanceTag?.[1] || "0");
        const distanceUnit = distanceTag?.[2]?.toLowerCase() || "mi";

        // Convert KM to Miles if necessary
        const distanceMiles = distanceUnit === 'km' ? distanceVal * 0.621371 : distanceVal;
        const distance = distanceMiles.toFixed(2);

        const durationRaw = event.getMatchingTags("duration")[0]?.[1] || "0";
        let durationSecs = 0;
        if (durationRaw.includes(':')) {
            const parts = durationRaw.split(':').reverse();
            durationSecs = parseInt(parts[0] || "0", 10) + (parseInt(parts[1] || "0", 10) * 60) + (parseInt(parts[2] || "0", 10) * 3600);
        } else {
            durationSecs = parseInt(durationRaw, 10);
        }

        const visibility = event.getMatchingTags("visibility")[0]?.[1] || "full";
        const imageTag = event.getMatchingTags("image")[0]?.[1];
        let image = imageTag;
        if (!image) {
            const imeta = event.getMatchingTags("imeta")[0];
            if (imeta) {
                const urlMatch = imeta.find(t => t.startsWith("url "))?.substring(4);
                if (urlMatch) image = urlMatch;
            }
        }
        if (!image && event.kind === 1) {
            const urlMatch = event.content.match(/https?:\/\/\S+\.(jpg|jpeg|png|webp|gif)/i);
            if (urlMatch) image = urlMatch[0];
        }

        const titleTag = event.getMatchingTags("title")[0]?.[1];
        const exerciseTag = event.getMatchingTags("exercise")[0]?.[1]?.toLowerCase() || "";
        const tags = event.getMatchingTags("t").map(t => t[1].toLowerCase());
        const hasCyclingContext = exerciseTag.includes("cycling") ||
            exerciseTag.includes("bike") ||
            tags.some(t => ["cycling", "bike", "bikel", "bikeride"].includes(t)) ||
            event.content.toLowerCase().includes("cycling") ||
            event.content.toLowerCase().includes("bike");

        // Strict filter: If it's Kind 1 or 1301, it MUST have cycling context OR be from Bikel client
        const client = event.getMatchingTags("client")[0]?.[1];
        const isBikel = client === 'bikel';
        if ((event.kind === 1 || event.kind === 1301) && !hasCyclingContext && !isBikel) return null;

        // Skip empty stats if not native bikel
        if (!isBikel && distanceMiles === 0 && durationSecs === 0) return null;

        let description = event.getMatchingTags("summary")[0]?.[1] || event.getMatchingTags("description")[0]?.[1];
        if (!description && event.kind === 1) {
            description = event.content.replace(/https?:\/\/\S+/g, "").trim();
        }
        const confidenceRaw = event.getMatchingTags("confidence")[0]?.[1];
        const confidence = confidenceRaw ? parseFloat(confidenceRaw) : undefined;

        const hrs = Math.floor(durationSecs / 3600);
        const mins = durationSecs >= 3600 ? Math.floor((durationSecs % 3600) / 60) : Math.floor(durationSecs / 60);
        const secs = durationSecs % 60;

        const elevation = event.getMatchingTags("elevation")[0]?.[1] || event.getMatchingTags("elevation_gain")[0]?.[1];

        let route: number[][] = [];
        if (visibility === 'full') {
            const routeTag = event.getMatchingTags("route")[0]?.[1];
            const gTag = event.getMatchingTags("g")[0]?.[1];
            const rawRouteData = routeTag || gTag;

            if (rawRouteData) {
                try {
                    const parsed = JSON.parse(rawRouteData);
                    if (Array.isArray(parsed)) {
                        route = parsed;
                    } else if (parsed && parsed.route && Array.isArray(parsed.route)) {
                        route = parsed.route;
                    }
                } catch (e) { }
            }
            if (route.length === 0 && event.content && event.content.includes('"route"')) {
                try {
                    const jsonMatch = event.content.match(/\{.*?"route"\s*:.*?\}/s);
                    const jsonToParse = jsonMatch ? jsonMatch[0] : event.content;
                    const parsed = JSON.parse(jsonToParse);
                    if (Array.isArray(parsed)) {
                        route = parsed;
                    } else if (parsed && parsed.route && Array.isArray(parsed.route)) {
                        route = parsed.route;
                    }
                } catch (e) { }
            }
        }

        const checkpointHitId = event.getMatchingTags("checkpoint_hit")[0]?.[1] || null;

        return {
            id: event.id,
            pubkey: event.pubkey,
            hexPubkey: event.pubkey,
            time: event.created_at || Math.floor(Date.now() / 1000),
            distance,
            duration: durationRaw.includes(':')
                ? (durationRaw.split(':').length === 2 ? `00:${durationRaw}` : durationRaw)
                : `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`,
            rawDuration: durationSecs,
            visibility,
            route: route.length > 100
                ? route.filter((_, i) => i % Math.ceil(route.length / 100) === 0 || i === route.length - 1)
                : route,
            kind: event.kind as 33301 | 1301 | 1,
            title: titleTag,
            description,
            image,
            confidence,
            elevation,
            client,
            checkpointHitId
        };
    } catch (e) {
        console.error('[Nostr] Failed to parse ride event:', e);
        return null;
    }
}

export async function fetchRideById(id: string): Promise<RideEvent | null> {
    const ndk = await connectNDK();
    const filter: NDKFilter = { ids: [id], kinds: [1, 1301 as any, 33301 as any] };
    const events = await fetchEventsWithTimeout(ndk, [filter], 5000);
    if (events.size === 0) return null;
    return parseRideEvent(Array.from(events)[0]);
}

export async function fetchMyRides(): Promise<RideEvent[]> {
    const ndk = await connectNDK();
    const signer = await getSigner();
    const user = await signer.user();

    const filters: NDKFilter[] = [
        { kinds: [33301 as any, 1301 as any], authors: [user.pubkey], limit: 50 },
        { kinds: [1 as any], authors: [user.pubkey], "#t": ["RUNSTR", "cycling", "fitness", "bikel"], limit: 50 }
    ];

    console.log('[Nostr] Fetching personal ride history...');
    const events = await fetchEventsWithTimeout(ndk, filters, 5000);
    const ridesMap = new Map<string, RideEvent>();

    for (const event of events) {
        const parsed = parseRideEvent(event);
        if (parsed) {
            const dTag = event.getMatchingTags("d")[0]?.[1] || "";
            const key = dTag ? `${event.pubkey}-${dTag}` : event.id;

            // Prefer Kind 33301 if both exist
            if (!ridesMap.has(key) || parsed.kind === 33301) {
                ridesMap.set(key, parsed);
            }
        }
    }
    return Array.from(ridesMap.values()).sort((a, b) => b.time - a.time);
}

export async function fetchUserRides(targetPubkey: string): Promise<RideEvent[]> {
    const ndk = await connectNDK();

    // Support targetPubkey as npub or hex
    let hexPubkey = targetPubkey;
    if (targetPubkey.startsWith('npub1')) {
        const user = ndk.getUser({ npub: targetPubkey });
        hexPubkey = user.pubkey;
    }

    const filters: NDKFilter[] = [
        { kinds: [33301 as any, 1301 as any], authors: [hexPubkey], limit: 50 },
        { kinds: [1 as any], authors: [hexPubkey], "#t": ["RUNSTR", "cycling", "fitness", "bikel"], limit: 50 }
    ];

    console.log(`[Nostr] Fetching rides for user ${hexPubkey.substring(0, 8)}...`);
    const events = await fetchEventsWithTimeout(ndk, filters, 8000);
    const ridesMap = new Map<string, RideEvent>();

    for (const event of events) {
        const parsed = parseRideEvent(event);
        if (parsed) {
            const dTag = event.getMatchingTags("d")[0]?.[1] || "";
            const key = dTag ? `${event.pubkey}-${dTag}` : event.id;

            // Prefer Kind 33301 if both exist (e.g. dual-pub)
            if (!ridesMap.has(key) || parsed.kind === 33301) {
                ridesMap.set(key, parsed);
            }
        }
    }
    return Array.from(ridesMap.values()).sort((a, b) => b.time - a.time);
}

export async function getPrivateKeyHex(): Promise<string | null> {
    return await SecureStore.getItemAsync(SECURE_STORE_KEY);
}

export async function getPrivateKeyNsec(): Promise<string | null> {
    if (await SecureStore.getItemAsync(AUTH_METHOD_KEY) === 'amber') return null;
    const hex = await getPrivateKeyHex();
    if (!hex) return null;
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    return nip19.nsecEncode(bytes);
}

export async function getPublicKeyNpub(): Promise<string | null> {
    const authMethod = await SecureStore.getItemAsync(AUTH_METHOD_KEY);
    if (authMethod === 'amber') {
        let hex = await SecureStore.getItemAsync(AMBER_PUBKEY_KEY);
        if (!hex) return null;
        if (hex.startsWith('npub1')) return hex;
        return nip19.npubEncode(hex);
    }
    const hex = await getPrivateKeyHex();
    if (!hex) return null;
    const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    return nip19.npubEncode(getPublicKey(bytes));
}

export async function getPublicKeyHex(): Promise<string | null> {
    const authMethod = await SecureStore.getItemAsync(AUTH_METHOD_KEY);
    if (authMethod === 'amber') {
        let hex = await SecureStore.getItemAsync(AMBER_PUBKEY_KEY);
        if (hex?.startsWith('npub1')) {
            try { const { data } = nip19.decode(hex); hex = data as string; } catch (e) {}
        }
        return hex;
    }
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

export interface CheckpointEvent {
    id: string;
    pubkey: string;
    hexPubkey: string;
    dTag: string;
    title: string;
    description: string;
    location: { lat: number, lng: number };
    rewardSats: number;
    radius: number;
    startTime: number;
    endTime: number;
    frequency?: 'once' | 'daily' | 'hourly';
    kind: 33402;
    streakDays?: number;
    streakReward?: number;
    set?: string;
    setReward?: number;
    rsvp?: string;
    routeId?: string;
    routeIndex?: number;
}

export async function fetchRecentRides(onUpdate?: (rides: RideEvent[]) => void): Promise<RideEvent[]> {
    const ndk = await connectNDK();
    const since = Math.floor(Date.now() / 1000) - (14 * 24 * 60 * 60); // Last 14 days
    const filters: NDKFilter[] = [
        { kinds: [33301 as any, 1301 as any], since, limit: 150 },
        { kinds: [1 as any], '#t': ['bikel'], since, limit: 100 },
        { kinds: [1 as any], '#t': ['cycling'], since, limit: 100 },
    ];

    const ridesMap = new Map<string, RideEvent>();
    let lastEmitTime = 0;
    const throttleInterval = 200; // ms

    const handleEvent = (event: NDKEvent) => {
        const hasBikelClient = event.getMatchingTags("client").some(t => t[1] === "bikel");
        const hasCyclingTag = event.getMatchingTags("t").some(t => ["cycling", "bikel", "bikeride", "fitness"].includes(t[1].toLowerCase()));
        const isRunstr = event.kind === 1301 ||
            event.getMatchingTags("client").some(t => t[1].toUpperCase() === "RUNSTR") ||
            event.getMatchingTags("t").some(t => t[1].toUpperCase() === "RUNSTR");

        if (event.kind !== 33301 && event.kind !== 1301 && event.kind !== 1 && !isRunstr) return;
        if (!hasBikelClient && !hasCyclingTag && !isRunstr) return;

        const parsed = parseRideEvent(event);
        if (!parsed) return;
        if (event.kind === 1 && parsed.route.length === 0) return;

        const dTag = event.getMatchingTags("d")[0]?.[1] || "";
        const key = dTag ? `${event.pubkey}-${dTag}` : event.id;

        if (!ridesMap.has(key) || parsed.kind === 33301) {
            ridesMap.set(key, parsed);

            const now = Date.now();
            if (onUpdate && (now - lastEmitTime > throttleInterval || ridesMap.size === 1)) {
                lastEmitTime = now;
                // Batch-friendly incremental update
                onUpdate(Array.from(ridesMap.values()).sort((a, b) => b.time - a.time));
            }
        }
    };

    console.log("[Nostr] Fetching recent Bikel & Runstr rides...");

    // Use a shorter 8s window for discovery. The UI is snappy thanks to onUpdate.
    await fetchEventsWithTimeout(ndk, filters, 8000, handleEvent);
    return Array.from(ridesMap.values()).sort((a, b) => b.time - a.time);
}

export async function fetchScheduledRides(): Promise<ScheduledRideEvent[]> {
    const ndk = await connectNDK();
    const filters: NDKFilter[] = [{ kinds: [31923 as any], limit: 100 }];
    console.log("[Nostr] Fetching scheduled rides (Kind 31923)...");
    const events = await fetchEventsWithTimeout(ndk, filters, 6000);

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
                    timezone: event.getMatchingTags("start_tzid")[0]?.[1] || event.getMatchingTags("start_tz")[0]?.[1],
                    image: event.getMatchingTags("image")[0]?.[1],
                    distance: event.getMatchingTags("distance")[0]?.[1],
                    duration: event.getMatchingTags("duration")[0]?.[1],
                    kind: 31923
                });
            }
        } catch (e) { }
    }

    if (aTagsToFetch.length > 0) {
        const rsvpEvents = await fetchEventsWithTimeout(ndk, [{ kinds: [31925 as any], "#a": aTagsToFetch }], 5000);
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

export async function publishRSVP(target: ScheduledRideEvent | ContestEvent | string, botPubkey?: string): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) return false;
    const event = new NDKEvent(ndk);
    event.kind = 31925;

    if (typeof target === 'string') {
        event.tags = [
            ['a', target],
            ['p', botPubkey || ESCROW_PUBKEY],
            ['l', 'accepted'],
            ['client', 'bikel'],
            ['t', 'bikel-rsvp']
        ];
    } else {
        event.tags = [
            ['a', `${target.kind}:${target.hexPubkey}:${target.dTag}`],
            ['p', target.hexPubkey],
            ['l', 'accepted'],
            ['client', 'bikel'],
            ['t', 'bikel-rsvp']
        ];
    }

    event.content = "";
    try {
        await event.publish();
        return true;
    } catch (e) {
        console.error("[Nostr] Failed to publish RSVP:", e);
        return false;
    }
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
    try { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; if (tz) { event.tags.push(['start_tzid', tz]); event.tags.push(['start_tz', tz]); } } catch (e) { }
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
export async function prepareContestEvent(
    name: string,
    description: string,
    startTimestamp: number,
    endTimestamp: number,
    parameter: string,
    feeSats: number,
    invitedPubkeys: string[],
    sport: string = "cycling",
    unit: string = "imperial",
    payoutSplit: [number, number, number] = [50, 30, 20],
    minConfidence: number = 0.7,
    prizeSats?: number
): Promise<NDKEvent> {
    const ndk = await connectNDK();
    const event = new NDKEvent(ndk);
    event.kind = 33401;
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
    await event.sign();
    return event;
}

export async function publishContestEvent(
    name: string,
    description: string,
    startTimestamp: number,
    endTimestamp: number,
    parameter: string,
    feeSats: number,
    invitedPubkeys: string[],
    sport: string = "cycling",
    unit: string = "imperial",
    payoutSplit: [number, number, number] = [50, 30, 20],
    minConfidence: number = 0.7,
    prizeSats?: number
): Promise<string> {
    const event = await prepareContestEvent(name, description, startTimestamp, endTimestamp, parameter, feeSats, invitedPubkeys, sport, unit, payoutSplit, minConfidence, prizeSats);
    console.log('[Nostr] Publishing challenge event (Kind 33401)...');
    await event.publish();
    return event.id;
}


export async function fetchContests(onUpdate?: (contests: ContestEvent[]) => void): Promise<ContestEvent[]> {
    const ndk = await connectNDK();
    const filters: NDKFilter[] = [{ kinds: [33401 as any], limit: 100 }];

    console.log("[Nostr] Fetching Bikel Challenges (Kind 33401)...");
    const contestsMap = new Map<string, ContestEvent>();
    let lastEmitTime = 0;
    const throttleInterval = 200;

    const handleEvent = (event: NDKEvent) => {
        const hasBikelClient = event.getMatchingTags("client").some(t => t[1] === "bikel");
        const hasChallengeTag = event.getMatchingTags("t").some(t => ["bikel-challenge", "bikel"].includes(t[1]));
        if (!hasBikelClient && !hasChallengeTag) return;

        try {
            const name = event.getMatchingTags("title")[0]?.[1] || "Untitled Challenge";
            const startTime = parseInt(event.getMatchingTags("start")[0]?.[1] || "0", 10);
            const endTime = parseInt(event.getMatchingTags("end")[0]?.[1] || "0", 10);
            const parameter = event.getMatchingTags("parameter")[0]?.[1] || "max_distance";
            const feeSats = parseInt(event.getMatchingTags("fee")[0]?.[1] || "0", 10);
            const invitedPubkeys = event.getMatchingTags("p").map(t => t[1]);
            const dTag = event.getMatchingTags("d")[0]?.[1];
            if (!dTag) return;

            if (endTime > (Date.now() / 1000) - 86400) {
                contestsMap.set(event.id, {
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

                const now = Date.now();
                if (onUpdate && (now - lastEmitTime > throttleInterval || contestsMap.size === 1)) {
                    lastEmitTime = now;
                    onUpdate(Array.from(contestsMap.values()).sort((a, b) => b.createdAt - a.createdAt));
                }
            }
        } catch (e) { }
    };

    await fetchEventsWithTimeout(ndk, filters, 8000, handleEvent);
    const contests = Array.from(contestsMap.values());
    const aTagsToFetch = contests.map(c => `33401:${c.hexPubkey}:${c.dTag}`);

    if (aTagsToFetch.length > 0) {
        const rsvpEvents = await fetchEventsWithTimeout(ndk, [{ kinds: [31925 as any], "#a": aTagsToFetch }], 5000);
        for (const rsvp of rsvpEvents) {
            const aTagMatch = rsvp.getMatchingTags("a")[0]?.[1];
            if (aTagMatch && rsvp.getMatchingTags("l")[0]?.[1] === "accepted") {
                const contest = contestsMap.get(rsvp.id) || Array.from(contestsMap.values()).find(c => `33401:${c.hexPubkey}:${c.dTag}` === aTagMatch);
                if (contest && !contest.attendees.includes(rsvp.pubkey)) contest.attendees.push(rsvp.pubkey);
            }
        }
        if (onUpdate) onUpdate(Array.from(contestsMap.values()).sort((a, b) => b.createdAt - a.createdAt));
    }

    return Array.from(contestsMap.values()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function fetchCheckpoints(onUpdate?: (checkpoints: CheckpointEvent[]) => void): Promise<CheckpointEvent[]> {
    const ndk = await connectNDK();
    const filters: NDKFilter[] = [{ kinds: [33402 as any], "#t": ["bikel"], limit: 500 }];
    console.log("[Nostr] Fetching Bikel Checkpoints (Kind 33402)...");
    
    const checkpointsMap = new Map<string, CheckpointEvent>();
    const now = Math.floor(Date.now() / 1000);
    let lastEmitTime = 0;
    const throttleInterval = 200;

    const handleEvent = (event: NDKEvent) => {
        try {
            const dTag = event.getMatchingTags("d")[0]?.[1];
            if (!dTag) return;

            const title = event.getMatchingTags("title")[0]?.[1] || "POI Checkpoint";
            const locTag = event.getMatchingTags("location")[0]?.[1] || "";
            const [lat, lng] = locTag.split(',').map(Number);
            const rewardSats = parseInt(event.getMatchingTags("reward")[0]?.[1] || "0", 10);
            const radius = parseInt(event.getMatchingTags("radius")[0]?.[1] || "20", 10);
            const startTime = parseInt(event.getMatchingTags("start")[0]?.[1] || "0", 10);
            const endTime = parseInt(event.getMatchingTags("end")[0]?.[1] || "0", 10);

            const frequency = event.getMatchingTags("frequency")[0]?.[1] as 'once' | 'daily' | 'hourly' | undefined;
            const streakDays = parseInt(event.getMatchingTags("streak_days")[0]?.[1] || "0", 10);
            const set = event.getMatchingTags("set")[0]?.[1];
            const setReward = parseInt(event.getMatchingTags("set_reward")[0]?.[1] || "0", 10);
            const routeId = event.getMatchingTags("route_id")[0]?.[1];
            let routeIndex = parseInt(event.getMatchingTags("route_index")[0]?.[1] || "-1", 10);
            if (routeIndex === -1) routeIndex = parseInt(event.getMatchingTags("n")[0]?.[1] || "-1", 10);

            if (isNaN(lat) || isNaN(lng)) return;

            if (endTime === 0 || endTime > now - 86400) {
                checkpointsMap.set(event.id, {
                    id: event.id,
                    pubkey: event.author.npub,
                    hexPubkey: event.pubkey,
                    dTag,
                    title,
                    description: event.content || "",
                    location: { lat, lng },
                    rewardSats,
                    radius,
                    startTime,
                    endTime,
                    frequency,
                    kind: 33402,
                    streakDays: streakDays || undefined,
                    streakReward: parseInt(event.getMatchingTags("streak_reward")[0]?.[1] || "0", 10) || undefined,
                    set,
                    setReward: setReward || undefined,
                    rsvp: event.getMatchingTags("rsvp")[0]?.[1],
                    routeId,
                    routeIndex: routeIndex !== -1 ? routeIndex : undefined
                });

                const curNow = Date.now();
                if (onUpdate && (curNow - lastEmitTime > throttleInterval || checkpointsMap.size === 1)) {
                    lastEmitTime = curNow;
                    onUpdate(Array.from(checkpointsMap.values()).sort((a, b) => b.rewardSats - a.rewardSats));
                }
            }
        } catch (e) { }
    };

    await fetchEventsWithTimeout(ndk, filters, 8000, handleEvent);
    return Array.from(checkpointsMap.values()).sort((a, b) => b.rewardSats - a.rewardSats);
}

export async function prepareCheckpointEvent(
    title: string,
    description: string,
    lat: number,
    lng: number,
    rewardSats: number,
    radius: number,
    startTime: number,
    endTime: number,
    botPubkey?: string,
    frequency?: 'once' | 'daily' | 'hourly',
    limit?: number,
    rsvp?: 'required' | 'optional',
    streakReward?: number,
    setReward?: number,
    set?: string,
    route_id?: string,
    route_index?: number,
    streakDays?: number
): Promise<NDKEvent> {
    const ndk = await connectNDK();
    const event = new NDKEvent(ndk);
    event.kind = 33402 as any;
    event.content = description;

    // Use a random d-tag or slug of title
    const dTag = title.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Math.floor(Math.random() * 1000000);

    event.tags = [
        ['d', dTag],
        ['title', title],
        ['location', `${lat},${lng}`],
        ['reward', rewardSats.toString()],
        ['radius', radius.toString()],
        ['start', startTime.toString()],
        ['end', endTime.toString()],
        ['t', 'bikel'],
        ['t', 'checkpoint']
    ];

    if (botPubkey) event.tags.push(['bot', botPubkey]);
    if (frequency) event.tags.push(['frequency', frequency]);
    if (limit) event.tags.push(['limit', limit.toString()]);
    if (rsvp) event.tags.push(['rsvp', rsvp]);
    if (streakReward) event.tags.push(['streak_reward', streakReward.toString()]);
    if (setReward) event.tags.push(['set_reward', setReward.toString()]);
    if (set) event.tags.push(['set', set]);
    if (route_id) event.tags.push(['route_id', route_id]);
    if (route_index !== undefined && route_index !== -1) event.tags.push(['route_index', route_index.toString()]);
    if (streakDays) event.tags.push(['streak_days', streakDays.toString()]);

    await event.sign();
    return event;
}

export async function publishCheckpoint(
    title: string,
    description: string,
    lat: number,
    lng: number,
    rewardSats: number,
    radius: number,
    startTime: number,
    endTime: number,
    botPubkey?: string,
    frequency?: 'once' | 'daily' | 'hourly',
    limit?: number
): Promise<string | null> {
    const event = await prepareCheckpointEvent(title, description, lat, lng, rewardSats, radius, startTime, endTime, botPubkey, frequency, limit);
    try {
        await event.publish();
        return event.id;
    } catch (e) {
        console.error("[Nostr] Failed to publish checkpoint:", e);
        return null;
    }
}

export async function fetchRideLeaderboard(attendees: string[], startTime: number, endTime: number, parameter: string): Promise<{ pubkey: string, value: number }[]> {
    if (attendees.length === 0) return [];
    const ndk = await connectNDK();
    const filters: NDKFilter[] = [{
        kinds: [1301 as any, 33301 as any],
        authors: attendees.map(a => a.startsWith("npub") ? new NDKUser({ npub: a }).pubkey : a),
        since: startTime,
        until: endTime
    }];
    console.log(`[Nostr] Fetching rides for leaderboard... Attendees: ${attendees.length}`);
    const events = await fetchEventsWithTimeout(ndk, filters, 8000);
    const scores: Record<string, number> = {};

    for (const event of events) {
        try {
            const distanceTag = event.getMatchingTags("distance")[0]?.[1];
            const durationTag = event.getMatchingTags("duration")[0]?.[1];
            if (!distanceTag || !durationTag) continue;
            const distance = parseFloat(distanceTag);
            const elevationGain = parseFloat(event.getMatchingTags("elevation_gain")[0]?.[1] || "0");
            let duration = 0;
            if (durationTag.includes(':')) {
                const parts = durationTag.split(':').reverse();
                duration = parseInt(parts[0] || "0", 10) + (parseInt(parts[1] || "0", 10) * 60) + (parseInt(parts[2] || "0", 10) * 3600);
            } else {
                duration = parseInt(durationTag, 10);
            }
            if (duration === 0) continue;

            const pubkey = event.pubkey;
            if (parameter === "max_distance") {
                scores[pubkey] = (scores[pubkey] || 0) + distance;
            } else if (parameter === "max_elevation") {
                scores[pubkey] = (scores[pubkey] || 0) + elevationGain;
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
    rideId?: string;
    title?: string;
    isRide?: boolean;
    image?: string;
    distance?: string;
    duration?: string;
    rawDuration?: number;
    kind?: number;
    hasRoute?: boolean;
}

export async function fetchComments(eventId: string): Promise<RideComment[]> {
    const ndk = await connectNDK();
    const filter: NDKFilter = { kinds: [1], "#e": [eventId], limit: 100 };
    console.log(`[Nostr - Mobile] Fetching comments for event ${eventId}...`);
    const events = await fetchEventsWithTimeout(ndk, [filter], 5000);
    const comments: RideComment[] = [];
    Array.from(events).forEach(event => {
        comments.push({ id: event.id, pubkey: event.author?.npub || event.pubkey, hexPubkey: event.pubkey, content: event.content, createdAt: event.created_at || Math.floor(Date.now() / 1000) });
    });
    return comments.sort((a, b) => a.createdAt - b.createdAt);
}

export async function fetchProfiles(pubkeys: string[]): Promise<Record<string, any>> {
    if (pubkeys.length === 0) return {};
    const ndk = await connectNDK();
    const filter: NDKFilter = { kinds: [0 as any], authors: pubkeys, limit: pubkeys.length };
    console.log(`[Nostr] Bulk fetching ${pubkeys.length} profiles...`);
    const events = await fetchEventsWithTimeout(ndk, [filter], 6000);
    const profiles: Record<string, any> = {};
    Array.from(events).forEach(ev => {
        try { profiles[ev.pubkey] = JSON.parse(ev.content); } catch (e) { }
    });
    return profiles;
}

export async function publishComment(eventId: string, content: string): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) return false;
    const event = new NDKEvent(ndk);
    event.kind = 1;
    event.content = content;
    event.tags = [['e', eventId, '', 'reply'], ['client', 'bikel'], ['t', 'bikel']];
    try { await event.publish(); return true; } catch (e) { console.error("[Nostr - Mobile] Failed to publish comment", e); return false; }
}

/**
 * Fetches all recent Bikel-related social activity (Kind 1 notes and comments).
 */

// ── NIP-25 Emoji Reactions ─────────────────────────────────────────────────

export interface ReactionSummary {
    emoji: string;
    count: number;
    reactedByMe: boolean;
    myReactionId?: string;
}

export async function fetchReactions(eventId: string): Promise<ReactionSummary[]> {
    const ndk = await connectNDK();
    const signer = await getSigner();
    const me = await signer.user();
    const events = await fetchEventsWithTimeout(ndk, [{ kinds: [7 as any], '#e': [eventId], limit: 200 }], 5000);
    const counts = new Map<string, { count: number; reactedByMe: boolean; myReactionId?: string }>();
    Array.from(events).forEach(ev => {
        const emoji = ev.content || '👍';
        const existing = counts.get(emoji) || { count: 0, reactedByMe: false };
        const isMine = ev.pubkey === me.pubkey;
        counts.set(emoji, {
            count: existing.count + 1,
            reactedByMe: existing.reactedByMe || isMine,
            myReactionId: isMine ? ev.id : existing.myReactionId,
        });
    });
    return Array.from(counts.entries())
        .map(([emoji, data]) => ({ emoji, ...data }))
        .sort((a, b) => b.count - a.count);
}

export async function publishReaction(eventId: string, authorPubkey: string, emoji: string): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) return false;
    const event = new NDKEvent(ndk);
    event.kind = 7;
    event.content = emoji;
    event.tags = [['e', eventId], ['p', authorPubkey], ['client', 'bikel']];
    try { await event.publish(); return true; } catch (e) { console.error('[Nostr] Failed to publish reaction', e); return false; }
}

export async function deleteReaction(reactionId: string): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) return false;
    const event = new NDKEvent(ndk);
    event.kind = 5;
    event.content = 'deleted';
    event.tags = [['e', reactionId], ['k', '7']];
    try { await event.publish(); return true; } catch (e) { return false; }
}

/**
 * Helper to convert a raw NDKEvent into a RideComment object with Bikel-specific filtering.
 */
export function eventToComment(e: NDKEvent, searchEvents: Set<NDKEvent> = new Set()): RideComment | null {
    const isRide = e.kind === 1301 || e.kind === 33301;
    const isBikelClient = e.getMatchingTags('client').some(t => t[1] === 'bikel');
    const hasBikelTag = e.getMatchingTags('t').some(t => ['bikel', 'bikeride', 'fixie', 'biketour', 'cycling', 'bicycle', 'bike', 'mountainbike', 'fixedgear', 'fixedgearbike', 'fixedgearbicycle', 'bikepacking', 'gravel', 'mtb', 'roadbike', 'cyclinglife', 'cyclist', 'velo'].includes(t[1].toLowerCase()));

    // For ride events: only include bikel-tagged to exclude RunSTR walking workouts
    if (isRide && !hasBikelTag) return null;

    const referencedEventId = e.tags.find(t => t[0] === 'e')?.[1] || '';
    const fromSearch = searchEvents.has(e);

    // For kind-1 posts: need a bikel tag, or an #e ref to a ride, or came from search
    if (!isRide && !hasBikelTag && !referencedEventId && !fromSearch) return null;

    // Skip very short content (spam/bots)
    if (!isRide && e.content.trim().length < 5) return null;

    // For search results: verify content actually contains bike keywords
    if (fromSearch && !hasBikelTag) {
        const contentLower = e.content.toLowerCase();
        const hasBikeWord = ['bicycle', 'fixie', 'cycling', 'bike', 'biking', 'cyclist', 'velodrome', 'peloton'].some(w => contentLower.includes(w));
        if (!hasBikeWord) return null;
    }

    // Extract rich data from events
    let displayContent = e.content;
    let rideTitle = '';
    let image: string | undefined;
    let distance: string | undefined;
    let duration: string | undefined;

    // Extract image from any event type: 'image' tag, 'imeta' tag, or URL in content
    image = e.getMatchingTags('image')[0]?.[1];
    if (!image) {
        const imeta = e.getMatchingTags('imeta')[0];
        if (imeta) {
            const urlEntry = imeta.find((t: string) => t.startsWith('url '));
            if (urlEntry) image = urlEntry.substring(4);
        }
    }
    if (!image) {
        const urlMatch = e.content.match(
            /https?:\/\/\S+\.(jpg|jpeg|png|webp|gif)|https?:\/\/(image\.nostr\.build|nostr\.build|void\.cat|i\.imgur|cdn\.satellite\.earth)\S*/i
        );
        if (urlMatch) image = urlMatch[0];
    }

    // For kind-1 posts: strip lines that are only a URL
    if (!isRide) {
        const cleaned = e.content.split('\n')
            .filter((line: string) => !/^https?:\/\/\S+$/.test(line.trim()))
            .join('\n')
            .trim();
        displayContent = cleaned.length > 0 ? cleaned : e.content;
    }

    let rawDurationSecs: number | undefined;

    if (isRide) {
        rideTitle = e.getMatchingTags('title')[0]?.[1] || '';
        image = e.getMatchingTags('image')[0]?.[1] || image;
        distance = e.getMatchingTags('distance')[0]?.[1];
        const durationRaw = e.getMatchingTags('duration')[0]?.[1];
        if (durationRaw) {
            const secs = parseInt(durationRaw, 10);
            if (!isNaN(secs)) {
                rawDurationSecs = secs;
                const h = Math.floor(secs / 3600);
                const m = Math.floor((secs % 3600) / 60);
                duration = h > 0 ? `${h}h ${m}m` : `${m}m`;
            } else {
                duration = durationRaw;
            }
        }
        if (!e.content || e.content.startsWith('{')) {
            displayContent = rideTitle
                ? `${rideTitle}`
                : distance ? `Rode ${parseFloat(distance).toFixed(1)} miles` : 'Shared a ride 🚲';
        }
    }

    return {
        id: e.id,
        pubkey: e.author?.npub || e.pubkey,
        hexPubkey: e.pubkey,
        content: displayContent,
        createdAt: e.created_at || 0,
        rideId: isRide ? e.id : referencedEventId,
        title: rideTitle || undefined,
        isRide,
        image,
        distance,
        duration,
        rawDuration: rawDurationSecs,
        kind: e.kind,
        hasRoute: isRide && (
            !!e.getMatchingTags('g')[0]?.[1] ||
            !!e.getMatchingTags('route')[0]?.[1]
        ),
    };
}

export async function fetchAllBikelSocial(onUpdate?: (data: RideComment[]) => void, rideIds: string[] = [], limit = 50): Promise<RideComment[]> {
    const ndk = await connectNDK();
    const uniqueMap = new Map<string, RideComment>();
    const searchEvents = new Set<NDKEvent>(); // Track which events came from search for filtering

    // Throttling logic
    let lastUpdate = 0;
    let pendingUpdate = false;
    const throttleUpdate = () => {
        if (!onUpdate || pendingUpdate) return;
        const now = Date.now();
        const diff = now - lastUpdate;
        if (diff > 200) {
            onUpdate(Array.from(uniqueMap.values()).sort((a, b) => b.createdAt - a.createdAt));
            lastUpdate = now;
        } else {
            pendingUpdate = true;
            setTimeout(() => {
                onUpdate(Array.from(uniqueMap.values()).sort((a, b) => b.createdAt - a.createdAt));
                lastUpdate = Date.now();
                pendingUpdate = false;
            }, 200 - diff);
        }
    };

    const handleNewEvent = (e: NDKEvent, isFromSearch = false) => {
        if (uniqueMap.has(e.id)) return;
        if (isFromSearch) searchEvents.add(e);
        const comment = eventToComment(e, searchEvents);
        if (comment) {
            uniqueMap.set(e.id, comment);
            throttleUpdate();
        }
    };

    // Hashtag filters — work on all standard relays
    const filters: NDKFilter[] = [
        { kinds: [1 as any], '#t': ['bikel'], limit: 100 },
        { kinds: [1 as any], '#t': ['bikeride'], limit: 50 },
        { kinds: [1 as any], '#t': ['fixie'], limit: 50 },
        { kinds: [1 as any], '#t': ['biketour'], limit: 50 },
        { kinds: [1 as any], '#t': ['mountainbike'], limit: 50 },
        { kinds: [1 as any], '#t': ['cycling'], limit: 50 },
        { kinds: [1 as any], '#t': ['bike'], limit: 50 },
        { kinds: [1 as any], '#t': ['bicycle'], limit: 50 },
        { kinds: [1301 as any], limit: 60 },
    ];

    const searchTerms = ['bicycle', 'fixie', 'cycling', 'biking', 'bike ride'];
    const searchFilters: NDKFilter[] = searchTerms.map(term => ({
        kinds: [1 as any],
        search: term,
        limit: 30,
    } as any));

    if (rideIds.length > 0) {
        const chunks: string[][] = [];
        for (let i = 0; i < Math.min(rideIds.length, 24); i += 8) {
            chunks.push(rideIds.slice(i, i + 8));
        }
        chunks.forEach(chunk => filters.push({ kinds: [1 as any], '#e': chunk, limit: 50 }));
    }

    console.log(`[Nostr] Fetching social activity...`);

    // Run fetches in parallel with streaming callbacks
    await Promise.all([
        fetchEventsWithTimeout(ndk, filters, 6000, e => handleNewEvent(e)),
        (async () => {
            try {
                const searchNdk = new NDK({
                    explicitRelayUrls: NIP50_RELAYS,
                    signer: ndk.signer,
                });
                await searchNdk.connect(1000);
                return await fetchEventsWithTimeout(searchNdk, searchFilters, 3500, e => handleNewEvent(e, true));
            } catch (e) {
                console.warn('[Social] NIP-50 search failed:', e);
                return new Set<NDKEvent>();
            }
        })(),
    ]);

    return Array.from(uniqueMap.values()).sort((a, b) => b.createdAt - a.createdAt);
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
    const events = await fetchEventsWithTimeout(ndk, [filterSent, filterReceived], 8000);
    const messages: DMessage[] = [];
    await Promise.all(Array.from(events).map(async (event) => {
        try {
            await event.decrypt(otherUser, ndk.signer!, 'nip04');
            messages.push({ id: event.id, sender: event.pubkey, recipient: event.getMatchingTags('p')[0]?.[1] || '', text: event.content, createdAt: event.created_at || Math.floor(Date.now() / 1000) });
        } catch (e) { console.warn(`[Nostr - Mobile] Failed to decrypt DM ${event.id}`, e); }
    }));
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

export interface ApprovedBot {
    name: string;
    pubkey: string;
    description?: string;
    image?: string;
    feePct?: number;
}

/**
 * Fetches the list of approved sponsorship bots from bikel.ink
 */
export async function fetchApprovedBots(): Promise<ApprovedBot[]> {
    try {
        console.log('[Nostr] Discovering Bikel bots via Kind 33400...');
        const ndk = await connectNDK();

        // Query for bot announcements with a generous 20s timeout
        const events = await fetchEventsWithTimeout(ndk, [{
            kinds: [33400 as any],
            '#t': ['bikel-bot', 'bikel']
        }], 20000);

        if (!events || events.size === 0) {
            console.warn('[Nostr] No bots found on relays.');
            return [];
        }

        const botsMap = new Map<string, ApprovedBot>();

        // Sort by created_at desc to get the latest announcement for each bot
        const sorted = Array.from(events).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

        const currentTime = Math.floor(Date.now() / 1000);
        for (const event of sorted) {
            if (botsMap.has(event.pubkey)) continue;

            const expiration = parseInt(event.getMatchingTags('expiration')[0]?.[1] || '0', 10);
            if (expiration > 0 && expiration < currentTime) continue; // Skip expired announcements

            const name = event.getMatchingTags('name')[0]?.[1] || "Unnamed Bot";
            const description = event.getMatchingTags('description')[0]?.[1] || event.content || "";
            const image = event.getMatchingTags('image')[0]?.[1] || "";
            const feePct = parseFloat(event.getMatchingTags('fee')[0]?.[1] || '5');

            botsMap.set(event.pubkey, {
                name,
                pubkey: event.pubkey,
                description,
                image,
                feePct
            });
        }

        const found = Array.from(botsMap.values());
        console.log(`[Nostr] Discovered ${found.length} bot(s) on network.`);
        return found;
    } catch (e) {
        console.error('[Nostr] Failed decentralized bot discovery:', e);
        return [];
    }
}

export interface Claim {
    id: string; // The Nostr event ID of the claim
    checkpointId: string;
    rideId?: string;
    timestamp: number;
}

/**
 * Fetches all reward "claims" (Kind 1 notes with t=bikel_bonus) associated with the current user.
 * This allows the UI to show progress even if the user's ride events don't have checkpoint tags.
 */
export async function fetchMyClaims(): Promise<Claim[]> {
    try {
        const ndk = await connectNDK();
        const signer = await getSigner();
        const user = await signer.user();

        console.log(`[Nostr] Fetching claims for ${user.pubkey.substring(0, 8)}...`);

        const filter: NDKFilter = {
            kinds: [1],
            '#p': [user.pubkey],
            '#t': ['bikel_bonus']
        };

        const events = await fetchEventsWithTimeout(ndk, [filter], 8000);
        const claims: Claim[] = [];

        for (const event of events) {
            const cpId = event.getMatchingTags('e').find(t => t[3] === 'mention')?.[1] ||
                event.getMatchingTags('e')[0]?.[1];

            const rideId = event.getMatchingTags('e').find(t => t[3] === 'context')?.[1];

            if (cpId) {
                claims.push({
                    id: event.id,
                    checkpointId: cpId,
                    rideId,
                    timestamp: event.created_at || 0
                });
            }
        }

        console.log(`[Nostr] Found ${claims.length} claim(s).`);
        return claims;
    } catch (e) {
        console.error('[Nostr] Failed to fetch claims:', e);
        return [];
    }
}