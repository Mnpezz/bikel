import { NativeModules } from 'react-native';
import { NDKSigner, NDKUser, NDKEvent } from '@nostr-dev-kit/ndk';
import { nip19 } from 'nostr-tools';

const { AmberSignerModule } = NativeModules;

function hexify(pubkey: string): string {
    if (pubkey.startsWith('npub1')) {
        try {
            const { data } = nip19.decode(pubkey);
            return data as string;
        } catch (e) {
            console.error('[AmberSigner] Failed to decode npub:', e);
        }
    }
    return pubkey;
}

/**
 * NDKSigner implementation that uses the Amber Android app via NIP-55 Intents.
 */
export class AmberSigner implements NDKSigner {
    private _user: NDKUser | undefined;
    public userSync: NDKUser;

    constructor(pubkey?: string) {
        const hex = pubkey ? hexify(pubkey) : '';
        this.userSync = new NDKUser({ pubkey: hex });
        if (hex) {
            this._user = this.userSync;
        }
    }

    public get pubkey(): string {
        return this._user?.pubkey || '';
    }

    async blockUntilReady(): Promise<NDKUser> {
        return this.user();
    }

    /**
     * Returns the user associated with this signer.
     * If not already known, it prompts Amber for the public key.
     */
    async user(): Promise<NDKUser> {
        if (this._user && this._user.pubkey !== '') return this._user;

        try {
            const rawPubkey = await AmberSignerModule.getPublicKey();
            const pubkey = hexify(rawPubkey);
            console.log('[AmberSigner] Received hex pubkey:', pubkey);
            this._user = new NDKUser({ pubkey });
            this.userSync = this._user;
            return this._user;
        } catch (e) {
            console.error('[AmberSigner] Failed to get public key:', e);
            throw e;
        }
    }

    /**
     * Signs an event using Amber.
     * Amber will prompt the user to approve the signature.
     */
    async sign(event: any): Promise<string> {
        try {
            // NDK might pass an NDKEvent or a raw NostrEvent
            const rawEvent = typeof event.rawEvent === 'function' ? event.rawEvent() : event;
            const eventJson = JSON.stringify(rawEvent);
            const eventId = rawEvent.id || '';
            
            console.log('[AmberSigner] Requesting signature for event...');
            const result = await AmberSignerModule.signEvent(eventJson, this.pubkey, eventId);
            
            if (result.startsWith('{')) {
                const parsed = JSON.parse(result);
                return parsed.sig || parsed.signature || result;
            }
            return result;
        } catch (e) {
            console.error('[AmberSigner] Failed to sign event:', e);
            throw e;
        }
    }

    toPayload(): string {
        return JSON.stringify({
            type: 'amber',
            pubkey: this._user?.pubkey
        });
    }

    /**
     * NIP-04 Encryption
     */
    async encrypt(recipient: NDKUser, value: string): Promise<string> {
        try {
            return await AmberSignerModule.nip04Encrypt(value, recipient.pubkey, this.pubkey);
        } catch (e) {
            console.error('[AmberSigner] Encryption failed:', e);
            throw e;
        }
    }

    /**
     * NIP-04 Decryption
     */
    async decrypt(sender: NDKUser, value: string): Promise<string> {
        try {
            return await AmberSignerModule.nip04Decrypt(value, sender.pubkey, this.pubkey);
        } catch (e) {
            console.error('[AmberSigner] Decryption failed:', e);
            throw e;
        }
    }
}
