import axios from 'axios';
import { NDKCashuWallet, NDKNutzapMonitor } from '@nostr-dev-kit/ndk-wallet';
import { NDKEvent, NDKUser } from '@nostr-dev-kit/ndk';

/**
 * Universal Wallet Provider Interface for Bikel Bot.
 * Supports Coinos, LNbits, and (eventually) NWC.
 */
export class WalletProvider {
    constructor() {
        this.canSendNutzap = false;
    }
    /**
     * Pay a Bolt11 Lightning Invoice.
     * @param {string} bolt11 
     * @returns {Promise<boolean>}
     */
    async pay(bolt11) {
        throw new Error('pay() not implemented');
    }

    /**
     * Send a Nutzap (NIP-61 eCash) to a pubkey.
     * @param {string} pubkey 
     * @param {number} amountSats 
     * @param {string} eventId - Optional event to zap
     * @returns {Promise<boolean>}
     */
    async sendNutzap(pubkey, amountSats, eventId) {
        throw new Error('sendNutzap() not implemented');
    }

    /**
     * Get the current wallet balance in sats.
     * @returns {Promise<number|null>}
     */
    async getBalance() {
        throw new Error('getBalance() not implemented');
    }

    /**
     * Get recent payments (incoming/outgoing) in a time window.
     * @param {number} startTs - Start timestamp (ms)
     * @param {number} endTs - End timestamp (ms)
     * @returns {Promise<Array|null>} - Normalized payment history. Null if API unavailable.
     */
    async getPayments(startTs, endTs) {
        throw new Error('getPayments() not implemented');
    }
}

/**
 * Coinos Wallet Provider (Custodial)
 */
export class CoinosProvider extends WalletProvider {
    constructor(apiKey, apiUrl = 'https://coinos.io/api') {
        super();
        this.apiKey = apiKey;
        this.apiUrl = apiUrl;
    }

    async pay(bolt11) {
        try {
            console.log(`[Coinos] Paying bolt11: ${bolt11.substring(0, 24)}...`);
            const response = await axios.post(`${this.apiUrl}/payments`, { payreq: bolt11 }, {
                headers: { 'Authorization': `Bearer ${this.apiKey}`, 'content-type': 'application/json' }
            });
            return !!response.data;
        } catch (e) {
            console.error('[Coinos] Payout failed:', e.response?.data || e.message);
            return false;
        }
    }

    async getBalance() {
        try {
            const response = await axios.get(`${this.apiUrl}/me`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });
            return response.data?.balance || 0;
        } catch (e) {
            console.warn('[Coinos] Could not fetch balance:', e.message);
            return null;
        }
    }

    async getPayments(startTs, endTs) {
        try {
            const response = await axios.get(`${this.apiUrl}/payments`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
                params: { start: startTs, end: endTs, limit: 100 }
            });
            const payments = Array.isArray(response.data) ? response.data : (response.data?.payments || []);
            return payments.map(p => ({
                id: p.id,
                amount: typeof p.amount === 'number' ? p.amount : parseInt(p.amount, 10), // sats
                time: Math.floor(new Date(p.created_at).getTime() / 1000), // unix secs
                memo: p.memo
            }));
        } catch (e) {
            console.warn('[Coinos] Could not fetch payments:', e.message);
            return null;
        }
    }
}

/**
 * LNbits Wallet Provider (Self-Hosted or Custodial)
 */
export class LNbitsProvider extends WalletProvider {
    constructor(apiKey, apiUrl) {
        super();
        this.apiKey = apiKey;
        this.apiUrl = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
    }

    async pay(bolt11) {
        try {
            console.log(`[LNbits] Paying bolt11: ${bolt11.substring(0, 24)}...`);
            const response = await axios.post(`${this.apiUrl}/api/v1/payments`, { bolt11, out: true }, {
                headers: { 'X-Api-Key': this.apiKey, 'content-type': 'application/json' }
            });
            return !!response.data.checking_id;
        } catch (e) {
            console.error('[LNbits] Payout failed:', e.response?.data || e.message);
            return false;
        }
    }

    async getBalance() {
        try {
            const response = await axios.get(`${this.apiUrl}/api/v1/wallet`, {
                headers: { 'X-Api-Key': this.apiKey }
            });
            return Math.floor(response.data?.balance / 1000) || 0; // msats to sats
        } catch (e) {
            console.warn('[LNbits] Could not fetch balance:', e.message);
            return null;
        }
    }

    async getPayments(startTs, endTs) {
        try {
            const response = await axios.get(`${this.apiUrl}/api/v1/payments`, {
                headers: { 'X-Api-Key': this.apiKey, 'content-type': 'application/json' }
            });
            const payments = Array.isArray(response.data) ? response.data : [];
            
            // LNbits returns time in unix seconds. amount is in msats.
            return payments
                .filter(p => (p.time * 1000) >= startTs && (p.time * 1000) <= endTs)
                .map(p => ({
                    id: p.checking_id,
                    amount: Math.floor(p.amount / 1000), // msats -> sats
                    time: p.time,
                    memo: p.memo
                }));
        } catch (e) {
            console.warn('[LNbits] Could not fetch payments:', e.message);
            return null;
        }
    }
}

/**
 * Cashu/Nutzap Wallet Provider (Nostr-Native eCash)
 */
export class CashuProvider extends WalletProvider {
    constructor(ndk, mintUrls) {
        super();
        this.canSendNutzap = true;
        this.ndk = ndk;
        this.mintUrls = Array.isArray(mintUrls) ? mintUrls : (mintUrls ? [mintUrls] : []);
        this.wallet = new NDKCashuWallet(ndk);
        for (const url of this.mintUrls) {
            console.log(`[Cashu] Adding mint: ${url}`);
            this.wallet.addMint(url);
        }
    }

    async pay(bolt11) {
        // CashuWallet can pay a bolt11 if it has enough tokens
        try {
            console.log(`[Cashu] Melting tokens to pay bolt11...`);
            await this.wallet.payInvoice(bolt11);
            return true;
        } catch (e) {
            console.error('[Cashu] Payout failed:', e.message);
            return false;
        }
    }

    async getBalance() {
        try {
            return await this.wallet.balance();
        } catch (e) {
            console.warn('[Cashu] Could not fetch balance:', e.message);
            return null;
        }
    }

    async sendNutzap(pubkey, amountSats, eventId) {
        try {
            console.log(`[Cashu] Sending ${amountSats} sat Nutzap to ${pubkey.substring(0, 8)}...`);
            const user = new NDKUser({ pubkey });
            await this.wallet.lnzap(user, amountSats * 1000, eventId);
            return true;
        } catch (e) {
            console.error('[Cashu] Nutzap failed:', e.message);
            return false;
        }
    }

    async getPayments(startTs, endTs) {
        // Placeholder: history from kind 7375/7376
        return [];
    }
}

/**
 * Factory for creating the configured Wallet Provider.
 */
export function createWalletProvider(config, ndk) {
    const { provider, apiKey, apiUrl, mintUrl } = config;
    
    if (provider === 'cashu') {
        const mints = typeof mintUrl === 'string' ? mintUrl.split(',').map(m => m.trim()).filter(Boolean) : mintUrl;
        return new CashuProvider(ndk, mints);
    }
    if (provider === 'lnbits') {
        if (!apiKey || !apiUrl) throw new Error('LNbits requires LNBITS_API_KEY and LNBITS_URL');
        return new LNbitsProvider(apiKey, apiUrl);
    }
    // Default to Coinos
    return new CoinosProvider(apiKey, apiUrl || 'https://coinos.io/api');
}
