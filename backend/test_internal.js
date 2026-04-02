import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:7777');
ws.on('open', () => { console.log('✅ Local Relay Connected!'); process.exit(0); });
ws.on('error', (e) => { console.error('❌ Local Relay Failed:', e.message); process.exit(1); });
setTimeout(() => { console.log('🕒 Timeout waiting for local relay...'); process.exit(1); }, 5000);
