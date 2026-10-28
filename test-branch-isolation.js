import "dotenv/config";
import { createClient } from "@libsql/client";
import { createDb } from "./server/sqlite.js";
import { hashPassword, verifyPassword } from "./server/auth.js";
import { randomBytes } from "node:crypto";

const client = createClient({ 
  url: process.env.TURSO_DATABASE_URL, 
  authToken: process.env.TURSO_AUTH_TOKEN 
});
const db = createDb(client);

const superadminToken = "ea6885b43f821d8323719c2e0534b2bfa7b91e1fe3e63ce0c24fd79457972e85";
const tandilToken = "test-tandil-token-1793119480473";
const necoToken = "test-neco-token-1793119480473";

async function req(path, options = {}, token = superadminToken, csrf = null, csrfCookie = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...options.headers
  };
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (csrfCookie) headers['Cookie'] = csrfCookie;
  const resp = await fetch(`http://localhost:3001${path}`, { ...options, headers });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

function mutate(path, body, token, csrf, csrfCookie) {
  return req(path, { method: 'POST', body: JSON.stringify(body) }, token, csrf, csrfCookie);
}

function mutatePut(path, body, token, csrf, csrfCookie) {
  return req(path, { method: 'PUT', body: JSON.stringify(body) }, token, csrf, csrfCookie);
}

function mutatePatch(path, body, token, csrf, csrfCookie) {
  return req(path, { method: 'PATCH', body: JSON.stringify(body) }, token, csrf, csrfCookie);
}

function mutateDelete(path, body, token, csrf, csrfCookie) {
  return req(path, { method: 'DELETE', body: JSON.stringify(body) }, token, csrf, csrfCookie);
}

