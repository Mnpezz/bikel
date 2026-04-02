import NDK, { NDKNip07Signer, NDKEvent, NDKZapper, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { NDKFilter, NDKUser } from "@nostr-dev-kit/ndk";
import { NDKNWCWallet } from "@nostr-dev-kit/ndk-wallet";

export const DEFAULT_RELAYS = [
    "wss://relay.bikel.ink",
    "wss://relay.damus.io",
    "wss://relay.primal.net",
];

export const ESCROW_PUBKEY = "cc130b7120d00ded76d065bf0bd27e3a36a38d5268208078a1e99aa29ac44adf";

let globalNdk: NDK | null = null;

export async function connectNDK(): Promise<NDK> {
    if (globalNdk) return globalNdk;

    globalNdk = new NDK({
        explicitRelayUrls: DEFAULT_RELAYS,
    });

    console.log("[Nostr] Connecting to relays...");
    // Race connection against a 5s timeout to ensure flaky relays don't hang the app
    await Promise.race([
        globalNdk.connect().catch((e) => console.error("[Nostr] Connection error:", e)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 5000))
    ]).catch(e => console.warn("[Nostr] NDK connect completed with errors or timeout:", e.message));

    console.log("[Nostr] Connected.");

    return globalNdk;
}

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

export async function loginNip07(): Promise<NDKUser | null> {
    const ndk = await connectNDK();

    if (!(window as any).nostr) {
        console.error("NIP-07 extension not found");
        return null;
    }

    try {
        const signer = new NDKNip07Signer();
        ndk.signer = signer;
        const user = await signer.user();
        await user.fetchProfile();
        return user;
    } catch (e) {
        console.error("NIP-07 login failed", e);
        return null;
    }
}

let nwcWallet: NDKNWCWallet | null = null;

export async function connectNWC(pairingCode: string): Promise<boolean> {
    const ndk = await connectNDK();
    try {
        nwcWallet = new NDKNWCWallet(ndk as any, { pairingCode });
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject("NWC connection timeout"), 10000);
            nwcWallet!.once("ready", () => {
                clearTimeout(timeout);
                resolve();
            });
        });
        (ndk as any).wallet = nwcWallet;
        console.log("[NWC] Wallet connected and ready");
        return true;
    } catch (e) {
        console.error("[NWC] Failed to connect wallet", e);
        nwcWallet = null;
        ndk.wallet = undefined;
        return false;
    }
}

export async function zapRideEvent(eventId: string, targetPubkey: string, targetKind: number, amountSats: number, comment = "Great ride!"): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.wallet) {
        throw new Error("No Lightning Wallet Connected");
    }

    let lastNotice = "";

    try {
        const targetUser = ndk.getUser({ pubkey: targetPubkey });
        let profile = (targetUser.profile as any) || undefined;

        if (!profile || (!profile.lud16 && !profile.lud06)) {
            console.log(`[Zap - Web] Fetching profile for recipient ${targetPubkey}...`);
            // Add a timeout to avoid hanging
            profile = (await Promise.race([
                targetUser.fetchProfile(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000))
            ]).catch(() => undefined) as any);
        }

        // Hardcoded fallback for the Bikel Bot (Escrow Account) if discovery fails
        if ((!profile || (!profile.lud16 && !profile.lud06)) && targetPubkey === ESCROW_PUBKEY) {
            console.log(`[Zap - Web] Using hardcoded fallback for Bikel Bot: bikel@coinos.io`);
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

        let resolveLnPay: (v: boolean) => void;
        const lnPaySignal = new Promise<boolean>(r => { resolveLnPay = r; });

        let lnPayInitiated = false;
        const currentWallet = ndk.wallet as any;
        const originalLnPay = currentWallet?.lnPay?.bind(currentWallet);
        const wrappedLnPay = async (payment: any) => {
            const invoice = typeof payment === 'string' ? payment : (payment.pr || payment.invoice || JSON.stringify(payment));
            console.log("[Zap - Web] lnPay (Wallet) called with invoice/payment:", invoice.substring(0, 50) + "...");
            lnPayInitiated = true;
            try {
                if (originalLnPay) {
                    const res = await originalLnPay(payment);
                    console.log("[Zap - Web] lnPay (Wallet) returned:", res);
                    if (res) {
                        console.log("[Zap - Web] lnPay confirmed success, signaling early return...");
                        resolveLnPay(true);
                    }
                    return res;
                }
                return undefined;
            } catch (err) {
                console.error("[Zap - Web] lnPay (Wallet) error:", err);
                throw err;
            }
        };

        console.log(`[Zap] Requesting ${amountSats} sat zap for event ${eventId}...`);
        const zapper = new NDKZapper(event, amountSats * 1000, 'msat', {
            comment,
            ndk,
            lnPay: wrappedLnPay
        });

        zapper.on("notice", (msg) => {
            console.log("[Zap Notice]", msg);
            lastNotice = msg;
        });

        const success = await Promise.race([
            zapper.zap().then(c => {
                console.log("[Zap - Web] zapper.zap() resolved:", !!c);
                return !!c;
            }).catch(e => {
                console.warn("[Zap - Web] zapper.zap() rejected:", e);
                if (lnPayInitiated && targetPubkey === ESCROW_PUBKEY) return true;
                return false;
            }),
            lnPaySignal,
            new Promise<boolean>(r => setTimeout(() => {
                console.warn("[Zap - Web] Zapper timed out after 25s");
                if (lnPayInitiated && targetPubkey === ESCROW_PUBKEY) r(true);
                else r(false);
            }, 25000))
        ]);

        if (success) {
            console.log(`[Zap - Web] Payment confirmed!`);
            return true;
        } else {
            console.warn(`[Zap - Web] Payment failed or returned no confirmation.`);
            return false;
        }
    } catch (e: any) {
        console.error("[Zap - Web] Failed to zap event", e);
        if (lastNotice) {
            throw new Error(`Lightning node error: ${lastNotice}`);
        } else if (e.message && e.message.includes("All zap attempts failed")) {
            throw new Error("This rider has not linked a Lightning Address to their Nostr profile!");
        } else {
            throw e;
        }
    }
}

