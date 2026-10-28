async function quickTest() {
  async function mutate(path, body, token, csrf, csrfCookie) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-CSRF-Token': csrf,
      'Cookie': csrfCookie
    };
    const resp = await fetch(`http://localhost:3001${path}`, { 
      method: 'POST', 
      headers, 
      body: JSON.stringify(body) 
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: resp.status, data };
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
  
  const tandilCsrf = await loginAndGetCsrf('test_tandil', 'test123456');
  const menu = await fetch('http://localhost:3001/api/menu/tandil').then(r => r.json());
  const prod = menu.categories?.[0]?.groups?.[0]?.products?.[0];
  const catId = menu.categories?.[0]?.id;
  
  const r1 = await mutate('/api/admin/products', { 
    branch: 'necochea', 
    name: 'Test Product', 
    price: 1000, 
    categoryId: catId, 
    categoryName: catId 
  }, 'test-tandil-token-1793119480473', tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Product:', r1.status, r1.data?.error || 'OK - branch:', r1.data?.product?.branch);
  
  const r2 = await mutate('/api/admin/categories', { 
    branch: 'necochea', 
    name: 'Test Cat' 
  }, 'test-tandil-token-1793119480473', tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Category:', r2.status, r2.data?.error || 'OK - branch:', r2.data?.category?.branch);
  
  const r3 = await mutate('/api/admin/expenses', { 
    branch: 'necochea', 
    amount: 1000, 
    concept: 'Test', 
    payment_method: 'cash' 
  }, 'test-tandil-token-1793119480473', tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Expense:', r3.status, r3.data?.error || 'OK - branch:', r3.data?.expense?.branch);
  
  const r4 = await mutate('/api/admin/orders/manual', { 
    source: 'whatsapp',
    branch: 'necochea',
    customer: { name: 'Test', phone: '1122334455', email: 'test@test.com', firstName: 'Test', lastName: 'User' },
    orderMode: 'pickup',
    paymentMethod: 'efectivo',
    items: [{ productId: prod.id, name: prod.name, unitPrice: prod.price, qty: 1, extras: [] }],
    notes: ''
  }, 'test-tandil-token-1793119480473', tandilCsrf.csrfToken, tandilCsrf.csrfCookie);
  console.log('Manual order:', r4.status, r4.data?.error || 'OK');
}
quickTest().catch(console.error);