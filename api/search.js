// api/search.js — серверный поиск по складам поставщиков (Rossko SOAP)
export default async function handler(req, res) {
    const SUPABASE_URL = 'https://fnlupijomjpopqtnyodv.supabase.co/rest/v1/';
    const SUPABASE_KEY = 'sb_publishable_l1pVfFfga-1Tu9Yr1ms2Lw_PrY1CoZw';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const query = (req.query.q || '').trim();
    if (!query) return res.status(400).json({ ok: false, error: 'Пустой запрос' });

    const headers = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY };

    // 1. Загружаем наценки и активных поставщиков из базы
    let rules = new Array();
    let suppliers = new Array();

    try {
        // ИСПРАВЛЕНО: SUPABASE_URL уже содержит /rest/v1/, дублировать путь нельзя
        const mRes = await fetch(SUPABASE_URL + 'markups?select=*&order=price_from.asc', { headers: headers });
        if (mRes.ok) rules = await mRes.json();

        const sRes = await fetch(SUPABASE_URL + 'suppliers?is_active=eq.true&select=*', { headers: headers });
        if (sRes.ok) suppliers = await sRes.json();
    } catch (e) {
        return res.status(500).json({ ok: false, error: 'Ошибка чтения базы: ' + e.message });
    }

    if (!Array.isArray(suppliers) || suppliers.length === 0) {
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
    const ns = 'http://rossko.ru/';

    // 2. Опрашиваем каждого подключенного поставщика
    for (let s = 0; s < suppliers.length; s++) {
        const sup = suppliers[s];
        if (!sup.key1 || !sup.key2) continue;

        // ИСПРАВЛЕНО: корректные SOAP-неймспейсы (w3.org/xmlsoap.org — не существующие адреса)
        const xmlBody = '<?xml version="1.0" encoding="utf-8"?>' +
            '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
            '<soap:Body><GetSearch xmlns="' + ns + '">' +
            '<KEY1>' + sup.key1.trim() + '</KEY1><KEY2>' + sup.key2.trim() + '</KEY2>' +
            '<text>' + query.replace(/[<>&"']/g, ' ') + '</text>' +
            '<delivery_id>000000001</delivery_id>' +
            '</GetSearch></soap:Body></soap:Envelope>';

        try {
            // ИСПРАВЛЕНО: https вместо http
            const response = await fetch('https://api.rossko.ru/service/v2.1/GetSearch', {
                method: 'POST',
                headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': ns + 'GetSearch' },
                body: xmlBody
            });
            let xmlText = await response.text();

            // ИСПРАВЛЕНО:Rossko может вернуть теги с префиксом ns1:<Part> — снимаем префиксы,
            // иначе разбор по строке '<Part>' ничего не находит
            xmlText = xmlText.replace(/(<\/?)[A-Za-z_][\w.-]*:/g, '$1');

            if (/<Success>\s*false/i.test(xmlText)) continue;

            const partBlocks = xmlText.split('<Part>');
            for (let i = 1; i < partBlocks.length; i++) {
                const block = partBlocks[i];
                // ИСПРАВЛЕНО: match возвращает массив — нужно брать группу [1],
                // иначе в интерфейс попадала строка "<brand>...</brand>"
                const brand = (block.match(/<brand>([\s\S]*?)<\/brand>/i) || new Array('', ''))[1].trim();
                const partNumber = (block.match(/<partnumber>([\s\S]*?)<\/partnumber>/i) || new Array('', ''))[1].trim();
                const name = (block.match(/<name>([\s\S]*?)<\/name>/i) || new Array('', ''))[1].trim();

                // ИСПРАВЛЕНО: в ответе Росско тег <Stock> с заглавной буквы, а не <stock>
                const stockBlocks = block.split(/<Stock>/i);
                for (let j = 1; j < stockBlocks.length; j++) {
                    const sBlock = stockBlocks[j];
                    // parseFloat по массиву давал NaN — теперь берём [1];
                    // поле срока поддерживает и delivery, и DeliveryTime (v1/v2 API)
                    const priceRaw = parseFloat((sBlock.match(/<price>([\s\S]*?)<\/price>/i) || new Array('', '0'))[1]);
                    const count = parseInt((sBlock.match(/<count>([\s\S]*?)<\/count>/i) || new Array('', '0'))[1], 10);
                    const delivery = parseInt((sBlock.match(/<delivery(?:time)?>([\s\S]*?)<\/delivery(?:time)?>/i) || new Array('', '1'))[1], 10);

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
        } catch (err) {
            // поставщик недоступен — пропускаем и идём к следующему
        }
    }

    allOffers.sort(function(a, b) { return a.price - b.price; });
    return res.status(200).json({ ok: true, items: allOffers });
}