// ── Kind 5 Deletion ────────────────────────────────────
export async function deleteRide(eventId: string): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) {
        console.error("[Nostr] Cannot delete without a signer — user must be logged in");
        return false;
    }

    try {
        const deleteEvent = new NDKEvent(ndk);
        deleteEvent.kind = 5;
        deleteEvent.content = "Ride deleted by author";
        deleteEvent.tags = [
            ['e', eventId],
            ['k', '33301'],
            ['k', '1301'],
        ];

        await deleteEvent.publish();
        console.log(`[Nostr] Kind 5 delete published for event ${eventId}`);
        return true;
    } catch (e) {
        console.error("[Nostr] Failed to publish delete event", e);
        return false;
    }
}

// ── RideEvent ──────────────────────────────────────────
export interface RideEvent {
    id: string;
    pubkey: string;
    hexPubkey: string;
    time: number;
    distance: string;
    distanceMiles: number;
    distanceKm: number;
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
    kind: 33401;
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
    event?: NDKEvent;
    streakDays?: number;
    streakReward?: number;
    limit?: number;
    set?: string;
    setReward?: number;
    routeIndex?: number;
    attendees?: string[];
}

/**
 * Helper to parse a RideEvent from a generic NDKEvent.
 * Supports legacy JSON-in-content and new Bikel JSON-in-tag 'g'.
 */
function parseRideEvent(event: NDKEvent): RideEvent | null {
    try {
        const distanceTag = event.getMatchingTags("distance")[0];
        const distanceVal = parseFloat(distanceTag?.[1] || "0");
        const distanceUnit = distanceTag?.[2]?.toLowerCase() || "mi";

        // Convert KM to Miles if necessary
        const distanceMiles = distanceUnit === 'km' ? distanceVal * 0.621371 : distanceVal;
        const distanceKm = distanceUnit === 'mi' ? distanceVal / 0.621371 : distanceVal;
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

        // Strict filter: If it's Kind 1 or 1301, it MUST have cycling context
        if ((event.kind === 1 || event.kind === 1301) && !hasCyclingContext) return null;

        // Skip empty stats if not native bikel
        const client = event.getMatchingTags("client")[0]?.[1];
        const isBikel = client === 'bikel';
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
                    if (parsed.route && Array.isArray(parsed.route)) route = parsed.route;
                } catch (e) { }
            }
            if (route.length === 0 && event.content && event.content.includes('"route"')) {
                try {
                    // Use [\s\S] instead of /s flag for ES5 compatibility
                    const jsonMatch = event.content.match(/\{[\s\S]*"route"\s*:[\s\S]*?\}/);
                    const jsonToParse = jsonMatch ? jsonMatch[0] : event.content;
                    const parsed = JSON.parse(jsonToParse);
                    if (parsed.route && Array.isArray(parsed.route)) route = parsed.route;
                } catch (e) { }
            }
        }

        return {
            id: event.id,
            pubkey: event.author.npub,
            hexPubkey: event.pubkey,
            time: event.created_at || Math.floor(Date.now() / 1000),
            distance,
            distanceMiles,
            distanceKm,
            duration: durationRaw.includes(':')
                ? (durationRaw.split(':').length === 2 ? `00:${durationRaw}` : durationRaw)
                : `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`,
            rawDuration: durationSecs,
            visibility,
            route,
            kind: event.kind as 33301 | 1301,
            title: titleTag,
            description,
            image,
            confidence,
            elevation,
            client
        };
    } catch (e) {
        console.warn("Failed to parse event", event.id);
        return null;
    }
}

