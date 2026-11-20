// Vercel Serverless Function: api/search.js
export default async function handler(req, res) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!auth) {
    res.status(401).json({ error: 'Требуется вход в аккаунт' });
    return;
  }
  let userId = null;
  try {
    const authRes = await fetch(
      process.env.SUPABASE_URL + '/auth/v1/user',
      { headers: { Authorization: 'Bearer ' + auth, apikey: process.env.SUPABASE_ANON_KEY } }
    );
    if (authRes.status !== 200) {
      res.status(401).json({ error: 'Сессия истекла, войдите заново' });
      return;
    }
    const authData = await authRes.json();
    userId = authData && authData.id ? authData.id : null;
  } catch (e) {
    res.status(401).json({ error: 'Не удалось проверить авторизацию' });
    return;
  }

  const q = (req.query.q || '').trim();
  if (!q) { res.status(400).json({ error: 'Пустой запрос' }); return; }
  const testSupplierId = (req.query.supplier || '').trim();

  const SUP_KEY = process.env.SUPABASE_ANON_KEY;
  const SB = process.env.SUPABASE_URL.replace(/\/$/, '');

  let markups = [];
  try {
    const mkRes = await fetch(SB + '/rest/v1/markups?select=*', { headers: { apikey: SUP_KEY } });
    if (mkRes.ok) markups = await mkRes.json();
  } catch (e) {}
  const getMarkup = (price) => {
    let pct = 20;
    for (const m of markups) {
      const r = (m.range || '').split('-');
      if (r.length === 2) {
        const lo = parseFloat(r[0]), hi = parseFloat(r[1]);
        if (!isNaN(lo) && !isNaN(hi) && price >= lo && price <= hi) { pct = Number(m.percent) || 0; break; }
      }
    }
    return pct;
  };

  let suppliers = [];
  try {
    const url = SB + '/rest/v1/suppliers?select=*' + (testSupplierId ? '&id=eq.' + encodeURIComponent(testSupplierId) : '');
    const supRes = await fetch(url, { headers: { apikey: SUP_KEY } });
    if (supRes.ok) suppliers = await supRes.json();
  } catch (e) {}
  suppliers = suppliers.filter(s => s.active);
  if (!suppliers.length) { res.status(200).json([]); return; }

  const soapEnvelope = (keys, query) =>
    `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SearchArticle xmlns="http://api.rossko.ru/service/v2.2/GetSearch">
      <KEY1>${keys.key1 || ''}</KEY1>
      <KEY2>${keys.key2 || ''}</KEY2>
      <TEXT>${query}</TEXT>
    </SearchArticle>
  </soap:Body>
</soap:Envelope>`;

  const parseRossko = (xml) => {
    const parts = [];
    const norm = xml.replace(/\r?\n/g, ' ');
    const partMatches = norm.match(/<\w*:?Part[\s\S]*?<\/\w*:?Part>/g) || [];
    for (const pm of partMatches) {
      const getTag = (tag) => {
        const m = pm.match(new RegExp('<\\w*:?' + tag + '>([\\s\\S]*?)<\\/\\w*:?' + tag + '>'));
        return m ? m[1].trim() : '';
      };
      const partsList = pm.match(/<\w*:?Parts[\s\S]*?<\/\w*:?Parts>/g) || [];
      for (const pl of partsList) {
        const stockMatches = pl.match(/<\w*:?Stock[\s\S]*?<\/\w*:?Stock>/g) || [];
        for (const st of stockMatches) {
          const stockGet = (tag) => {
            const m = st.match(new RegExp('<\\w*:?' + tag + '>([\\s\\S]*?)<\\/\\w*:?' + tag + '>'));
            return m ? m[1].trim() : '';
          };
          parts.push({
            brand: getTag('brand'),
            code: getTag('partnumber') || getTag('code'),
            name: getTag('description') || getTag('name'),
            delivery: Number(stockGet('days')) || 0,
            stock: stockGet('quantity'),
            cost: parseFloat(stockGet('price')) || 0
          });
        }
      }
    }
    return parts;
  };

  const results = [];
  const dedup = new Set();

  for (const sup of suppliers) {
    try {
      const resp = await fetch('https://api.rossko.ru/service/v2.2/GetSearch', {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8' },
        body: soapEnvelope({ key1: sup.key1, key2: sup.key2 }, q)
      });
      const xml = await resp.text();
      if (/<\w*:?Success>\s*false/i.test(xml)) continue;
      const parts = parseRossko(xml);
      for (const p of parts) {
        const key = (p.brand + '|' + p.code + '|' + p.delivery).toLowerCase();
        if (dedup.has(key)) continue;
        dedup.add(key);
        const cost = p.cost || 0;
        const price = Math.round(cost * (1 + getMarkup(cost) / 100) * 100) / 100;
        const days = p.delivery + (Number(sup.extra_days) || 0);
        results.push({
          brand: p.brand, code: p.code, name: p.name,
          delivery: days, stock: p.stock, cost: cost, price: price
        });
      }
    } catch (e) { /* продолжаем остальных */ }
  }

  results.sort((a, b) => a.price - b.price);
  res.status(200).json(results);
}
