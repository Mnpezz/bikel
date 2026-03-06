import NDK from '@nostr-dev-kit/ndk';

const ndk = new NDK();
const user = ndk.getUser({ npub: 'npub1esfskufq6qx76aksvklsh5n78gm28r2jdqsgq79paxd29xkyft0s2z72gg' });
console.log("npub user pubkey:", user.pubkey);
console.log("npub user npub:", user.npub);

const user2 = ndk.getUser({ pubkey: '9367a951f3e58803ab88d3053a1b7b1be4539addcec555b61cfa19c5f2397e83' });
console.log("hex user pubkey:", user2.pubkey);