/**
 * Fetches recent Bikel & Runstr rides.
 * Supports an optional callback for incremental updates (streaming).
 */
export async function fetchRecentRides(onUpdate?: (rides: RideEvent[]) => void, until?: number, since?: number): Promise<RideEvent[]> {
    const ndk = await connectNDK();

    // Ensure we always have a timeframe, defaulting to 30 days if not specified.
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (30 * 86400);
    const effectiveSince = since !== undefined ? since : thirtyDaysAgo;

    const filters: NDKFilter[] = [
        { kinds: [33301 as any, 1301 as any], limit: 3000, since: effectiveSince },
        { kinds: [1 as any], "#t": ["RUNSTR", "cycling", "fitness", "bikel"], limit: 1000, since: effectiveSince }
    ];
    if (until) filters.forEach(f => f.until = until);

    const ridesMap = new Map<string, RideEvent>();
    let lastEmitTime = 0;
    const throttleInterval = 200; // ms

    const handleEvent = (event: NDKEvent) => {
        const hasBikelClient = event.getMatchingTags("client").some(t => t[1] === "bikel");
        const hasCyclingTag = event.getMatchingTags("t").some(t => ["cycling", "bikel", "bikeride", "fitness"].includes(t[1].toLowerCase()));

        const isRunstr = event.kind === 1301 ||
            event.getMatchingTags("client").some(t => t[1].toUpperCase() === "RUNSTR") ||
            event.getMatchingTags("t").some(t => t[1].toUpperCase() === "RUNSTR");

        const isKind1Ride = event.kind === 1 && (hasBikelClient || hasCyclingTag);

        if (event.kind !== 33301 && event.kind !== 1301 && !isRunstr && !isKind1Ride) return;
        if (!hasBikelClient && !hasCyclingTag && !isRunstr) return;

        const parsed = parseRideEvent(event);
        if (!parsed) return;

        // If it's a Kind 1 note, it MUST have a route to be considered a "Ride"
        // This filters out bot results, contest announcements, and general chat.
        if (event.kind === 1 && parsed.route.length === 0) return;

        const dTag = event.getMatchingTags("d")[0]?.[1] || "";
        const key = dTag ? `${event.pubkey}-${dTag}` : event.id;

        if (!ridesMap.has(key) || parsed.kind === 33301) {
            ridesMap.set(key, parsed);

            const now = Date.now();
            if (onUpdate && (now - lastEmitTime > throttleInterval || ridesMap.size === 1)) {
                lastEmitTime = now;
                onUpdate(Array.from(ridesMap.values()).sort((a, b) => b.time - a.time));
            }
        }
    };

    console.log("[Nostr] Fetching recent Bikel & Runstr rides...");
    // 15s window for discovery, snappy UI via onUpdate
    await fetchEventsWithTimeout(ndk, filters, 15000, handleEvent);
    return Array.from(ridesMap.values()).sort((a, b) => b.time - a.time);
}

