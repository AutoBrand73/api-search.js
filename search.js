export default async function handler(req, res) {
    const SUPABASE_URL = 'https://fnlupijomjpopqtnyodv.supabase.co/rest/v1/';
    const SUPABASE_KEY = 'sb_publishable_l1pVfFfga-1Tu9Yr1ms2Lw_PrY1CoZw';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const query = (req.query.q || '').trim();
    if (!query) return res.status(400).json({ error: 'Пустой запрос' });

    const headers = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY };

    // 1. Загружаем наценки и активных поставщиков из базы
    let rules = new Array();
    let suppliers = new Array();

    try {
        const mRes = await fetch(SUPABASE_URL + 'markups?select=*&order=price_from.asc', { headers: headers });
        if (mRes.ok) rules = await mRes.json();

        const sRes = await fetch(SUPABASE_URL + 'suppliers?is_active=eq.true&select=*', { headers: headers });
        if (sRes.ok) suppliers = await sRes.json();
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'Ошибка чтения базы: ' + e.message });
    }

    if (!suppliers || suppliers.length === 0) {
        return res.status(200).json({ ok: false, error: 'Нет активных поставщиков. Добавьте ключи в Админ-панели.' });
    }

    function applyMarkup(buyPrice) {
        let pct = 15;
        for (let i = 0; i < rules.length; i++) {
            if (buyPrice >= rules[i].price_from && buyPrice <= rules[i].price_to) {
                pct = rules[i].percent;
                break;
            }
        }
        return Math.ceil(buyPrice * (1 + pct / 100));
    }

    const allOffers = new Array();
    const ns = 'http://rossko.ru';

    // 2. Опрашиваем каждого подключенного поставщика
    for (let s = 0; s < suppliers.length; s++) {
        const sup = suppliers[s];
        if (!sup.key1 || !sup.key2) continue;

        const xmlBody = '<?xml version="1.0" encoding="utf-8"?>' +
            '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
            '<soap:Body><GetSearch xmlns="' + ns + '">' +
            '<KEY1>' + sup.key1.trim() + '</KEY1><KEY2>' + sup.key2.trim() + '</KEY2>' +
            '<text>' + query.replace(/[<>&'"]/g, '') + '</text>' +
            '<delivery_id>000000001</delivery_id>' +
            '</GetSearch></soap:Body></soap:Envelope>';

        try {
            const response = await fetch('https://api.rossko.ru/service/v2.1/GetSearch', {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': ns + '/GetSearch' },
                body: xmlBody
            });
            const xmlText = await response.text();

            if (/<Success>\s*false/i.test(xmlText)) continue;

            // снимаем SOAP-префиксы (ns1:, soap: и т.п.) и работаем регистронезависимо
            const clean = xmlText.replace(/<\/?([A-Za-z0-9_]+):/g, '<$1').replace(/:\s*([A-Za-z0-9_]+)>/g, '$1>');
            const lower = clean.toLowerCase();
            const partBlocks = lower.split('<part>');

            for (let i = 1; i < partBlocks.length; i++) {
                const block = partBlocks[i];
                const brand = (block.match(/<brand>(.*?)<\/brand>/) || new Array('', ''))[1] || '';
                const partNumber = (block.match(/<partnumber>(.*?)<\/partnumber>/) || new Array('', ''))[1] || '';
                const name = (block.match(/<name>(.*?)<\/name>/) || new Array('', ''))[1] || '';

                const stockBlocks = block.split('<stock>');
                for (let j = 1; j < stockBlocks.length; j++) {
                    const sBlock = stockBlocks[j];
                    const priceRaw = parseFloat((sBlock.match(/<price>(.*?)<\/price>/) || new Array('', '0'))[1]) || 0;
                    const count = parseInt((sBlock.match(/<count>(.*?)<\/count>/) || new Array('', '0'))[1], 10) || 0;
                    const delivery = parseInt((sBlock.match(/<delivery>(.*?)<\/delivery>/) || new Array('', '1'))[1], 10) || 1;

                    if (priceRaw > 0 && count > 0) {
                        allOffers.push({
                            brand: brand,
                            art: partNumber,
                            name: name,
                            days: (delivery + (sup.extra_days || 1)) + ' дн.',
                            stock: count,
                            price: applyMarkup(priceRaw)
                        });
                    }
                }
            }
        } catch (err) {}
    }

    allOffers.sort(function (a, b) { return a.price - b.price; });
    return res.status(200).json({ ok: true, items: allOffers });
}