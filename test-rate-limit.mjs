import http from 'http';

function post(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 3001,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.write(data);
    req.end();
  });
}

async function test(phone, orderNumber, label) {
  console.log(`\n--- ${label} (${orderNumber}) ---`);
  for (let i = 1; i <= 14; i++) {
    const r = await post(`/api/orders/number/${orderNumber}/details`, { phone });
    console.log(`  Intento ${i}: ${r.status} ${r.body.substring(0, 60)}`);
    if (r.status === 429) break;
  }
}

// Start server first if needed
await test('2262555555', 'FW-999999', 'INEXISTENTE');
await test('2262555556', 'FW-000001', 'EXISTENTE');