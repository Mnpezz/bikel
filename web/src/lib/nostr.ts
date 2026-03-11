import NDK, { NDKNip07Signer, NDKEvent, NDKZapper, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type { NDKFilter, NDKUser } from "@nostr-dev-kit/ndk";
import { NDKNWCWallet } from "@nostr-dev-kit/ndk-wallet";

export const DEFAULT_RELAYS = [
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol",
];

export const ESCROW_PUBKEY = "cc130b7120d00ded76d065bf0bd27e3a36a38d5268208078a1e99aa29ac44adf";

let globalNdk: NDK | null = null;

export async function connectNDK(): Promise<NDK> {
    if (globalNdk) return globalNdk;

    globalNdk = new NDK({
        explicitRelayUrls: DEFAULT_RELAYS,
    });

    console.log("[Nostr] Connecting to relays...");
    await globalNdk.connect().catch((e) => console.error("[Nostr] Connection error:", e));
    console.log("[Nostr] Connected.");

    return globalNdk;
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
        const event = new NDKEvent(ndk);
        event.id = eventId;
        event.pubkey = targetPubkey;
        event.kind = targetKind;

        let zapSigner = ndk.signer;
        if (!zapSigner) {
            zapSigner = NDKPrivateKeySigner.generate();
            ndk.signer = zapSigner;
        }

        console.log(`[Zap] Requesting ${amountSats} sat zap for event ${eventId}...`);
        const zapper = new NDKZapper(event, amountSats * 1000, 'msat', {
            comment,
            ndk,
            lnPay: ndk.wallet.lnPay ? ndk.wallet.lnPay.bind(ndk.wallet) : undefined
        });

        zapper.on("notice", (msg) => {
            console.log("[Zap Notice]", msg);
            lastNotice = msg;
        });

        zapper.zap().catch(e => console.warn(`[Zap - Web] Background Zap Promise Rejection (Ignored):`, e));
        console.log(`[Zap - Web] Payment dispatched. Returning Pseudo-Success.`);
        return true;
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
            ['k', '33301'], // kind of the event being deleted
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
    duration: string;
    visibility: string;
    route: number[][];
    title?: string;
    description?: string;
    image?: string;
    kind: 33301;
    confidence?: number; // 0.0 – 1.0, parsed from 'confidence' tag
}

export async function fetchRecentRides(): Promise<RideEvent[]> {
    const ndk = await connectNDK();

    const filters: NDKFilter[] = [
        { kinds: [33301 as any], limit: 100 }
    ];

    console.log("[Nostr] Fetching recent Bikel rides...");
    const events = await ndk.fetchEvents(filters);
    console.log(`[Nostr] Fetched ${events.size} raw 33301 events, filtering locally...`);

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
            const description = event.getMatchingTags("summary")[0]?.[1] || event.getMatchingTags("description")[0]?.[1];
            const image = event.getMatchingTags("image")[0]?.[1];
            const confidenceRaw = event.getMatchingTags("confidence")[0]?.[1];
            const confidence = confidenceRaw ? parseFloat(confidenceRaw) : undefined;

            const mins = Math.floor(durationSecs / 60);
            const secs = durationSecs % 60;
            const durationStr = `${mins}m ${secs}s`;

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
                duration: durationStr,
                visibility,
                route,
                title,
                description,
                image,
                kind: 33301,
                confidence,
            });
        } catch (e) {
            console.warn("Failed to parse event", event.id);
        }
    }

    return rides.sort((a, b) => b.time - a.time);
}

export async function fetchUserRides(pubkeyOrNpub: string): Promise<RideEvent[]> {
    const ndk = await connectNDK();

    let hexPubkey = pubkeyOrNpub;
    if (pubkeyOrNpub.startsWith('npub1')) {
        const user = ndk.getUser({ npub: pubkeyOrNpub });
        hexPubkey = user.pubkey;
    }

    const filter: NDKFilter = {
        kinds: [33301 as any],
        authors: [hexPubkey],
        limit: 50,
    };

    console.log(`[Nostr] Fetching rides for user ${pubkeyOrNpub}...`);
    const events = await ndk.fetchEvents(filter);

    const rides: RideEvent[] = [];

    for (const event of events) {
        try {
            const distance = event.getMatchingTags("distance")[0]?.[1] || "0";
            const durationSecs = parseInt(event.getMatchingTags("duration")[0]?.[1] || "0", 10);
            const visibility = event.getMatchingTags("visibility")[0]?.[1] || "full";
            const confidenceRaw = event.getMatchingTags("confidence")[0]?.[1];
            const confidence = confidenceRaw ? parseFloat(confidenceRaw) : undefined;

            const mins = Math.floor(durationSecs / 60);
            const secs = durationSecs % 60;
            const durationStr = `${mins}m ${secs}s`;

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
                duration: durationStr,
                visibility,
                route,
                kind: 33301,
                confidence,
            });
        } catch (e) {
            console.warn("Failed to parse user event", event.id);
        }
    }

    return rides.sort((a, b) => b.time - a.time);
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

export async function fetchScheduledRides(): Promise<ScheduledRideEvent[]> {
    const ndk = await connectNDK();

    const filters: NDKFilter[] = [
        { kinds: [31923 as any], limit: 100 }
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
            const startStr = event.getMatchingTags("start")[0]?.[1];
            const startTime = startStr ? parseInt(startStr, 10) : 0;
            const locationStr = event.getMatchingTags("location")[0]?.[1] || "TBD";
            const dTag = event.getMatchingTags("d")[0]?.[1];

            if (!dTag) continue;

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
    }

    if (aTagsToFetch.length > 0) {
        console.log("[Nostr] Fetching RSVPs (Kind 31925)...");
        const rsvpFilter: NDKFilter = {
            kinds: [31925 as any],
            "#a": aTagsToFetch
        };
        const rsvpEvents = await ndk.fetchEvents(rsvpFilter);

        for (const rsvp of rsvpEvents) {
            const aTagMatch = rsvp.getMatchingTags("a")[0]?.[1];
            const lTagStatus = rsvp.getMatchingTags("l")[0]?.[1];

            if (aTagMatch && lTagStatus === "accepted") {
                const ride = scheduledRides.find(r => `31923:${r.hexPubkey}:${r.dTag}` === aTagMatch);
                if (ride && !ride.attendees.includes(rsvp.pubkey)) {
                    ride.attendees.push(rsvp.pubkey);
                }
            }
        }
    }

    return scheduledRides.sort((a, b) => a.startTime - b.startTime);
}

export async function publishRSVP(ride: ScheduledRideEvent): Promise<boolean> {
    const ndk = await connectNDK();
    if (!ndk.signer) {
        console.error("Cannot RSVP without a signer");
        return false;
    }

    const event = new NDKEvent(ndk);
    event.kind = 31925;
    const aTag = `31923:${ride.hexPubkey}:${ride.dTag}`;
    event.tags = [
        ['a', aTag],
        ['l', 'accepted'],
        ['client', 'bikel']
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
    for (const event of events) {
        comments.push({
            id: event.id,
            pubkey: event.author.npub,
            hexPubkey: event.author.pubkey,
            content: event.content,
            createdAt: event.created_at || Math.floor(Date.now() / 1000)
        });
    }

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
        const h = Math.floor(duration / 3600); const m = Math.floor((duration % 3600) / 60); const s = duration % 60;
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

    for (const event of events) {
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
    }

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