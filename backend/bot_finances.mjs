import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import NDK from '@nostr-dev-kit/ndk';
import WebSocket from 'ws';
import 'dotenv/config';

global.WebSocket = WebSocket;

// Resolve paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PAYOUTS_FILE = path.join(__dirname, 'checkpoint_payouts.json');

const COINOS_API_URL = 'https://coinos.io/api';
const RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol'];
const ndk = new NDK({ explicitRelayUrls: RELAYS });

async function getCoinosBalance() {
    // 1. Check for command line override
    const args = process.argv.slice(2);
    if (args.length > 0 && !isNaN(parseInt(args[0]))) {
        return parseInt(args[0], 10);
    }

    // 2. Try to fetch from Coinos API using .env token
    const token = process.env.COINOS_API_KEY;
    if (token) {
        try {
            const resp = await fetch(`${COINOS_API_URL}/me`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await resp.json();
            if (data && typeof data.balance === 'number') {
                return data.balance;
            }
        } catch (e) {
            console.error("⚠️  Failed to fetch balance from Coinos API:", e.message);
        }
    }
    return null;
}

async function fetchWithTimeout(filter, timeoutMs = 15000) {
    return new Promise((resolve) => {
        const events = new Set();
        const sub = ndk.subscribe(filter, { closeOnEose: true });
        let isDone = false;
        sub.on('event', e => events.add(e));
        sub.on('eose', () => { if (!isDone) { isDone = true; resolve(events); } });
        setTimeout(() => {
            if (!isDone) { isDone = true; resolve(events); }
        }, timeoutMs);
    });
}

async function runFinances() {
    console.log("=========================================");
    console.log("       BIKEL BOT FINANCE OVERVIEW        ");
    console.log("=========================================\n");

    // 1. Current Treasury Balance
    console.log("Reading input balance...");
    const treasuryBalance = await getCoinosBalance();
    
    if (treasuryBalance === null) {
        console.log("⚠️  Could not fetch live Treasury Balance from Coinos API.");
        console.log("   (You can provide it manually: node bot_finances.mjs 3031)\n");
    }
    
    // 2. Fetch completed payouts history
    let completedPayouts = 0;
    if (fs.existsSync(PAYOUTS_FILE)) {
        const raw = fs.readFileSync(PAYOUTS_FILE, 'utf8');
        const pastPayouts = JSON.parse(raw);
        for (const contestId in pastPayouts) {
            for (const pubkey in pastPayouts[contestId]) {
                const logs = pastPayouts[contestId][pubkey];
                for (const log of logs) {
                    if (typeof log === 'object' && log.amount) {
                         completedPayouts += log.amount;
                    }
                }
            }
        }
    }

    // 3. Connect to NOSTR to calculate pending liabilities
    console.log("Connecting to Nostr Relays...");
    try {
        await Promise.race([ndk.connect(), new Promise(r => setTimeout(r, 10000))]);
    } catch(e) {}

    const myPubkey = (await ndk.signer?.user())?.pubkey;
    if (myPubkey) {
        console.log(`Bot Pubkey Identified: ${myPubkey.substring(0, 8)}...`);
    }

    // Find all active Bikel events
    console.log("Fetching active Bikel events (Challenges, Sponsored POIs, Scavenger Hunts)...");
    const events = Array.from(await fetchWithTimeout({ kinds: [33301, 33401, 33402] }));
    
    // Load payout history to calculate remaining slots for POIs
    let payoutLogs = {};
    if (fs.existsSync(PAYOUTS_FILE)) {
        payoutLogs = JSON.parse(fs.readFileSync(PAYOUTS_FILE, 'utf8'));
    }

    let challengeLiabilities = 0;
    let sponsorshipLiabilities = 0;
    let huntLiabilities = 0;
    let activeEventCount = 0;

    for (const event of events) {
        const dTag = event.getMatchingTags('d')[0]?.[1];
        if (!dTag) continue;

        // Skip events not managed by this bot (if bot tag is present)
        const botTag = event.getMatchingTags('bot')[0]?.[1];
        if (botTag && myPubkey && botTag !== myPubkey) continue;

        if (event.kind === 33401) {
            // Group Challenges (Pool based) OR Scavenger Hunt Completion Bonuses
            const feeStr = event.getMatchingTags('fee')[0]?.[1] || '0';
            const setRewardStr = event.getMatchingTags('set_reward')[0]?.[1] || event.getMatchingTags('set_bonus')[0]?.[1] || '0';
            
            const fee = parseInt(feeStr, 10);
            const setReward = parseInt(setRewardStr, 10);
            const limit = parseInt(event.getMatchingTags('limit')[0]?.[1] || '0', 10);

            // 1. Entry Pool Liab
            if (fee > 0) {
                const aTag = `33401:${event.pubkey}:${dTag}`;
                const rsvps = await fetchWithTimeout({ kinds: [31925], '#a': [aTag] }, 6000);
                const acceptedCount = Array.from(rsvps).filter(r => r.getMatchingTags('l').some(t => t[1] === 'accepted')).length;
                if (acceptedCount > 0) {
                    challengeLiabilities += (fee * acceptedCount);
                    activeEventCount++;
                }
            }

            // 2. Set Completion Liab
            if (setReward > 0 && limit > 0) {
                let claimCount = 0;
                if (payoutLogs[event.id]) claimCount = Object.keys(payoutLogs[event.id]).length;
                const remaining = Math.max(0, limit - claimCount);
                huntLiabilities += (remaining * setReward);
                if (remaining > 0) activeEventCount++;
            }
        } 
        else if (event.kind === 33301 || event.kind === 33402) {
            // Sponsored POIs
            const rewardStr = event.getMatchingTags('reward')[0]?.[1] || '0';
            const limitStr = event.getMatchingTags('limit')[0]?.[1] || '0';
            
            const reward = parseInt(rewardStr, 10);
            const limit = parseInt(limitStr, 10);

            if (reward > 0 && limit > 0) {
                let claimCount = 0;
                if (payoutLogs[event.id]) claimCount = Object.keys(payoutLogs[event.id]).length;

                const remainingSlots = Math.max(0, limit - claimCount);
                const liab = remainingSlots * reward;

                sponsorshipLiabilities += liab;
                if (liab > 0) activeEventCount++;
            }
        }
    }

    const totalLiabilities = challengeLiabilities + sponsorshipLiabilities + huntLiabilities;

    console.log("\n--------- FINANCIAL SUMMARY ---------");
    console.log(`🏦 Current Treasury Balance:  ${treasuryBalance !== null ? treasuryBalance.toLocaleString() : '????'} sats`);
    console.log(`💸 Total Past Payouts Sent:   ${completedPayouts.toLocaleString()} sats`);
    console.log(`📉 Total Pending Liabilities: ${totalLiabilities.toLocaleString()} sats (from ${activeEventCount} active items)`);
    console.log(`   ├─ Sponsored POIs:         ${sponsorshipLiabilities.toLocaleString()} sats`);
    console.log(`   ├─ Hunt Completion:        ${huntLiabilities.toLocaleString()} sats`);
    console.log(`   └─ Challenge Entry Pools:  ${challengeLiabilities.toLocaleString()} sats`);
    
    console.log("-------------------------------------");
    const netProfit = (treasuryBalance !== null) ? (treasuryBalance - totalLiabilities) : null;
    console.log(`💰 Potential Net Profit:      ${netProfit !== null ? netProfit.toLocaleString() : '????'} sats\n`);

    console.log("(* Net profit assumes all outstanding sponsorship limits are hit.)\n");
    process.exit(0);
}

runFinances();
