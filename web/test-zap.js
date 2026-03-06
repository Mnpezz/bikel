import NDK, { NDKEvent, NDKZap } from "@nostr-dev-kit/ndk";
const ndk = new NDK();
const event = new NDKEvent(ndk);
console.log("event.zap:", typeof event.zap);