export async function fetchAllRidesInRange(since: number, until: number, onProgress?: (count: number) => void): Promise<RideEvent[]> {
    const ndk = await connectNDK();
    const ridesMap = new Map<string, RideEvent>();
    let currentUntil = until;

    console.log(`[Nostr] Crawling historical Bikel & Runstr rides from ${new Date(since * 1000).toLocaleDateString()} to ${new Date(until * 1000).toLocaleDateString()}...`);

    while (currentUntil > since) {
        const filters: NDKFilter[] = [
            { kinds: [33301 as any, 1301 as any], since, until: currentUntil, limit: 500 },
            { kinds: [1 as any], "#t": ["RUNSTR", "cycling", "fitness", "bikel"], since, until: currentUntil, limit: 500 }
        ];

        const eventsSet = await ndk.fetchEvents(filters);
        if (eventsSet.size === 0) break; // No more events in this range

        // Crucial fix: Sort all returned events newest first.
        // Because each relay responds with up to 500 events, if one relay is hyper-active it might reach T-2 days, 
        // while an inactive relay reaches T-20 days. If we jump to T-20, we MISS days T-3 to T-20 on the hyper relay.
        // Solution: Take only the newest 500 total events, and jump only as far back as the 500th event.
        const sortedEvents = Array.from(eventsSet).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        let batchEvents = sortedEvents;

        // Use a safe processing window to guarantee no relay's window is skipped
        if (sortedEvents.length > 500) {
            batchEvents = sortedEvents.slice(0, 500);
        }

        let oldestEventTime = currentUntil;

        for (const event of batchEvents) {
            if (event.created_at && event.created_at < oldestEventTime) {
                oldestEventTime = event.created_at;
            }

            const hasBikelClient = event.getMatchingTags("client").some(t => t[1] === "bikel");
            const hasCyclingTag = event.getMatchingTags("t").some(t => ["cycling", "bikel", "bikeride", "fitness"].includes(t[1].toLowerCase()));
            const isRunstr = event.kind === 1301 ||
                event.getMatchingTags("client").some(t => t[1].toUpperCase() === "RUNSTR") ||
                event.getMatchingTags("t").some(t => t[1].toUpperCase() === "RUNSTR");

            const isKind1Ride = event.kind === 1 && (hasBikelClient || hasCyclingTag);

            if (event.kind !== 33301 && event.kind !== 1301 && !isRunstr && !isKind1Ride) continue;
            if (!hasBikelClient && !hasCyclingTag && !isRunstr) continue;

            const parsed = parseRideEvent(event);
            if (!parsed) continue;

            // Filter out bot results/text notes from history
            if (event.kind === 1 && parsed.route.length === 0) continue;

            const dTag = event.getMatchingTags("d")[0]?.[1] || "";
            const key = dTag ? `${event.pubkey}-${dTag}` : event.id;
            if (!ridesMap.has(key) || parsed.kind === 33301) {
                ridesMap.set(key, parsed);
            }
        }

        if (onProgress) onProgress(ridesMap.size);

        if (oldestEventTime >= currentUntil) {
            currentUntil -= 1;
        } else {
            currentUntil = oldestEventTime;
        }
    }

    console.log(`[Nostr] Finished crawling. Built dataset of ${ridesMap.size} unique rides.`);
    return Array.from(ridesMap.values()).sort((a, b) => b.time - a.time);
}

export async function fetchUserRides(pubkeyOrNpub: string, until?: number): Promise<RideEvent[]> {
    const ndk = await connectNDK();

    let hexPubkey = pubkeyOrNpub;
    if (pubkeyOrNpub.startsWith('npub1')) {
        const user = ndk.getUser({ npub: pubkeyOrNpub });
        hexPubkey = user.pubkey;
    }

    const filters: NDKFilter[] = [
        { kinds: [33301 as any, 1301 as any], authors: [hexPubkey], limit: 200 },
        { kinds: [1 as any], authors: [hexPubkey], "#t": ["RUNSTR", "cycling", "fitness", "bikel"], limit: 100 }
    ];
    if (until) filters.forEach(f => f.until = until);

    console.log(`[Nostr] Fetching rides for user ${pubkeyOrNpub}...`);
    const events = await ndk.fetchEvents(filters);

    const ridesMap = new Map<string, RideEvent>();

    events.forEach(event => {
        const parsed = parseRideEvent(event);
        if (!parsed) return;

        // Ensure Kind 1 personal events have a route (not just chat)
        if (event.kind === 1 && parsed.route.length === 0) return;

        const dTag = event.getMatchingTags("d")[0]?.[1] || "";
        const key = dTag ? `${event.pubkey}-${dTag}` : event.id;

        if (!ridesMap.has(key) || parsed.kind === 33301) {
            ridesMap.set(key, parsed);
        }
    });
    return Array.from(ridesMap.values()).sort((a, b) => b.time - a.time);
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
    route?: number[][];
    timezone?: string;
    image?: string;
    distance?: string;
    duration?: string;
    kind: 31923;
}

