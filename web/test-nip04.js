import { nip04, getPublicKey, generateSecretKey } from 'nostr-tools';

const priv1 = generateSecretKey();
const pub1 = getPublicKey(priv1);

const priv2 = generateSecretKey();
const pub2 = getPublicKey(priv2);

async function test() {
    // User 1 sends message to User 2
    const ciphertext = await nip04.encrypt(priv1, pub2, "Hello Bob!");
    
    // User 1 (sender) reads their own sent message
    try {
        const d1 = await nip04.decrypt(priv1, pub2, ciphertext);
        console.log("User 1 decoding own message with User 2 pubkey:", d1);
    } catch (e) {
        console.error("User 1 failed with User 2 pubkey", e);
    }
    
    // User 1 reads own sent message using their OWN pubkey?
    try {
        const d_own = await nip04.decrypt(priv1, pub1, ciphertext);
        console.log("User 1 decoding own message with OWN pubkey:", d_own);
    } catch (e) {
        console.log("User 1 failed with OWN pubkey, obviously");
    }

    // User 2 (recipient) reads message
    try {
        const d2 = await nip04.decrypt(priv2, pub1, ciphertext);
        console.log("User 2 decoding incoming message with User 1 pubkey:", d2);
    } catch (e) {
        console.error("User 2 failed", e);
    }
}
test();
