const UPSTREAM='https://auth-gateway.prod.link.t2systems.com/api/v1';
const noStore={'Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:noStore});
const str=(x,max=512)=>typeof x==='string'&&x.length>0&&x.length<=max;
const cents=x=>Number.isSafeInteger(x)&&x>=0&&x<100000000;
const exact=(obj,keys)=>obj&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).every(key=>keys.includes(key))&&keys.every(key=>Object.hasOwn(obj,key));
function validateRequest(route,body){
 if(route==='pricing'){
  if(!exact(body,['barcodeData'])||!str(body.barcodeData)||!/^[A-Za-z0-9]+$/.test(body.barcodeData))throw Error('Use a supported ticket barcode.');
  return {barcodeData:body.barcodeData};
 }
 if(route==='tokens'){
  if(!exact(body,['paymentProvider','transactionUuid','providerInstrumentId'])||body.paymentProvider!=='AUTH_NET_LIGHT'||!str(body.transactionUuid,128)||!str(body.providerInstrumentId,8192))throw Error('Invalid payment token request.');return body;
 }
 if(route==='payments'){
  if(!exact(body,['barcodeData','totalAmountPaid','parkingAmount','taxes','transactionUuid','paymentProvider','providerInstrumentId','paymentDateTime','cardTokenUuid','paymentDetails'])||!str(body.barcodeData)||!/^[A-Za-z0-9]+$/.test(body.barcodeData)||!cents(body.totalAmountPaid)||body.totalAmountPaid<=0||!cents(body.parkingAmount)||body.parkingAmount>body.totalAmountPaid||!Array.isArray(body.taxes)||body.taxes.length>30||!body.taxes.every(t=>t&&cents(t.amount))||!str(body.transactionUuid,128)||body.paymentProvider!=='AUTH_NET_LIGHT'||!str(body.providerInstrumentId,8192)||!str(body.cardTokenUuid,128)||!str(body.paymentDateTime,50)||!Number.isFinite(Date.parse(body.paymentDateTime)))throw Error('Invalid payment request.');
  const d=body.paymentDetails;if(!exact(d,['brand','lastFour','expirationMonth','expirationYear'])||!['Visa','Mastercard','American Express','Discover'].includes(d.brand)||!/^\d{4}$/.test(d.lastFour)||!Number.isInteger(d.expirationMonth)||d.expirationMonth<1||d.expirationMonth>12||!Number.isInteger(d.expirationYear)||d.expirationYear<2020||d.expirationYear>2099)throw Error('Invalid masked card metadata.');
  if(body.taxes.reduce((sum,t)=>sum+t.amount,body.parkingAmount)>body.totalAmountPaid)throw Error('Invalid payment totals.');return body;
 }
 throw Error('Unknown operation.');
}
function safeQuote(q){const result={};for(const key of ['amountDue','parkingAmountDue','transactionFee','taxes','transactionUuid','ticketNumber','validations','facilityName','entryDateTime'])if(q[key]!==undefined)result[key]=q[key];return result;}
async function proxy(request,route){
 if(route==='health'&&request.method==='GET')return json({status:'ready'});
 const method=route==='customer'?'GET':'POST';if(request.method!==method)return json({error:'Method not allowed.'},405);
 if(method==='POST'){
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))return json({error:'JSON required.'},415);
 }
 const paths={customer:'/customers/2595',pricing:'/pof/pricing/2595',tokens:'/pof/payments/tokens/2595',payments:'/pof/payments/2595'};
 if(!paths[route])return json({error:'Not found.'},404);
 let body;try{if(method==='POST'){const raw=await request.text();if(raw.length>32768)return json({error:'Request too large.'},413);body=validateRequest(route,JSON.parse(raw));}}catch{return json({error:'The request contains invalid or unexpected fields.'},400);}
 let response;try{response=await fetch(UPSTREAM+paths[route],{method,headers:{'Accept':'application/json','Content-Type':'application/json','Origin':'https://t2mpof.com','Referer':'https://t2mpof.com/'},body:body?JSON.stringify(body):undefined,redirect:'manual',signal:AbortSignal.timeout(40000)});}catch{return json({error:'The parking service could not be reached. No automatic retry was made.'},502);}
 if(!response.ok)return json({error:`Parking service returned HTTP ${response.status}. ${route==='payments'?'Payment outcome must be verified.':'Try again later.'}`},502);
 let data;try{const raw=await response.text();if(raw.length>1048576)throw Error();data=JSON.parse(raw);}catch{return json({error:'Unexpected parking service response. Verify any attempted payment.'},502);}
 if(data?.status?.responseStatus!=='Success'||!data.response||typeof data.response!=='object')return json({error:'The parking service did not report success. Verify any attempted payment before retrying.'},502);
 const r=data.response;
 if(route==='customer'){const allowed=['Card Payment Processor','Authorize.NET API Key','Authorize.Net: Public Key'];return json({attributes:(Array.isArray(r.attributes)?r.attributes:[]).filter(a=>a?.isEnabled&&allowed.includes(a.attributeLabel)).map(a=>({isEnabled:true,attributeLabel:a.attributeLabel,attributeValue:a.attributeValue}))});}
 if(route==='pricing')return json(safeQuote(r));
 if(route==='tokens')return json({cardTokenUuid:r.cardTokenUuid});
 return json({paymentUuid:r.paymentUuid,amountPaid:r.amountPaid,paymentDateTime:r.paymentDateTime});
}
function matchesKey(header,secret){
 const received=header?.startsWith('Bearer ')?header.slice(7):'';
 if(!/^[a-f0-9]{64}$/i.test(secret)||received.length!==secret.length)return false;
 let difference=0;
 for(let i=0;i<secret.length;i++)difference|=received.charCodeAt(i)^secret.charCodeAt(i);
 return difference===0;
}

export default {
 async fetch(request,env){
  const origin=request.headers.get('Origin');
  if(!origin||origin==='null'||origin!==env.ALLOWED_ORIGIN)
   return json({error:'This website is not allowed to use the parking API.'},403);

  const path=new URL(request.url).pathname;
  if(!/^\/api\/(health|customer|pricing|tokens|payments)$/.test(path))
   return json({error:'Not found.'},404);

  const cors={
   'Access-Control-Allow-Origin':origin,
   'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
   'Access-Control-Allow-Headers':'Authorization, Content-Type',
   'Vary':'Origin',
   'Cache-Control':'no-store'
  };
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});

  let response;
  if(!matchesKey(request.headers.get('Authorization'),env.PARKINGPOCKET_API_KEY))
   response=json({error:'The API access key is missing or incorrect.'},401);
  else{
   try{response=await proxy(request,path.slice('/api/'.length));}
   catch{response=json({error:'The request could not be completed. Verify any attempted payment.'},500);}
  }
  const headers=new Headers(response.headers);
  for(const [name,value] of Object.entries(cors))headers.set(name,value);
  return new Response(response.body,{status:response.status,headers});
 }
};