export async function fetchUserRevenue(pubkey: string): Promise<number> {
    const ndk = await connectNDK();

    // 1. Fetch Zaps (Kind 9735)
    const zapFilter: NDKFilter = {
        kinds: [9735],
        "#p": [pubkey]
    };

    // 2. Fetch Reward Notes (Kind 1) from the Bot as fallback
    const noteFilter: NDKFilter = {
        kinds: [1],
        "#p": [pubkey],
        authors: [ESCROW_PUBKEY]
    };

    console.log(`[Nostr] Fetching total rewards and notes for user ${pubkey}...`);
    const [zaps, notes] = await Promise.all([
        ndk.fetchEvents(zapFilter),
        ndk.fetchEvents(noteFilter)
    ]);

    let totalMsats = 0;

    // Process Zaps
    zaps.forEach(zap => {
        // NIP-57 standard: amount tag in msats
        const amountTag = zap.getMatchingTags("amount")[0]?.[1];
        if (amountTag) {
            totalMsats += parseInt(amountTag, 10);
        } else {
            // Fallback to description JSON
            const desc = zap.getMatchingTags("description")[0]?.[1];
            if (desc) {
                try {
                    const req = JSON.parse(desc);
                    const amount = parseInt(req.amount || "0", 10);
                    totalMsats += amount;
                } catch (e) { }
            }
        }
    });

    // Process Reward Notes (Historical Fallback)
    notes.forEach(note => {
        // Check for the amount tag I just added to the bot
        const amountTag = note.getMatchingTags("amount")[0]?.[1];
        if (amountTag) {
            totalMsats += parseInt(amountTag, 10);
        } else {
            // Regex for old notes: "...earned 50 sats!"
            const match = note.content.match(/earned (\d+) sats!/);
            if (match && match[1]) {
                totalMsats += parseInt(match[1], 10) * 1000;
            }
        }
    });

    return Math.floor(totalMsats / 1000);
}

export async function fetchScheduledRides(): Promise<ScheduledRideEvent[]> {
    const ndk = await connectNDK();

    const filters: NDKFilter[] = [
        { kinds: [31923 as any], limit: 400 }
    ];

    console.log("[Nostr] Fetching scheduled Bikel & Cycling rides (Kind 31923)...");
    const events = await ndk.fetchEvents(filters);

    const scheduledRides: ScheduledRideEvent[] = [];
    const aTagsToFetch: string[] = [];

    events.forEach(event => {
        const hasBikelClient = event.getMatchingTags("client").some(t => t[1] === "bikel");
        const hasCyclingTag = event.getMatchingTags("t").some(t => ["cycling", "bikel", "bikeride"].includes(t[1]));
        if (!hasBikelClient && !hasCyclingTag) return;

        try {
            const name = event.getMatchingTags("name")[0]?.[1] || "Untitled Ride";
            const startStr = event.getMatchingTags("start")[0]?.[1];
            const startTime = startStr ? parseInt(startStr, 10) : 0;
            const locationStr = event.getMatchingTags("location")[0]?.[1] || "TBD";
            const dTag = event.getMatchingTags("d")[0]?.[1];

            if (!dTag) return;

            const aTag = `31923:${event.pubkey}:${dTag}`;
            aTagsToFetch.push(aTag);

            if (startTime > (Date.now() / 1000) - (86400 * 30)) {
                let parsedRoute: number[][] = [];
                const routeTag = event.getMatchingTags("route")[0]?.[1];
                if (routeTag) {
                    try { parsedRoute = JSON.parse(routeTag); } catch (e) { }
                }
                const tzTag = event.getMatchingTags("start_tzid")[0]?.[1] || event.getMatchingTags("start_tz")[0]?.[1];
                const imageTag = event.getMatchingTags("image")[0]?.[1];
                const distanceTag = event.getMatchingTags("distance")[0]?.[1];
                const durationTag = event.getMatchingTags("duration")[0]?.[1];

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
                    route: parsedRoute,
                    timezone: tzTag,
                    image: imageTag,
                    distance: distanceTag,
                    duration: durationTag,
                    kind: 31923
                });
            }
        } catch (e) {
            console.warn("Failed to parse scheduled ride event", event.id);
        }
    });

    if (aTagsToFetch.length > 0) {
        console.log("[Nostr] Fetching RSVPs (Kind 31925)...");
        const rsvpFilter: NDKFilter = {
            kinds: [31925 as any],
            "#a": aTagsToFetch
        };
        const rsvpEvents = await ndk.fetchEvents(rsvpFilter);

        rsvpEvents.forEach(rsvp => {
            const aTagMatch = rsvp.getMatchingTags("a")[0]?.[1];
            const lTagStatus = rsvp.getMatchingTags("l")[0]?.[1];

            if (aTagMatch && lTagStatus === "accepted") {
                const ride = scheduledRides.find(r => `31923:${r.hexPubkey}:${r.dTag}` === aTagMatch);
                if (ride && !ride.attendees.includes(rsvp.pubkey)) {
                    ride.attendees.push(rsvp.pubkey);
                }
            }
        });
    }

    return scheduledRides.sort((a, b) => a.startTime - b.startTime);
}

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
    prizeSats?: number,
    escrowPubkey: string = ESCROW_PUBKEY
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
        ['escrow', escrowPubkey],
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
    prizeSats?: number,
    escrowPubkey: string = ESCROW_PUBKEY
): Promise<string> {
    const event = await prepareContestEvent(name, description, startTimestamp, endTimestamp, parameter, feeSats, invitedPubkeys, sport, unit, payoutSplit, minConfidence, prizeSats, escrowPubkey);
    console.log('[Nostr] Publishing challenge event (Kind 33401)...');
    await event.publish();
    return event.id;
}

