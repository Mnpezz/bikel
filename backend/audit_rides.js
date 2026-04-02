
import NDK from '@nostr-dev-kit/ndk';
import WebSocket from 'ws';
global.WebSocket = WebSocket;

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function auditRides() {
  const RELAYS = ['wss://relay.bikel.ink', 'wss://relay.damus.io'];
  const ndk = new NDK({ explicitRelayUrls: RELAYS });
  await ndk.connect();

  const checkpoints = [
    { id: 'first_cp', title: 'First checkpoint', lat: 29.96522537064377, lng: -90.06265806786034 },
    { id: 'yoo', title: 'Yoo', lat: 29.966761925468422, lng: -90.05017894550794 }
  ];

  const now = Math.floor(Date.now() / 1000);
  console.log(`Auditing Bikel rides from the last 24 hours...`);
  
  const rides = await ndk.fetchEvents({
    kinds: [1301],
    since: now - 86400,
    limit: 10
  });

  console.log(`Found ${rides.size} ride(s).`);

  for (const ride of rides) {
    const title = ride.getMatchingTags('title')[0]?.[1] || '(no title)';
    const routeTag = ride.getMatchingTags('route')[0]?.[1];
    if (!routeTag) continue;

    const parsed = JSON.parse(routeTag);
    const coords = parsed.route || [];

    console.log(`Ride: "${title}" (${ride.id.substring(0, 8)}) - ${coords.length} points`);

    for (const cp of checkpoints) {
      let minD = Infinity;
      let closestPt = null;
      for (const pt of coords) {
        const d = calculateDistance(cp.lat, cp.lng, pt[0], pt[1]);
        if (d < minD) {
            minD = d;
            closestPt = pt;
        }
      }
      console.log(`  -> Distance to "${cp.title}": ${minD.toFixed(2)}m (at ${closestPt ? closestPt.join(',') : 'N/A'})`);
      if (minD <= 50) console.log(`     ✅ HIT LOGICAL PROXIMITY!`);
      else console.log(`     ❌ MISSED (Threshold 50m)`);
    }
    console.log('---');
  }
  process.exit(0);
}

auditRides().catch(e => { console.error(e); process.exit(1); });
