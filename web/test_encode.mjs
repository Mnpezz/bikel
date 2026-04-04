import NDK, { NDKEvent } from '@nostr-dev-kit/ndk';

const ndk = new NDK();
const ev = new NDKEvent(ndk, { 
  id: 'a08f51a7e...dummy', 
  pubkey: 'cc130b...',
  kind: 1
});
console.log(ev.encode());