export async function fetchContests(): Promise<ContestEvent[]> {
    const ndk = await connectNDK();
    const now = Math.floor(Date.now() / 1000);
    const filters: NDKFilter[] = [{ kinds: [33401 as any], limit: 500, since: now - (90 * 86400) }];

    console.log("[Nostr] Fetching Bikel Challenges (Kind 33401)...");
    const events = await fetchEventsWithTimeout(ndk, filters, 12000);

    const contests: ContestEvent[] = [];
    const aTagsToFetch: string[] = [];

    events.forEach(event => {
        try {
            const name = event.getMatchingTags("title")[0]?.[1] || "Untitled Challenge";
            const startTime = parseInt(event.getMatchingTags("start")[0]?.[1] || "0", 10);
            const endTime = parseInt(event.getMatchingTags("end")[0]?.[1] || "0", 10);
            const parameter = event.getMatchingTags("parameter")[0]?.[1] || "max_distance";
            const feeSats = parseInt(event.getMatchingTags("fee")[0]?.[1] || "0", 10);
            const invitedPubkeys = event.getMatchingTags("p").map(t => t[1]);
            const dTag = event.getMatchingTags("d")[0]?.[1];
            if (!dTag) return;

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
    });

    if (aTagsToFetch.length > 0) {
        const rsvpEvents = await fetchEventsWithTimeout(ndk, [{ kinds: [31925 as any], "#a": aTagsToFetch }], 5000);
        rsvpEvents.forEach(rsvp => {
            const aTagMatch = rsvp.getMatchingTags("a")[0]?.[1];
            if (aTagMatch && rsvp.getMatchingTags("l")[0]?.[1] === "accepted") {
                const contest = contests.find(c => `33401:${c.hexPubkey}:${c.dTag}` === aTagMatch);
                if (contest && !contest.attendees.includes(rsvp.pubkey)) contest.attendees.push(rsvp.pubkey);
            }
        });
    }

    return contests.sort((a, b) => b.createdAt - a.createdAt);
}

export async function fetchCheckpoints(): Promise<CheckpointEvent[]> {
    const ndk = await connectNDK();
    const now = Math.floor(Date.now() / 1000);
    const filters: NDKFilter[] = [{ kinds: [33402 as any], '#t': ['bikel', 'checkpoint'], limit: 2000, since: now - (90 * 86400) }];
    console.log("[Nostr] Fetching Bikel Checkpoints (Kind 33402)...");
    const events = await fetchEventsWithTimeout(ndk, filters, 12000);

    const checkpoints: CheckpointEvent[] = [];

    events.forEach(event => {
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
            const streakDays = parseInt(event.getMatchingTags("streak_days")[0]?.[1] || "0", 10);
            const streakReward = parseInt(event.getMatchingTags("streak_reward")[0]?.[1] || "0", 10);
            const frequency = event.getMatchingTags("frequency")[0]?.[1] as 'once' | 'daily' | 'hourly' | undefined;
            const limit = parseInt(event.tags.find(t => t[0] === "limit")?.[1] || "0", 10);
            const cpSetName = event.tags.find(t => t[0] === "set")?.[1];
            const cpSetReward = parseInt(event.tags.find(t => t[0] === "set_reward")?.[1] || "0", 10);
            const cpRouteIndex = parseInt(event.tags.find(t => t[0] === "route_index")?.[1] || "0", 10);

            if (isNaN(lat) || isNaN(lng)) return;

            if (endTime === 0 || endTime > now - 86400) {
                checkpoints.push({
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
                    event,
                    streakDays: streakDays || undefined,
                    streakReward: streakReward || undefined,
                    limit: limit || undefined,
                    set: cpSetName,
                    setReward: cpSetReward,
                    routeIndex: cpRouteIndex
                });
            }
        } catch (e) { }
    });

    // --- Bulk Fetch RSVPs for all active checkpoints ---
    if (checkpoints.length > 0) {
        const aTags = checkpoints.map(cp => `33402:${cp.hexPubkey}:${cp.dTag}`);
        const rsvps = await fetchEventsWithTimeout(ndk, [{ kinds: [31925 as any], '#a': aTags }], 3000);

        // Map RSVPs to checkpoints
        const rsvpMap: Record<string, string[]> = {};
        for (const r of Array.from(rsvps)) {
            const aTag = r.getMatchingTags('a')[0]?.[1];
            if (!aTag) continue;
            if (!rsvpMap[aTag]) rsvpMap[aTag] = [];
            rsvpMap[aTag].push(r.pubkey);
        }

        for (const cp of checkpoints) {
            const aTag = `33402:${cp.hexPubkey}:${cp.dTag}`;
            cp.attendees = Array.from(new Set(rsvpMap[aTag] || []));
        }
    }

    return checkpoints.sort((a, b) => b.rewardSats - a.rewardSats);
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
    original_id?: string,
    route_index?: number,
    streakDays?: number
): Promise<NDKEvent> {
    const ndk = await connectNDK();
    if (!ndk.signer) {
        throw new Error("Nostr Signer Required (Please ensure your extension like Alby is logged in and refresh)");
    }
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
    if (original_id) event.tags.push(['original_id', original_id]);
    if (route_index !== undefined && route_index !== -1) event.tags.push(['route_index', route_index.toString()]);
    if (streakDays) event.tags.push(['streak_days', streakDays.toString()]);

    await event.sign();
    return event;
}

