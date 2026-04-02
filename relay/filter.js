#!/usr/bin/env node
const readline = require('readline');

// strfry sends a JSON object on each line via stdin
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const req = JSON.parse(line);
    if (req.type === 'new') {
      const ev = req.event;
      let accept = false;
      let msg = "blocked: This relay exclusively accepts Bikel and Runstr Open Cycling Data.";

      // 0 = Metadata (Profile)
      // 5 = Deletion
      // 10002 = Relay List (NIP-65)
      // 33301 = Legacy Bikel (For historic backfill)
      // 1301 = NIP Fitness Activity (The new standard)
      // 31923 = Bikel Group Rides
      // 33401 = Bikel Challenges / Contests
      // 33400 = Bikel Bot Announcement
      const bikelKinds = [0, 5, 10002, 33301, 1301, 31923, 33401, 33400];
      if (bikelKinds.includes(ev.kind)) {
        accept = true;
      }
      // 1 = Public text notes (Accept ONLY if tagged with relevant fitness clients)
      else if (ev.kind === 1) {
        const tTags = (ev.tags || []).filter(t => t[0] === 't').map(t => (t[1] || '').toLowerCase());
        const clientTags = (ev.tags || []).filter(t => t[0] === 'client').map(t => (t[1] || '').toLowerCase());
        
        if (
          tTags.includes('runstr') || tTags.includes('bikel') || tTags.includes('cycling') || tTags.includes('fitness') ||
          clientTags.includes('bikel') || clientTags.includes('runstr')
        ) {
          accept = true;
        }
      }

      console.log(JSON.stringify({
        id: ev.id,
        action: accept ? "accept" : "reject",
        msg: accept ? "" : msg
      }));
    }
  } catch(e) {
    // Fail closed on parsing errors
  }
});
