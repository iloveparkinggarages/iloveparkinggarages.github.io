window.ParkingCore=(()=>{
'use strict';
const PROCESSOR='https://api2.authorize.net/xml/v1/request.api';
const money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format((cents||0)/100);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function parseTicket(input){
 const originalURL=String(input).trim();let url;try{url=new URL(originalURL);}catch{throw Error('Paste the full HTTPS ticket link.');}
 const match=url.pathname.match(/^\/([0-9]{1,10})\/([A-Za-z0-9]{1,512})\/?$/);
 if(url.protocol!=='https:'||url.hostname!=='t2mpof.com'||url.username||url.password||url.port||url.search||url.hash||!match||match[1]!=='2595')throw Error('Use a T2MPOF.COM ticket link for UTSA (customer 2595).');
 return {originalURL,customer:match[1],barcode:match[2]};
}
function validateQuote(q,payment=false){
 const cents=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<100000000;
 if(!q||!cents(q.amountDue))throw Error('The server did not supply a valid amount.');
 if(q.amountDue===0&&!payment)return q;
 if(!cents(q.parkingAmountDue)||!cents(q.transactionFee)||!Array.isArray(q.taxes)||!q.taxes.every(t=>t&&cents(t.amount))||typeof q.transactionUuid!=='string'||!q.transactionUuid||!['number','string'].includes(typeof q.ticketNumber)||!String(q.ticketNumber).length||q.parkingAmountDue+q.transactionFee+q.taxes.reduce((sum,t)=>sum+t.amount,0)!==q.amountDue)throw Error('The quote is incomplete or totals do not match. Recheck before paying.');
 if(payment&&(q.amountDue<=0||(q.validations!=null&&(!Array.isArray(q.validations)||q.validations.length))))throw Error('This quote cannot be paid through ParkingPocket.');return q;
}
function brandFor(number){if(/^3[47]/.test(number))return 'American Express';if(/^4/.test(number))return 'Visa';const n=Number(number.slice(0,4));if(/^5[1-5]/.test(number)||(n>=2221&&n<=2720))return 'Mastercard';if(/^(6011|65|64[4-9])/.test(number))return 'Discover';throw Error('This prototype supports Visa, Mastercard, American Express, and Discover.');}
function validateCard(input){
 const number=String(input.number??'').replace(/[\s-]/g,'');if(!/^[0-9]{13,19}$/.test(number))throw Error('Check the card number.');
 let sum=0,doubled=false;for(let i=number.length-1;i>=0;i--){let n=Number(number[i]);if(doubled){n*=2;if(n>9)n-=9;}sum+=n;doubled=!doubled;}if(sum%10)throw Error('The card number has a typo.');
 const expiration=String(input.expiration??'').match(/^\s*([0-9]{1,2})\s*\/\s*([0-9]{2}|[0-9]{4})\s*$/);
 const month=expiration?Number(expiration[1]):Number(input.month),rawYear=expiration?Number(expiration[2]):Number(input.year),year=rawYear<100?2000+rawYear:rawYear;
 const now=new Date();if(!Number.isInteger(month)||month<1||month>12||!Number.isInteger(year)||year>2099||year<now.getFullYear()||(year===now.getFullYear()&&month<now.getMonth()+1))throw Error('Check the expiration date (MM / YY).');
 const fullName=String(input.fullName??'').trim(),zip=String(input.zip??'').trim();if(!fullName||fullName.length>120||!zip||zip.length>20)throw Error('Enter the name on the card and billing ZIP / postal code.');
 // This whitelist intentionally excludes CVV and any other supplied fields.
 return {number,month,year,fullName,zip,brand:brandFor(number)};
}
function validateCVV(code,brand){if(!(brand==='American Express'?/^[0-9]{4}$/:/^[0-9]{3}$/).test(code))throw Error(`Enter the ${brand==='American Express'?'4':'3'}-digit security code from your card.`);return code;}
function processorPayload(card,cvv,merchant,id=crypto.randomUUID().toLowerCase()){
 return {securePaymentContainerRequest:{merchantAuthentication:{name:merchant.name,clientKey:merchant.clientKey},clientId:'accept-ui-v3',data:{type:'TOKEN',id,token:{cardNumber:card.number,expirationDate:String(card.month).padStart(2,'0')+String(card.year%100).padStart(2,'0'),cardCode:cvv,zip:card.zip,fullName:card.fullName}}}};
}
const enc=new TextEncoder(),dec=new TextDecoder();
function b64(bytes){let s='';for(const n of bytes)s+=String.fromCharCode(n);return btoa(s);}
function bytes(s){if(typeof s!=='string'||s.length>12000)throw Error('Invalid vault data.');return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
async function derive(passphrase,salt){const base=await crypto.subtle.importKey('raw',enc.encode(passphrase),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:600000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
function vaultAAD(record){return enc.encode(record.version===1?'parkingpocket-v1:'+record.id:'parkingpocket-v2:'+record.id+':'+JSON.stringify(record.summary));}
async function encryptCard(input,passphrase,label,id=crypto.randomUUID()){
 if(typeof passphrase!=='string'||!passphrase.length)throw Error('Enter a passcode.');
 const card=validateCard(input);const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
 const summary={label:String(label||'My card').slice(0,60),brand:card.brand,lastFour:card.number.slice(-4)},record={id,version:2,iterations:600000,summary},key=await derive(passphrase,salt),plaintext=enc.encode(JSON.stringify({schema:1,label:summary.label,card}));
 try{const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:vaultAAD(record),tagLength:128},key,plaintext);return {...record,salt:b64(salt),iv:b64(iv),ciphertext:b64(new Uint8Array(encrypted))};}finally{plaintext.fill(0);}
}
async function decryptCard(record,passphrase){
 let plaintext;try{
  if(![1,2].includes(record?.version)||record.iterations!==600000||typeof record.id!=='string')throw Error();
  if(record.version===2&&(!record.summary||typeof record.summary.label!=='string'||record.summary.label.length>60||typeof record.summary.brand!=='string'||!/^\d{4}$/.test(record.summary.lastFour)))throw Error();
  const salt=bytes(record.salt),iv=bytes(record.iv),ciphertext=bytes(record.ciphertext);if(salt.length!==16||iv.length!==12||ciphertext.length<17)throw Error();
  const key=await derive(passphrase,salt);plaintext=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:vaultAAD(record),tagLength:128},key,ciphertext));
  const parsed=JSON.parse(dec.decode(plaintext));if(parsed.schema!==1||typeof parsed.label!=='string')throw Error();return {label:parsed.label,card:validateCard(parsed.card)};
 }catch{throw Error('Could not unlock this card. Check the passcode; the saved record may also be damaged. Nothing was filled or submitted.');}finally{plaintext?.fill(0);}
}
let database;
async function db(){if(database)return database;database=await new Promise((resolve,reject)=>{const request=indexedDB.open('parkingpocket-web-v1',1);request.onupgradeneeded=()=>{const d=request.result;d.createObjectStore('tickets',{keyPath:'id'});d.createObjectStore('vault',{keyPath:'id'});d.createObjectStore('preferences');};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('Local storage is unavailable. Enable browser storage to continue.'));});return database;}
async function storeAction(store,action,value,key){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction(store,action==='getAll'||action==='get'?'readonly':'readwrite');let request;try{const s=tx.objectStore(store);request=key===undefined?s[action](...(value===undefined?[]:[value])):s[action](value,key);}catch(error){reject(error);return;}tx.oncomplete=()=>resolve(request.result);tx.onabort=tx.onerror=()=>reject(Error('Could not save local data. No payment was submitted.'));});}
function merchantFrom(customer){const attrs={};for(const a of Array.isArray(customer?.attributes)?customer.attributes:[])if(a?.isEnabled&&typeof a.attributeLabel==='string'&&typeof a.attributeValue==='string')attrs[a.attributeLabel]=a.attributeValue;
 if(attrs['Card Payment Processor']!=='AUTH_NET'||!attrs['Authorize.NET API Key']||!attrs['Authorize.Net: Public Key'])throw Error('This location has no supported card processor settings.');return {name:attrs['Authorize.NET API Key'],clientKey:attrs['Authorize.Net: Public Key']};}
