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
        const mRes = await fetch(SUPABASE_URL + '/rest/v1/markups?select=*&order=price_from.asc', { headers: headers });
        if (mRes.ok) rules = await mRes.json();

        const sRes = await fetch(SUPABASE_URL + '/rest/v1/suppliers?is_active=eq.true&select=*', { headers: headers });
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
            '<soap:Envelope xmlns:xsi="http://w3.org" xmlns:xsd="http://w3.org" xmlns:soap="http://xmlsoap.org">' +
            '<soap:Body><GetSearch xmlns="' + ns + '">' +
            '<KEY1>' + sup.key1.trim() + '</KEY1><KEY2>' + sup.key2.trim() + '</KEY2>' +
            '<text>' + query.replace(/[<>&'"]/g, '') + '</text>' +
            '<delivery_id>000000001</delivery_id>' +
            '</GetSearch></soap:Body></soap:Envelope>';

        try {
            const endpoint = 'http://' + 'api.rossko.ru/service/v2.1/GetSearch';
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': ns + 'GetSearch' },
                body: xmlBody
            });
            const xmlText = await response.text();
            const partBlocks = xmlText.split('<Part>');

            for (let i = 1; i < partBlocks.length; i++) {
                const block = partBlocks[i];
                const brand = (block.match(/<brand>(.*?)<\/brand>/) || new Array('', ''));
                const partNumber = (block.match(/<partnumber>(.*?)<\/partnumber>/) || new Array('', ''));
                const name = (block.match(/<name>(.*?)<\/name>/) || new Array('', ''));

                const stockBlocks = block.split('<stock>');
                for (let j = 1; j < stockBlocks.length; j++) {
                    const sBlock = stockBlocks[j];
                    const priceRaw = parseFloat((sBlock.match(/<price>(.*?)<\/price>/) || new Array('', '0')));
                    const count = parseInt((sBlock.match(/<count>(.*?)<\/count>/) || new Array('', '0')));
                    const delivery = parseInt((sBlock.match(/<delivery>(.*?)<\/delivery>/) || new Array('', '1')));

                    if (priceRaw > 0 && count > 0) {
                        allOffers.push({
                            supplier: sup.name,
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

    allOffers.sort(function(a, b) { return a.price - b.price; });
    return res.status(200).json({ ok: true, items: allOffers });
}