async function loginAndGetCsrf(username, password) {
  const resp = await fetch('http://localhost:3001/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const cookies = resp.headers.getSetCookie?.() || [resp.headers.get('set-cookie')];
  const csrfCookie = cookies.find(c => c?.includes('fw_admin_csrf'));
  const csrfToken = csrfCookie?.match(/fw_admin_csrf=([^;]+)/)?.[1];
  return { csrfToken, csrfCookie };
}

async function runTests() {
  const superadminCsrf = await loginAndGetCsrf('admin', 'FmL&hzte^4Ks-o+Mx5KJ');
  const tandilCsrf = await loginAndGetCsrf('test_tandil', 'test123456');
  const necoCsrf = await loginAndGetCsrf('test_necochea', 'test123456');

  console.log('=== TESTING BRANCH ISOLATION ===\n');

  // Get a product from Tandil for testing
  const menu = await req('/api/menu/tandil', {}, tandilToken);
  const prod = menu.data?.categories?.[0]?.groups?.[0]?.products?.[0];
  const catId = menu.data?.categories?.[0]?.id;
  console.log('Test product:', prod?.name, 'ID:', prod?.id, 'Category:', catId);

  // ========== 1. PRODUCTOS ==========
  console.log('\n--- 1. PRODUCTOS ---');
  
  // Tandil admin creates in Tandil (should work)
  const p1 = await mutate('/api/admin/products', { 
    branch: 'tandil', 
    name: 'Test Product Tandil', 
    price: 1000, 
    categoryId: catId, 
    categoryName: catId 
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> create in Tandil:', p1.status, p1.data?.error || 'OK');

  // Tandil admin creates in Necochea (should FAIL with 400/403)
  const p2 = await mutate('/api/admin/products', { 
    branch: 'necochea', 
    name: 'Test Product Neco', 
    price: 1000, 
    categoryId: catId, 
    categoryName: catId 
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> create in Necochea:', p2.status, p2.data?.error || 'OK (BUG!)');

  // Tandil admin edits own product (should work)
  if (p1.data?.product?.id) {
    const p3 = await req(`/api/admin/products/${p1.data.product.id}`, { 
      method: 'PUT', 
      body: JSON.stringify({ name: 'Updated Product' }) 
    }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
    console.log('Tandil -> edit own product:', p3.status, p3.data?.error || 'OK');
  }

  // Tandil admin tries to edit Necochea product (should 404)
  // First create a product in Necochea as superadmin
  const necoProd = await mutate('/api/admin/products', { 
    branch: 'necochea', 
    name: 'Neco Product', 
    price: 1000, 
    categoryId: catId, 
    categoryName: catId 
  }, superadminToken, superadminCsrf.csrfToken, superadminCsrf.csrfCookie);
  
  if (necoProd.data?.product?.id) {
    const p4 = await req(`/api/admin/products/${necoProd.data.product.id}`, { 
      method: 'PUT', 
      body: JSON.stringify({ name: 'Hacked' }) 
    }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
    console.log('Tandil -> edit Neco product:', p4.status, p4.data?.error || 'OK (BUG!)');
  }

  // ========== 2. CATEGORÍAS ==========
  console.log('\n--- 2. CATEGORÍAS ---');
  
  const c1 = await mutate('/api/admin/categories', { 
    branch: 'tandil', 
    name: 'Test Cat Tandil' 
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> create cat in Tandil:', c1.status, c1.data?.error || 'OK');

  const c2 = await mutate('/api/admin/categories', { 
    branch: 'necochea', 
    name: 'Test Cat Neco' 
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> create cat in Necochea:', c2.status, c2.data?.error || 'OK (BUG!)');

  // ========== 3. CUPONES ==========
  console.log('\n--- 3. CUPONES ---');
  
  const cp1 = await mutate('/api/admin/coupons', { 
    code: 'TESTTANDIL', type: 'fixed', value: 1000, minTotal: 0, maxUses: 0, active: true 
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> create coupon:', cp1.status, cp1.data?.error || 'OK');

  const cp2 = await mutate('/api/admin/coupons', { 
    branch: 'necochea',
    code: 'TESTNECO', type: 'fixed', value: 1000, minTotal: 0, maxUses: 0, active: true 
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> create coupon with branch=necochea:', cp2.status, cp2.data?.error || 'OK (check branch)');

  // ========== 4. GASTOS (EXPENSES) ==========
  console.log('\n--- 4. GASTOS ---');
  
  const e1 = await mutate('/api/admin/expenses', { 
    branch: 'tandil', 
    amount: 1000, 
    concept: 'Test Tandil', 
    payment_method: 'cash' 
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> expense in Tandil:', e1.status, e1.data?.branch || e1.data?.error);

  const e2 = await mutate('/api/admin/expenses', { 
    branch: 'necochea', 
    amount: 1000, 
    concept: 'Test Neco', 
    payment_method: 'cash' 
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> expense in Necochea:', e2.status, e2.data?.branch || e2.data?.error, '(BUG: should reject or use session branch)');

  // Tandil admin tries to read Necochea expenses
  const e3 = await req('/api/admin/expenses', {}, necoToken);
  console.log('Necochea -> read own expenses:', e3.status, e3.data?.expenses?.length || 0);

  const e4 = await req('/api/admin/expenses', {}, tandilToken);
  console.log('Tandil -> read own expenses:', e4.status, e4.data?.expenses?.length || 0);

  // ========== 5. BRANCH PAUSE ==========
  console.log('\n--- 5. BRANCH PAUSE ---');
  
  const bp1 = await mutatePut('/api/admin/branch-pause', { 
    branch: 'tandil', action: 'pause', minutes: 10 
  }, superadminToken, superadminCsrf.csrfToken, superadminCsrf.csrfCookie);
  console.log('Superadmin pause Tandil:', bp1.status, bp1.data?.error || 'OK');

  const bp2 = await mutatePut('/api/admin/branch-pause', { 
    branch: 'necochea', action: 'pause', minutes: 10 
  }, superadminToken, superadminCsrf.csrfToken, superadminCsrf.csrfCookie);
  console.log('Superadmin pause Necochea:', bp2.status, bp2.data?.error || 'OK');

  // Resume
  await mutatePut('/api/admin/branch-pause', { branch: 'tandil', action: 'resume' }, superadminToken, superadminCsrf.csrfToken, superadminCsrf.csrfCookie);
  await mutatePut('/api/admin/branch-pause', { branch: 'necochea', action: 'resume' }, superadminToken, superadminCsrf.csrfToken, superadminCsrf.csrfCookie);

  // ========== 6. HORARIOS ==========
  console.log('\n--- 6. HORARIOS ---');
  
  const hours = {
    0: { closed: true, slots: [] },
    1: { closed: false, slots: [{ open: '12:00', close: '15:00' }, { open: '19:30', close: '23:00' }] },
    2: { closed: false, slots: [{ open: '12:00', close: '15:00' }, { open: '19:30', close: '23:00' }] },
    3: { closed: false, slots: [{ open: '12:00', close: '15:00' }, { open: '19:30', close: '23:00' }] },
    4: { closed: false, slots: [{ open: '12:00', close: '15:00' }, { open: '19:30', close: '23:00' }] },
    5: { closed: false, slots: [{ open: '12:00', close: '15:00' }, { open: '19:30', close: '01:00' }] },
    6: { closed: false, slots: [{ open: '12:00', close: '15:00' }, { open: '19:30', close: '01:00' }] },
  };
  
  const h1 = await mutatePut('/api/admin/branch-hours', { 
    branch: 'tandil', hours 
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> update own hours:', h1.status, h1.data?.error || 'OK');

  const h2 = await mutatePut('/api/admin/branch-hours', { 
    branch: 'necochea', hours 
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> update Neco hours:', h2.status, h2.data?.error || 'OK (BUG!)');

  // ========== 7. GRUPOS ==========
  console.log('\n--- 7. GRUPOS ---');
  
  const g1 = await mutatePut('/api/admin/groups', { 
    branch: 'tandil', categoryId: catId, oldName: 'Test', newName: 'Renamed' 
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> rename own group:', g1.status, g1.data?.error || 'OK');

  const g2 = await mutatePut('/api/admin/groups', { 
    branch: 'necochea', categoryId: 'promos', oldName: 'Test', newName: 'Renamed' 
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> rename Neco group:', g2.status, g2.data?.error || 'OK (BUG!)');

  // ========== 8. IMÁGENES ==========
  console.log('\n--- 8. IMÁGENES ---');
  
  const validPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const img1 = await mutate('/api/admin/upload', { dataUrl: validPng }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> upload image:', img1.status, img1.data?.url || img1.data?.error);

  // ========== 9. PEDIDOS MANUALES ==========
  console.log('\n--- 9. PEDIDOS MANUALES ---');
  
  const pm1 = await mutate('/api/admin/orders/manual', { 
    source: 'whatsapp',
    branch: 'tandil',
    customer: { name: 'Test', phone: '1122334455', email: 'test@test.com', firstName: 'Test', lastName: 'User' },
    orderMode: 'pickup',
    paymentMethod: 'efectivo',
    items: [{ productId: prod.id, name: prod.name, unitPrice: prod.price, qty: 1, extras: [] }],
    notes: ''
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> manual order in Tandil:', pm1.status, pm1.data?.orderNumber || pm1.data?.error);

  const pm2 = await mutate('/api/admin/orders/manual', { 
    source: 'whatsapp',
    branch: 'necochea',
    customer: { name: 'Test', phone: '1122334455', email: 'test@test.com', firstName: 'Test', lastName: 'User' },
    orderMode: 'pickup',
    paymentMethod: 'efectivo',
    items: [{ productId: prod.id, name: prod.name, unitPrice: prod.price, qty: 1, extras: [] }],
    notes: ''
  }, tandilToken, tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Tandil -> manual order in Necochea:', pm2.status, pm2.data?.orderNumber || pm2.data?.error, '(BUG!)');

  console.log('\n=== TESTS COMPLETE ===');
}

runTests().catch(console.error);