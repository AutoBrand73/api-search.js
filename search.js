const SUPABASE_URL='https://YOUR-PROJECT.supabase.co';
const SUPABASE_KEY='ВАШ_SERVICE_ROLE_KEY';

async function getUser(token){
  if(!token)return null;
  const r=await fetch(SUPABASE_URL+'/auth/v1/user',{headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+token}});
  if(!r.ok)return null;
  const u=await r.json();
  return u&&u.id?u:null;
}
async function getSuppliers(){
  const r=await fetch(SUPABASE_URL+'/rest/v1/suppliers?select=*',{headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY}});
  if(!r.ok)return [];
  const rows=await r.json();
  return rows.filter(function(s){return s.active!==false;});
}
async function getMarkups(){
  const r=await fetch(SUPABASE_URL+'/rest/v1/markups?select=min_price,max_price,percent',{headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY}});
  if(!r.ok)return [];
  const rows=await r.json();
  return rows.filter(function(m){return Number(m.percent)>0;});
}
function applyMarkup(price,markups){
  let p=Number(price);
  for(const m of markups){
    const min=m.min_price==null?0:Number(m.min_price);
    const max=m.max_price==null?Infinity:Number(m.max_price);
    if(p>=min&&p<=max){p=p*(1+Number(m.percent)/100);break;}
  }
  return Math.round(p*100)/100;
}
function tagVal(block,tag){
  const re=new RegExp('<(?:[\\w]+:)?'+tag+'\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w]+:)?'+tag+'>','i');
  const m=block.match(re);
  return m?m[1].trim():'';
}
function attrVal(block,name){
  const re=new RegExp(name+'="([^"]*)"','i');
  const m=block.match(re);
  return m?m[1]:'';
}
function daysFromDate(s){
  if(!s)return NaN;
  if(/^\d{1,3}$/.test(s))return parseInt(s,10);
  const d=new Date(s);
  if(isNaN(d.getTime()))return NaN;
  return Math.max(1,Math.round((d.getTime()-Date.now())/86400000));
}
function parseRossco(xml){
  const out=[];
  const blocks=xml.split(/<(?:[\w]+:)?Part\b/);
  for(let i=1;i<blocks.length;i++){
    const block=blocks[i];
    const stock=parseInt(tagVal(block,'Stock'),10)||0;
    const days=daysFromDate(tagVal(block,'Date'));
    const code=attrVal(block,'Code');
    const name=attrVal(block,'Name')||attrVal(block,'Description');
    const brand=attrVal(block,'Producer')||attrVal(block,'Brand')||attrVal(block,'MakeName')||'—';
    const price=parseFloat(attrVal(block,'Price'));
    if(!isNaN(days)&&days>0&&stock>0&&code&&!isNaN(price)){
      out.push({days:days,stock:stock,price:price,code:code,name:name||code,brand:brand});
    }
  }
  return out;
}
async function queryRossco(sup,q,extraDays){
  const days1=String(new Date(Date.now()+(1+extraDays)*86400000)).slice(0,10);
  const days2=String(new Date(Date.now()+(14+extraDays)*86400000)).slice(0,10);
  const body='<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:q0="http://v3.webbazaar.ru">'+
  '<soapenv:Body><q0:PriceQuery>'+
  '<q0:request><q0:Key1>'+sup.key1+'</q0:Key1><q0:Key2>'+sup.key2+'</q0:Key2>'+
  '<q0:Find>'+q+'</q0:Find><q0:Date1>'+days1+'</q0:Date1><q0:Date2>'+days2+'</q0:Date2>'+
  '</q0:request></q0:PriceQuery></soapenv:Body></soapenv:Envelope>';
  const r=await fetch('https://api.rossko.ru/service/v2/GetSearch',{
    method:'POST',
    headers:{'Content-Type':'text/xml;charset=UTF-8','SOAPAction':'http://api.rossko.ru/service/v2/GetSearch/GetSearch'},
    body:body
  });
  if(!r.ok)return {error:'HTTP '+r.status};
  const xml=await r.text();
  if(/Success[^a-zA-Z]*(false|False)/.test(xml))return {error:'склад отклонил запрос'};
  return {parts:parseRossco(xml)};
}
export default async function handler(req,res){
  if(req.method!=='GET'&&req.method!=='POST')return res.status(405).json({ok:false,error:'Метод не поддерживается'});
  const url=new URL(req.url,'http://localhost');
  const q=(url.searchParams.get('q')||'').trim();
  const supplierId=url.searchParams.get('supplier');
  let token='';
  const ah=req.headers['authorization']||'';
  if(ah.indexOf('Bearer ')===0)token=ah.slice(7);
  if(!q)return res.status(400).json({ok:false,error:'Укажите параметр q'});
  const usr=await getUser(token);
  if(!usr)return res.status(401).json({ok:false,error:'Требуется вход в аккаунт'});
  try{
    let suppliers=await getSuppliers();
    if(supplierId)suppliers=suppliers.filter(function(s){return String(s.id)===String(supplierId);});
    if(!suppliers.length)return res.json({ok:true,results:[]});
    const markups=await getMarkups();
    const settled=await Promise.all(suppliers.map(function(sup){
      return queryRossco(sup,q,sup.extra_days||0).then(function(r){
        return {sup:sup,parts:r.error?null:r.parts};
      }).catch(function(){return {sup:sup,parts:null};});
    }));
    const results=[];
    for(const s of settled){
      if(!s.parts)continue;
      for(const it of s.parts.slice(0,20)){
        results.push({
          brand:it.brand,
          article:it.code,
          name:it.name,
          delivery:it.days,
          stock:it.stock,
          cost:it.price,
          price:applyMarkup(it.price,markups)
        });
      }
    }
    results.sort(function(a,b){return a.price-b.price;});
    return res.json({ok:true,results:results.slice(0,60)});
  }catch(e){
    return res.status(500).json({ok:false,error:'Ошибка сервера: '+e.message});
  }
}