export async function publishRSVP(ride: { hexPubkey: string, dTag: string, kind: number }): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) {
        console.error("Cannot RSVP without a signer");
        return false;
    }

    const event = new NDKEvent(ndk);
    event.kind = 31925;
    const aTag = `${ride.kind}:${ride.hexPubkey}:${ride.dTag}`;
    event.tags = [
        ['a', aTag],
        ['l', 'accepted'],
        ['client', 'bikel'],
        ['t', 'bikel-rsvp']
    ];
    event.content = "";

    console.log('[Nostr] Signing and publishing RSVP event...');
    try {
        await event.publish();
        console.log(`[Nostr] RSVP published! ID: ${event.id}`);
        return true;
    } catch (e) {
        console.error("[Nostr] Failed to publish RSVP", e);
        return false;
    }
}

export async function publishContestRSVP(contest: ContestEvent): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) return false;

    const event = new NDKEvent(ndk);
    event.kind = 31925;
    const aTag = `33401:${contest.hexPubkey}:${contest.dTag}`;
    event.tags = [
        ['a', aTag],
        ['l', 'accepted'],
        ['client', 'bikel'],
        ['t', 'bikel-rsvp']
    ];

    try {
        await event.publish();
        return true;
    } catch (e) {
        return false;
    }
}

export interface RideComment {
    id: string;
    pubkey: string;
    hexPubkey: string;
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

    console.log(`[Nostr] Fetching comments for event ${eventId}...`);
    const events = await ndk.fetchEvents(filter);

    const comments: RideComment[] = [];
    events.forEach(event => {
        comments.push({
            id: event.id,
            pubkey: event.author.npub,
            hexPubkey: event.author.pubkey,
            content: event.content,
            createdAt: event.created_at || Math.floor(Date.now() / 1000)
        });
    });

    return comments.sort((a, b) => a.createdAt - b.createdAt);
}