function recheckAt(ticket,q){let time=Date.parse(q?.entryDateTime);if(!Number.isFinite(time))time=ticket.recheckAt?ticket.recheckAt-900000:ticket.createdAt;return Math.min(Date.now()+900000,Math.max(Date.now(),time+900000));}

let accessKey='';

function workerOrigin(){
 const configured=window.ParkingPocketConfig?.apiOrigin?.trim();
 if(!configured)throw Error('Set your Worker URL in api-config.js first.');
 let url;
 try{url=new URL(configured);}catch{throw Error('Enter a valid Worker URL in api-config.js.');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||
    !/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname))
  throw Error('Use the HTTPS workers.dev origin for your Worker.');
 return url.origin;
}
function apiConnected(){return accessKey.length>0;}
function requireAPI(){
 if(!apiConnected())throw Error('Connect the parking API in Settings first.');
}
function disconnectAPI(){accessKey='';}
async function connectParkingAPI(key){
 if(!/^[a-f0-9]{64}$/i.test(key))throw Error('Enter your 64-character API access key.');
 const result=await requestAPI('health',undefined,key);
 if(result.status!=='ready')throw Error('The parking API is unavailable.');
 accessKey=key;
}
async function requestAPI(path,body,key){
 const url=workerOrigin()+'/api/'+path;
 let response;
 try{
  response=await fetch(url,{
   method:body===undefined?'GET':'POST',
   headers:{Authorization:'Bearer '+key,...(body===undefined?{}:{'Content-Type':'application/json'})},
   body:body===undefined?undefined:JSON.stringify(body),
   credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(45000)
  });
 }catch{throw Error('The parking API could not be reached. No automatic retry was made.');}
 const result=await response.json().catch(()=>null);
 if(!response.ok||!result||result.error)throw Error(result?.error||'Parking API request failed ('+response.status+').');
 return result;
}
async function api(path,body){
 requireAPI();
 return requestAPI(path,body,accessKey);
}

return {esc,money,parseTicket,validateQuote,validateCard,validateCVV,processorPayload,encryptCard,decryptCard,storeAction,api,merchantFrom,recheckAt,PROCESSOR,apiConnected,requireAPI,connectParkingAPI,disconnectAPI};
})();