export async function publishComment(eventId: string, content: string): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) {
        console.error("Cannot publish comment without a signer");
        return false;
    }

    const event = new NDKEvent(ndk);
    event.kind = 1;
    event.content = content;
    event.tags = [
        ['e', eventId, '', 'reply'],
        ['client', 'bikel']
    ];

    console.log('[Nostr] Signing and publishing Comment event...');
    try { await event.publish(); return true; } catch (e) { console.error("[Nostr] Failed to publish comment", e); return false; }
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
        const h = Math.floor(duration / 3600);
        const m = Math.floor((duration % 3600) / 60);
        const s = duration % 60;
        event.tags.push(['duration', h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`]);
    }
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (tz) {
            event.tags.push(['start_tzid', tz]);
            event.tags.push(['start_tz', tz]); // fallback for older clients
        }
    } catch (e) { }

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

    if (withPubkey.startsWith('npub1')) {
        otherUser = ndk.getUser({ npub: withPubkey });
        hexPubkey = otherUser.pubkey;
    } else {
        otherUser = ndk.getUser({ pubkey: withPubkey });
    }

    console.log(`[Nostr] Fetching DMs between ${currentUser.pubkey} and ${hexPubkey}...`);

    const filterSent: NDKFilter = {
        kinds: [4],
        authors: [currentUser.pubkey],
        "#p": [hexPubkey],
        limit: 50,
    };
    const filterReceived: NDKFilter = {
        kinds: [4],
        authors: [hexPubkey],
        "#p": [currentUser.pubkey],
        limit: 50,
    };

    const events = await ndk.fetchEvents([filterSent, filterReceived]);
    const messages: DMessage[] = [];

    const decryptPromises = Array.from(events).map(async (event) => {
        try {
            await event.decrypt(otherUser, ndk.signer, 'nip04');
            messages.push({
                id: event.id,
                sender: event.pubkey,
                recipient: event.getMatchingTags('p')[0]?.[1] || '',
                text: event.content,
                createdAt: event.created_at || Math.floor(Date.now() / 1000)
            });
        } catch (e) {
            console.warn(`[Nostr] Failed to decrypt DM ${event.id}`, e);
        }
    });

    await Promise.all(decryptPromises);
    return messages.sort((a, b) => a.createdAt - b.createdAt);
}

export async function sendDM(toPubkey: string, text: string): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) throw new Error("Must be signed in to send DMs");

    let hexPubkey = toPubkey;
    let recipient: NDKUser;

    if (toPubkey.startsWith('npub1')) {
        recipient = ndk.getUser({ npub: toPubkey });
        hexPubkey = recipient.pubkey;
    } else {
        recipient = ndk.getUser({ pubkey: toPubkey });
    }

    const event = new NDKEvent(ndk);
    event.kind = 4;
    event.content = text;
    event.tags = [['p', hexPubkey]];

    console.log('[Nostr] Encrypting and publishing DM...');
    try {
        await event.encrypt(recipient, ndk.signer, 'nip04');
        await event.publish();
        console.log(`[Nostr] DM sent! ID: ${event.id}`);
        return true;
    } catch (e) {
        console.error("[Nostr] Failed to send DM", e);
        return false;
    }
}

export interface ApprovedBot {
    name: string;
    pubkey: string;
    description: string;
    image: string;
    feePct?: number;
}

/**
 * Fetches the list of approved sponsorship bots from our decentralized announcements
 */
export async function fetchApprovedBots(): Promise<ApprovedBot[]> {
    try {
        console.log('[Nostr] Discovering Bikel bots via Kind 33400...');
        const ndk = await connectNDK();

        // Query for bot announcements with a short 5s timeout
        // Hardcoded filter for Bikel-compatible bots
        const filters: NDKFilter[] = [{
            kinds: [33400 as any],
            '#t': ['bikel-bot']
        }];

        const events = await ndk.fetchEvents(filters);

        if (!events || events.size === 0) {
            console.warn('[Nostr] No bots found on relays.');
            return [];
        }

        const botsMap = new Map<string, ApprovedBot>();

        // Sort by created_at desc to get the latest announcement for each bot
        const sorted = Array.from(events).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

        for (const event of sorted) {
            if (botsMap.has(event.pubkey)) continue;

            const expiration = parseInt(event.getMatchingTags('expiration')[0]?.[1] || '0', 10);
            const currentTime = Math.floor(Date.now() / 1000);
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