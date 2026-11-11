(() => {
'use strict';
const {wireTicketSwipes,setTicketEditing,closeTicketSwipes}=window.ParkingSwipes;
const {icon,hydrateIcons}=window.ParkingIcons;
const {esc,money,parseTicket,validateQuote,validateCard,validateCVV,processorPayload,encryptCard,decryptCard,storeAction,api,merchantFrom,recheckAt,PROCESSOR,apiConnected,requireAPI,connectParkingAPI,disconnectAPI,getVaultPasscode,setVaultPasscode,verifyVaultPasscode,MIN_PASSCODE}=window.ParkingCore;
const $=selector=>document.querySelector(selector),all=selector=>[...document.querySelectorAll(selector)];
let currentView='tickets',editingTickets=false;
let apiConnection=null;
let filter='all',tickets=[],vault=[],vaultPasscode=null,busy=false,activeTicket=null,scanStream=null,scanFrame=null,inactivity=null,toastTimer=null;
const date=n=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(n));
const statusLabel={ready:'Ready to pay',waiting:'Recheck needed',paid:'Paid & saved',saved:'Saved',error:'Needs attention',uncertain:'Verify payment'};
function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4500);}
function showError(error){const message=error.message||'Something went wrong. Please try again.';if($('#sheet').open){let box=$('#sheet-error');if(!box){box=document.createElement('div');box.id='sheet-error';box.className='notice red';box.setAttribute('role','alert');$('#sheet-body').prepend(box);}box.textContent=message;}else toast(message);}
function stopScan(){cancelAnimationFrame(scanFrame);scanStream?.getTracks().forEach(track=>track.stop());scanStream=null;}
function clearSensitive(){all('input[data-sensitive]').forEach(input=>{input.value='';});clearTimeout(inactivity);}
function closeSheet(){if(busy){toast('Wait for this operation to finish.');return;}apiConnection?.abort();apiConnection=null;clearSensitive();stopScan();$('#sheet').close();activeTicket=null;}
function sheet(title,subtitle,html){closeTicketSwipes($('#ticket-list'));stopScan();clearSensitive();$('#sheet-title').innerHTML=`<h2>${esc(title)}</h2><small>${esc(subtitle)}</small>`;$('#sheet-body').innerHTML=html;hydrateIcons($('#sheet-body'));if(!$('#sheet').open)$('#sheet').showModal();}
async function operation(fn){if(busy)return;$('#sheet-error')?.remove();busy=true;const buttons=all('#sheet button,#sheet input[type=submit]');buttons.forEach(x=>x.disabled=true);try{await fn();}catch(e){showError(e);}finally{busy=false;buttons.forEach(x=>x.disabled=false);}}
function setView(view){closeTicketSwipes($('#ticket-list'));currentView=view;$('#toolbar-left').innerHTML=view==='tickets'?'Cards':icon('chevron-left')+'<span>Tickets</span>';$('#toolbar-add').hidden=view!=='vault';$('#add-ticket').hidden=view!=='tickets';for(const name of ['tickets','vault','settings'])$(`#${name}-view`).hidden=name!==view;all('.nav-item').forEach(button=>button.classList.toggle('active',button.dataset.view===view));if(view==='vault')renderVault();window.scrollTo({top:0,behavior:'smooth'});}
async function reload(){
 // Ignore legacy sample tickets while keeping real tickets, including archived payment records.
 tickets=(await storeAction('tickets','getAll')).filter(ticket=>!ticket.demo);
 vault=await storeAction('vault','getAll');
 vaultPasscode=await getVaultPasscode();
 renderTickets();
}
function ticketSymbol(status){return icon(status==='paid'?'circle-check':status==='ready'?'credit-card':status==='uncertain'?'circle-question':'circle-exclamation');}

function renderTickets(){
 const selected=tickets.filter(t=>!t.archived).sort((a,b)=>b.createdAt-a.createdAt);
 $('#ticket-count').textContent=String(selected.length);
 const visible=selected.filter(t=>filter==='all'||(filter==='paid'?t.status==='paid':t.status!=='paid'));
 $('#ticket-list').innerHTML=visible.length?visible.map(t=>`<div class="ticket-swipe" data-swipe="${esc(t.id)}"><div class="ticket-swipe-track"><button class="ticket-row state-${esc(t.status)}" data-ticket="${esc(t.id)}"><span class="ticket-symbol" aria-hidden="true">${ticketSymbol(t.status)}</span><span class="ticket-content"><span class="ticket-name">${esc(t.name||'New ticket')} · <span class="ticket-date">${esc(date(t.createdAt))}</span></span>${t.facility||t.quote?.facilityName?`<span class="ticket-place">${esc(t.facility||t.quote.facilityName)}</span>`:''}<span class="ticket-status">${t.status==='paid'?'PAID · TAP FOR QR':t.status==='ready'?`AMOUNT DUE · ${money(t.quote?.amountDue)}`:esc((statusLabel[t.status]||'Saved').toUpperCase())}</span></span><span class="row-chevron" aria-hidden="true">${icon('chevron-right')}</span></button><button class="ticket-swipe-delete" data-delete-ticket="${esc(t.id)}" aria-label="Delete ticket ${esc(t.name||t.quote?.ticketNumber||'')}" inert>${icon('trash')}<span>Delete</span></button></div></div>`).join(''):`<div class="empty-state"><h3>No tickets</h3><p>${selected.length?'No tickets in this view.':'Scan or paste a ticket link to get started.'}</p></div>`;
 all('[data-ticket]').forEach(button=>button.onclick=()=>{
  const lane=button.closest('.ticket-swipe');
  if(lane.scrollLeft>2&&!editingTickets){lane.scrollTo({left:0,behavior:'auto'});return;}
  if(busy)return;
  const t=tickets.find(x=>x.id===button.dataset.ticket);if(t?.status==='paid')showQR(t);else detail(button.dataset.ticket);
 });
 all('[data-delete-ticket]').forEach(button=>button.onclick=()=>deleteTicket(button.dataset.deleteTicket));
 $('#ticket-list').dataset.editing=String(editingTickets);
 wireTicketSwipes($('#ticket-list'));setTicketEditing($('#ticket-list'),editingTickets);
 $('#edit-tickets').hidden=!visible.length;$('#edit-tickets').textContent=editingTickets?'Done':'Edit';$('#edit-tickets').setAttribute('aria-pressed',String(editingTickets));
}
function detail(id){const t=tickets.find(t=>t.id===id);if(!t)return;activeTicket=id;
 sheet(t.name||'Your parking ticket',`Saved ${date(t.createdAt)}`,`<div class="summary"><div><small>${t.status==='paid'?'Payment saved':'Saved amount due'}</small><strong>${t.quote||t.receipt?money(t.receipt?.amountPaid??t.quote?.amountDue):'Not checked'}</strong></div><span class="badge ${esc(t.status)}">${esc(statusLabel[t.status]||'Saved')}</span></div>${t.status==='waiting'?`<div class="notice amber">This ticket may be too new. Recheck ${t.recheckAt>Date.now()?`around ${esc(date(t.recheckAt))}`:'now'} for an updated price. Rechecking is manual.</div>`:''}${t.status==='uncertain'?'<div class="notice red">A payment was attempted. Verify the official receipt and card activity before paying elsewhere. This app will not retry this ticket.</div>':''}${t.lastError?`<div class="notice amber">${esc(t.lastError)}</div>`:''}<div class="detail-group"><div class="detail-line"><span>Facility</span><strong>${esc(t.facility||t.quote?.facilityName||'UTSA parking')}</strong></div><div class="detail-line"><span>Ticket</span><strong>${esc(t.quote?.ticketNumber||'Pending')}</strong></div><div class="detail-line"><span>Last checked</span><strong>${t.quotedAt?esc(date(t.quotedAt)):'Not checked yet'}</strong></div></div><div class="action-group">${t.status==='ready'?'<button id="checkout-button" class="button primary wide">Continue to payment <span data-icon="arrow-right"></span></button>':''}${!['paid','uncertain'].includes(t.status)?'<button id="recheck-button" class="button secondary wide"><span data-icon="refresh"></span>Recheck ticket</button>':''}<button id="qr-button" class="button secondary wide"><span data-icon="qrcode"></span>Show original ticket QR</button><div class="list-actions"><button id="rename-button" class="text-button"><span data-icon="pen"></span>Rename ticket</button><button id="delete-ticket" class="text-button destructive"><span data-icon="trash"></span>Delete ticket</button></div></div><p class="small-note">Keep the physical ticket and official receipt. The saved QR contains the original ticket code.</p>`);
 $('#checkout-button')?.addEventListener('click',()=>operation(()=>checkout(id)));$('#recheck-button')?.addEventListener('click',()=>{
  if(busy)return;
  const savedAmount=tickets.find(ticket=>ticket.id===id)?.quote?.amountDue;
  if(Number.isSafeInteger(savedAmount)&&savedAmount>0&&!confirm(`This ticket already has a saved price of ${money(savedAmount)}. Rechecking will request a new quote and may change the amount due. Recheck this ticket?`))return;
  operation(async()=>{await refreshTicket(id);detail(id);});
 });$('#qr-button').onclick=()=>showQR(t);
 $('#rename-button').onclick=()=>{const name=prompt('Ticket name',t.name||'');if(name!==null)operation(async()=>{t.name=name.trim().slice(0,80);await storeAction('tickets','put',t);await reload();detail(id);});};
 $('#delete-ticket').onclick=()=>deleteTicket(id);
}
function deleteTicket(id){
 if(busy)return;
 const ticket=tickets.find(t=>t.id===id);if(!ticket)return;
 if(!confirm(`Delete ${ticket.name||'this ticket'} from your list? Previous payment attempts will remain blocked on this device.`))return;
 operation(async()=>{
  const remove=async()=>{
   const saved=await storeAction('tickets','get',id);if(!saved||saved.archived)return;
   if(saved.status==='paid'||saved.status==='uncertain'||saved.attemptAt||saved.receipt)await storeAction('tickets','put',{...saved,archived:true});
   else await storeAction('tickets','delete',id);
  };
  if(navigator.locks)await navigator.locks.request('parkingpocket-payment-'+id,{ifAvailable:true},async lock=>{if(!lock)throw Error('This ticket is being processed in another tab. Wait until it finishes before deleting.');await remove();});
  else await remove();
  await reload();busy=false;if($('#sheet').open)closeSheet();toast('Ticket deleted.');
 });
}
function showQR(t){sheet('Your original ticket',t.name||'Keep your physical ticket',`<div class="qr-wrap"><canvas id="ticket-qr"></canvas><p>${esc(t.originalURL)}</p></div><p class="small-note">This is the exact original ticket link. Use the official receipt to verify payment.</p><button id="back-detail" class="button secondary wide">Back to ticket</button><button id="qr-delete-ticket" class="button danger wide"><span data-icon="trash"></span>Delete ticket</button>`);const qr=window.qrcode(0,'M');qr.addData(t.originalURL);qr.make();const canvas=$('#ticket-qr'),size=qr.getModuleCount(),scale=Math.max(2,Math.floor(300/(size+8)));canvas.width=canvas.height=(size+8)*scale;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#000';for(let row=0;row<size;row++)for(let col=0;col<size;col++)if(qr.isDark(row,col))ctx.fillRect((col+4)*scale,(row+4)*scale,scale,scale);$('#back-detail').onclick=()=>detail(t.id);$('#qr-delete-ticket').onclick=()=>deleteTicket(t.id);}
async function refreshTicket(id){
 requireAPI();
 const refresh=async()=>{
  const ticket=await storeAction('tickets','get',id);
  if(!ticket||ticket.demo||ticket.archived||ticket.attemptAt||['paid','uncertain'].includes(ticket.status))
   throw Error('This ticket cannot be refreshed.');

  let quote;
  try{quote=validateQuote(await api('pricing',{barcodeData:ticket.barcode}));}
  catch(error){
   ticket.lastError=error.message;
   if(!ticket.quote)ticket.status='error';
   await storeAction('tickets','put',ticket);
   await reload();
   throw error;
  }
  ticket.quote=quote;
  ticket.facility=quote.facilityName;
  ticket.quotedAt=Date.now();
  ticket.status=quote.amountDue===0?'waiting':'ready';
  if(ticket.status==='waiting')ticket.recheckAt=recheckAt(ticket,quote);
  delete ticket.lastError;
  await storeAction('tickets','put',ticket);
  await reload();
 };
 if(navigator.locks){
  await navigator.locks.request('parkingpocket-payment-'+id,{ifAvailable:true},lock=>{
   if(!lock)throw Error('This ticket is being processed in another tab.');
   return refresh();
  });
 }else await refresh();
}
function addTicket(){sheet('Add a ticket','UTSA parking',`<form id="add-form"><label for="ticket-url">Ticket link</label><input id="ticket-url" type="url" inputmode="url" placeholder="https://t2mpof.com/2595/…" required autocomplete="off"><label for="ticket-name">A name for this stop <span>(optional)</span></label><input id="ticket-name" maxlength="80" placeholder="Afternoon on campus" autocomplete="off"><div class="scan-controls"><button type="button" id="camera" class="button secondary"><span data-icon="camera"></span> Scan QR</button><label class="button secondary file-label"><span data-icon="image"></span> Choose photo<input id="ticket-photo" type="file" accept="image/*"></label></div><video id="scanner" class="scanner-video" playsinline muted hidden></video><p id="scan-note" class="small-note">Scan a QR, select a ticket photo, or paste its full link. Photos stay on this device.</p><button class="button primary wide" type="submit">Save ticket <span data-icon="arrow-right"></span></button></form>`);
 $('#add-form').onsubmit=event=>{event.preventDefault();operation(async()=>{const parsed=parseTicket($('#ticket-url').value),name=$('#ticket-name').value.trim();let t=tickets.find(t=>t.barcode===parsed.barcode&&t.customer===parsed.customer);if(t){t.archived=false;await storeAction('tickets','put',t);await reload();detail(t.id);toast('Opened your saved ticket.');return;}t={id:crypto.randomUUID(),...parsed,name,status:'saved',createdAt:Date.now()};await storeAction('tickets','put',t);await reload();if(apiConnected()){try{await refreshTicket(t.id);}catch{}}detail(t.id);});};
 $('#camera').onclick=()=>startCamera();$('#ticket-photo').onchange=event=>readPhoto(event.target.files?.[0]);
}
function acceptScan(value){try{parseTicket(value);$('#ticket-url').value=value;$('#scan-note').textContent='Ticket found. Give it a name and save when you’re ready.';stopScan();$('#scanner').hidden=true;toast('Ticket link found.');return true;}catch{return false;}}
async function startCamera(){try{stopScan();scanStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});const video=$('#scanner');video.hidden=false;video.srcObject=scanStream;await video.play();const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});let last=0;function frame(time){if(!scanStream)return;if(time-last>200&&video.readyState>=2){last=time;const scale=Math.min(1,900/video.videoWidth);canvas.width=video.videoWidth*scale;canvas.height=video.videoHeight*scale;ctx.drawImage(video,0,0,canvas.width,canvas.height);const im=ctx.getImageData(0,0,canvas.width,canvas.height);const code=window.jsQR(im.data,im.width,im.height);if(code&&acceptScan(code.data))return;}scanFrame=requestAnimationFrame(frame);}scanFrame=requestAnimationFrame(frame);}catch{toast('Camera unavailable. Allow camera access or select a photo / paste the link.');stopScan();}}
async function readPhoto(file){if(!file)return;if(file.size>20000000){toast('Choose a photo smaller than 20 MB.');return;}stopScan();const url=URL.createObjectURL(file);try{const image=new Image();image.src=url;await image.decode();const scale=Math.min(1,1800/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=image.width*scale;canvas.height=image.height*scale;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0,canvas.width,canvas.height);const data=ctx.getImageData(0,0,canvas.width,canvas.height),code=window.jsQR(data.data,data.width,data.height,{inversionAttempts:'attemptBoth'});if(!code||!acceptScan(code.data))toast('No supported ticket QR found. Try a sharper photo or paste the link.');}catch{toast('Could not read this image. Try a JPEG or PNG, or paste the ticket link.');}finally{URL.revokeObjectURL(url);}}
function cardFields(prefix='card'){return `<div><label for="${prefix}-number">Card number</label><input id="${prefix}-number" name="cc-number" autocomplete="cc-number" inputmode="numeric" data-sensitive required maxlength="28" placeholder="0000 0000 0000 0000"><div class="field-row"><div><label for="${prefix}-expiration">Expiration</label><input id="${prefix}-expiration" name="cc-exp" autocomplete="cc-exp" inputmode="numeric" data-sensitive required placeholder="MM / YY" maxlength="9"></div><div><label for="${prefix}-cvv">Security code</label><input id="${prefix}-cvv" name="cc-csc" autocomplete="cc-csc" type="password" inputmode="numeric" data-sensitive maxlength="4" placeholder="CVV" ${prefix==='pay'?'required':''}></div></div><label for="${prefix}-name">Name on card</label><input id="${prefix}-name" name="cc-name" autocomplete="cc-name" data-sensitive required placeholder="Full name"><label for="${prefix}-zip">Billing ZIP / postal code</label><input id="${prefix}-zip" name="postal-code" autocomplete="billing postal-code" data-sensitive required maxlength="20" placeholder="ZIP / postal code"></div>`;}
function cardInput(prefix){return {number:$(`#${prefix}-number`).value,expiration:$(`#${prefix}-expiration`).value,fullName:$(`#${prefix}-name`).value,zip:$(`#${prefix}-zip`).value};}
function applyCard(card,prefix){$(`#${prefix}-number`).value=card.number;$(`#${prefix}-expiration`).value=String(card.month).padStart(2,'0')+' / '+String(card.year).slice(-2);$(`#${prefix}-name`).value=card.fullName;$(`#${prefix}-zip`).value=card.zip;$(`#${prefix}-cvv`).value='';$(`#${prefix}-cvv`).focus();resetInactivity();}
function resetInactivity(){clearTimeout(inactivity);inactivity=setTimeout(()=>{clearSensitive();toast('Card fields cleared after 90 seconds of inactivity.');},90000);}
function cardCaption(record,index){return record.summary?`${record.summary.label} · ${record.summary.brand} •••• ${record.summary.lastFour}`:`Saved card ${index+1}`;}
async function unlockRecord(record,password){
 const result=await decryptCard(record,password);
 // Older encrypted records remain readable; add a masked label after the first unlock.
 if(record.version===1){const upgraded=await encryptCard(result.card,password,result.label,record.id);await storeAction('vault','put',upgraded);await reload();}
 return result;
}
async function checkout(id){
 requireAPI();
 const t=await storeAction('tickets','get',id);
 if(!t||t.demo||t.archived||t.attemptAt||t.status!=='ready')throw Error('This ticket is unavailable for payment.');
 validateQuote(t.quote,true);
 // Fetch processor settings only. The price and transaction ID come from the saved quote.
 const merchant=merchantFrom(await api('customer'));
 const items=await storeAction('vault','getAll');
 sheet('Payment',t.name||'Your ticket',`<div class="summary"><div><small>Ticket ${esc(t.quote.ticketNumber)}</small><strong>${money(t.quote.amountDue)}</strong></div><span class="badge ready">Amount due</span></div><h3 class="group-title">Payment method</h3><div class="payment-options">${items.map((item,index)=>`<button type="button" class="payment-option" data-use-card="${esc(item.id)}"><span>${esc(cardCaption(item,index))}</span><span aria-hidden="true">${icon('chevron-right')}</span></button>`).join('')}<button type="button" id="manual-card" class="payment-option"><span>AutoFill or enter a card</span><span aria-hidden="true">${icon('chevron-right')}</span></button></div><div id="unlock-panel"></div><div id="payment-entry" ${items.length?'hidden':''}><p id="chosen-card" class="small-note">AutoFill or enter a card.</p><form id="pay-form" autocomplete="on">${cardFields('pay')}<p class="small-note">Security code is not saved.</p><label for="pay-confirm"><input id="pay-confirm" type="checkbox" required> Confirm ${money(t.quote.amountDue)} for this ticket.</label><button class="button primary wide" type="submit">Pay ${money(t.quote.amountDue)}</button></form></div><div id="payment-status" class="small-note" role="status"></div>`);
 $('#manual-card').onclick=()=>{clearSensitive();$('#unlock-panel').replaceChildren();$('#payment-entry').hidden=false;$('#pay-confirm').checked=false;$('#chosen-card').textContent='AutoFill or enter a card.';all('[data-use-card]').forEach(x=>x.classList.remove('selected'));$('#manual-card').classList.add('selected');$('#pay-number').focus();resetInactivity();};
 all('[data-use-card]').forEach(button=>button.onclick=()=>{all('.payment-option').forEach(x=>x.classList.toggle('selected',x===button));unlockForCheckout(items.find(item=>item.id===button.dataset.useCard));});
 $('#pay-form').oninput=resetInactivity;
 $('#pay-form').onsubmit=event=>{event.preventDefault();operation(async()=>{const card=validateCard(cardInput('pay')),cvv=validateCVV($('#pay-cvv').value,card.brand);if(!$('#pay-confirm').checked)throw Error('Confirm the ticket and total first.');await submitPayment(t,card,cvv,merchant);});};
 if(!items.length)$('#manual-card').classList.add('selected');resetInactivity();
}
function unlockForCheckout(record){
 clearSensitive();$('#payment-entry').hidden=true;$('#pay-confirm').checked=false;
 const panel=$('#unlock-panel');panel.innerHTML=`<form id="unlock-form"><label for="unlock-password">Passcode</label><input id="unlock-password" type="password" autocomplete="off" data-sensitive required placeholder="Enter your card passcode"><p class="small-note">One passcode unlocks every card saved on this device.</p><button id="unlock-now" type="submit" class="button primary wide">Unlock card</button><p id="unlock-error" class="small-note" role="alert"></p></form>`;
 $('#unlock-password').focus();$('#unlock-form').onsubmit=event=>{event.preventDefault();operation(async()=>{const password=$('#unlock-password').value;$('#unlock-password').value='';try{const result=await unlockRecord(record,password);$('#payment-entry').hidden=false;$('#chosen-card').textContent=`${result.label} · ${result.card.brand} •••• ${result.card.number.slice(-4)}`;applyCard(result.card,'pay');panel.replaceChildren();}catch(e){$('#unlock-error').textContent=e.message;}});};
}
async function submitPayment(ticket,card,cvv,merchant){
 requireAPI();
 if(!navigator.locks)throw Error('Use a browser that can coordinate payments across tabs.');
 await navigator.locks.request('parkingpocket-payment-'+ticket.id,{ifAvailable:true},async lock=>{
  if(!lock)throw Error('This ticket is being processed in another tab.');
  const fresh=await storeAction('tickets','get',ticket.id);if(!fresh||fresh.demo||fresh.archived||fresh.status!=='ready'||fresh.attemptAt)throw Error('This ticket is no longer available for payment.');
  validateQuote(fresh.quote,true);if(fresh.quote.transactionUuid!==ticket.quote.transactionUuid||fresh.quote.amountDue!==ticket.quote.amountDue)throw Error('The quote changed in another tab. Reopen and confirm the updated amount.');
  $('#payment-status').textContent='Protecting card details…';let opaque;
  try{const response=await fetch(PROCESSOR,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(processorPayload(card,cvv,merchant)),credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(45000)});const result=await response.json();if(!response.ok||result.messages?.resultCode!=='Ok'||result.opaqueData?.dataDescriptor!=='COMMON.ACCEPT.INAPP.PAYMENT'||!result.opaqueData?.dataValue)throw Error();opaque=result.opaqueData;}catch{throw Error('Card tokenization failed. No parking payment was submitted. Review the card details before trying again.');}finally{clearSensitive();}
  $('#payment-status').textContent='Registering the payment token…';const registered=await api('tokens',{paymentProvider:'AUTH_NET_LIGHT',transactionUuid:fresh.quote.transactionUuid,providerInstrumentId:opaque.dataValue});if(typeof registered.cardTokenUuid!=='string'||!registered.cardTokenUuid)throw Error('No payment token returned. No parking payment was submitted.');
  const q=fresh.quote,payload={barcodeData:fresh.barcode,totalAmountPaid:q.amountDue,parkingAmount:q.parkingAmountDue,taxes:q.taxes,transactionUuid:q.transactionUuid,paymentProvider:'AUTH_NET_LIGHT',providerInstrumentId:opaque.dataValue,paymentDateTime:new Date().toISOString(),cardTokenUuid:registered.cardTokenUuid,paymentDetails:{brand:card.brand,lastFour:card.number.slice(-4),expirationMonth:card.month,expirationYear:card.year}};
  // Persist before the only charge request. A reload, crash, timeout, or failure stays blocked.
  fresh.status='uncertain';fresh.attemptAt=Date.now();await storeAction('tickets','put',fresh);$('#payment-status').textContent='Submitting payment once…';
  try{const receipt=await api('payments',payload);if(typeof receipt.paymentUuid!=='string'||!receipt.paymentUuid||receipt.amountPaid!==q.amountDue)throw Error('The receipt could not be verified.');fresh.receipt={paymentUuid:receipt.paymentUuid,amountPaid:receipt.amountPaid,paymentDateTime:receipt.paymentDateTime||new Date().toISOString()};fresh.status='paid';fresh.paidAt=Date.now();delete fresh.lastError;await storeAction('tickets','put',fresh);}catch(e){fresh.status='uncertain';fresh.lastError='Payment was attempted but the result requires verification. Check your official receipt and card activity. Do not retry.';await storeAction('tickets','put',fresh);await reload();busy=false;detail(fresh.id);throw Error(fresh.lastError);}
  await reload();busy=false;showQR(fresh);toast('Payment receipt saved.');
 });
}
function renderVault(){const container=$('#vault-body');container.innerHTML=`${vault.length?vault.map((item,index)=>`<div class="vault-card"><div class="saved-card-heading"><span class="card-symbol" aria-hidden="true">${ticketSymbol('ready')}</span><div><h3>${esc(item.summary?.label||'Saved card '+(index+1))}</h3><p>${item.summary?`${esc(item.summary.brand)} · •••• ${esc(item.summary.lastFour)}`:'Unlock once to show the card name.'}</p></div></div><div class="list-actions"><button class="text-button" data-inspect="${esc(item.id)}">Unlock</button><button class="text-button" data-edit-vault="${esc(item.id)}">Edit</button><button class="text-button destructive" data-delete-vault="${esc(item.id)}">Delete</button></div></div>`).join(''):'<div class="empty-state"><p>No saved cards.</p></div>'}<button id="new-vault-card" class="button primary wide">Add card</button><p class="small-note">Cards are encrypted on this device. One passcode protects every card you save; select a card when paying, or edit it to change its details.</p>${vault.length?`<button id="set-vault-passcode" class="text-button">${vaultPasscode?'Change card passcode':'Set one passcode for all cards'}</button>`:''}`;
 $('#new-vault-card').onclick=saveVaultForm;all('[data-delete-vault]').forEach(button=>button.onclick=()=>{if(confirm('Delete this saved card?'))operation(async()=>{await storeAction('vault','delete',button.dataset.deleteVault);await reload();renderVault();});});all('[data-inspect]').forEach(button=>button.onclick=()=>inspectVault(button.dataset.inspect));all('[data-edit-vault]').forEach(button=>button.onclick=()=>editVaultForm(button.dataset.editVault));const passcodeButton=$('#set-vault-passcode');if(passcodeButton)passcodeButton.onclick=()=>setOnePasscode();}
function saveVaultForm(){
 if(vault.length&&!vaultPasscode){toast('Set one passcode for all your cards first.');setOnePasscode();return;}
 const choosing=!vaultPasscode||!vault.length;
 sheet('New payment method','Saved on this device',`<form id="vault-form" autocomplete="on"><label for="vault-label">Card name</label><input id="vault-label" maxlength="60" placeholder="My card" autocomplete="off">${cardFields('vault')}${choosing?`<label for="new-passcode">Choose a passcode</label><input id="new-passcode" type="password" autocomplete="new-password" data-sensitive required minlength="${MIN_PASSCODE}" placeholder="At least ${MIN_PASSCODE} characters"><label for="confirm-passcode">Confirm passcode</label><input id="confirm-passcode" type="password" autocomplete="new-password" data-sensitive required><p class="small-note">One passcode will protect every card you save. It cannot be recovered. Security code is not saved.</p>`:`<label for="vault-passcode">Passcode</label><input id="vault-passcode" type="password" autocomplete="off" data-sensitive required placeholder="Enter your card passcode"><p class="small-note">One passcode protects every card you save. Security code is not saved.</p>`}<button class="button primary wide" type="submit">Save card</button></form>`);$('#vault-cvv').closest('.field-row').querySelector('div:last-child').hidden=true;$('#vault-cvv').value='';
 $('#vault-form').onsubmit=event=>{event.preventDefault();operation(async()=>{
  const password=choosing?$('#new-passcode').value:$('#vault-passcode').value;
  if(choosing){
   if(password.length<MIN_PASSCODE)throw Error(`Choose a passcode of at least ${MIN_PASSCODE} characters.`);
   if(password!==$('#confirm-passcode').value)throw Error('The passcodes do not match.');
  }else if(!(await verifyVaultPasscode(password)))throw Error('That passcode does not match the passcode for your saved cards.');
  const record=await encryptCard(cardInput('vault'),password,$('#vault-label').value);
  if(choosing)await setVaultPasscode(password);
  await storeAction('vault','put',record);
  clearSensitive();await reload();renderVault();busy=false;closeSheet();toast('Card saved.');
 });};
}
function inspectVault(id){
 const record=vault.find(item=>item.id===id);if(!record)return;
 if(!vaultPasscode){toast('Set one passcode for all your cards first.');setOnePasscode();return;}
 sheet('Unlock card','Enter the passcode for your saved cards',`<form id="inspect-form"><label for="inspect-passcode">Passcode</label><input id="inspect-passcode" type="password" autocomplete="off" required data-sensitive><button class="button primary wide">Unlock</button></form><div id="inspect-result" role="status"></div>`);$('#inspect-form').onsubmit=event=>{event.preventDefault();operation(async()=>{const password=$('#inspect-passcode').value;$('#inspect-passcode').value='';$('#inspect-result').replaceChildren();const {card,label}=await unlockRecord(record,password);renderVault();$('#inspect-result').innerHTML=`<div class="notice"><strong>${esc(label)}</strong><br>${esc(card.brand)} · •••• ${esc(card.number.slice(-4))}<br>Expires ${card.month} / ${card.year}</div><button id="inspect-edit" class="button secondary wide">Edit this card</button>`;$('#inspect-edit').onclick=()=>editVaultForm(id);});};}
function editVaultForm(id){
 const record=vault.find(item=>item.id===id);if(!record)return;
 if(!vaultPasscode){toast('Set one passcode for all your cards first.');setOnePasscode();return;}
 sheet('Edit card','Enter your card passcode to make changes',`<form id="edit-unlock-form"><label for="edit-passcode">Passcode</label><input id="edit-passcode" type="password" autocomplete="off" data-sensitive required placeholder="Enter your card passcode"><p class="small-note">One passcode protects every card saved on this device.</p><button class="button primary wide" type="submit">Unlock card</button></form>`);
 $('#edit-passcode').focus();
 $('#edit-unlock-form').onsubmit=event=>{event.preventDefault();operation(async()=>{
  const password=$('#edit-passcode').value;
  const {card}=await unlockRecord(record,password);
  const latest=vault.find(item=>item.id===id)||record;
  sheet('Edit card',latest.summary?`${latest.summary.brand} •••• ${latest.summary.lastFour}`:'Saved on this device',`<form id="edit-card-form" autocomplete="on"><label for="vault-label">Card name</label><input id="vault-label" maxlength="60" autocomplete="off">${cardFields('vault')}<p class="small-note">The security code is never saved. Saving replaces this card's details and keeps the same passcode.</p><button class="button primary wide" type="submit">Save changes</button></form>`);
  $('#vault-label').value=latest.summary?.label||'';
  $('#vault-cvv').closest('.field-row').querySelector('div:last-child').hidden=true;
  applyCard(card,'vault');
  $('#edit-card-form').onsubmit=submit=>{submit.preventDefault();operation(async()=>{
   const updated=await encryptCard(cardInput('vault'),password,$('#vault-label').value,id);
   await storeAction('vault','put',updated);
   clearSensitive();await reload();renderVault();busy=false;closeSheet();toast('Card updated.');
  });};
 });};
}
function setOnePasscode(){
 if(!vault.length){toast('Add a card and choose its passcode.');return;}
 sheet('One card passcode','Use the same passcode for every saved card',`<form id="one-passcode-form" autocomplete="off"><p class="small-note">Choose the passcode for all your cards, then enter each card's current passcode so it can be moved onto the new one. Cards you leave blank keep their old passcode.</p><label for="shared-passcode">Passcode for all cards</label><input id="shared-passcode" type="password" autocomplete="new-password" data-sensitive required minlength="${MIN_PASSCODE}" placeholder="At least ${MIN_PASSCODE} characters"><label for="confirm-shared-passcode">Confirm passcode</label><input id="confirm-shared-passcode" type="password" autocomplete="new-password" data-sensitive required>${vault.map((item,index)=>`<label for="old-${esc(item.id)}">Current passcode for ${esc(item.summary?.label||'saved card '+(index+1))}</label><input id="old-${esc(item.id)}" type="password" autocomplete="off" data-sensitive placeholder="Leave blank to keep this card's old passcode">`).join('')}<button class="button primary wide" type="submit">Save one passcode</button></form>`);
 $('#one-passcode-form').onsubmit=event=>{event.preventDefault();operation(async()=>{
  const password=$('#shared-passcode').value;
  if(password.length<MIN_PASSCODE)throw Error(`Choose a passcode of at least ${MIN_PASSCODE} characters.`);
  if(password!==$('#confirm-shared-passcode').value)throw Error('The passcodes do not match.');
  let moved=0,kept=0,failed=0;
  for(const record of vault){
   const old=$(`#old-${record.id}`)?.value||'';
   if(!old){kept++;continue;}
   if(old===password){moved++;continue;}
   try{const {card,label}=await decryptCard(record,old);await storeAction('vault','put',await encryptCard(card,password,label,record.id));moved++;}
   catch{failed++;}
  }
  await setVaultPasscode(password);
  clearSensitive();await reload();renderVault();busy=false;closeSheet();
  toast(`One passcode saved. ${moved} card${moved===1?'':'s'} moved${kept?`, ${kept} kept an older passcode`:''}${failed?`, ${failed} could not be unlocked`:''}.`);
 });
};
}
function privacy(){sheet('Privacy','Card storage and payments',`<div class="notice">AutoFill is the default. Saving a card in this app is optional.</div><h3>On this device</h3><p class="small-note">Tickets and encrypted vault records live in IndexedDB. One passcode protects every saved card: the app keeps only a sealed check value to confirm it, never the passcode itself. Each card is sealed with AES-256-GCM using a random salt and nonce and a PBKDF2-SHA-256 key derived from that passcode (600,000 iterations). A wrong passcode or modified record fails authentication before any card fields are filled or changed.</p><h3>When you pay</h3><p class="small-note">Card details are sent directly to Authorize.net for tokenization. Your API Worker receives the ticket, payment token, amount, and masked card metadata. CVV is never saved by the app. No card data is put in cookies, URLs, app logs, or backups.</p><h3>What encryption cannot do</h3><p class="small-note">A short PIN can be guessed offline. Malicious JavaScript or a compromised device can read details while you enter or decrypt them. Browser storage may be cleared. This prototype has not undergone a payment security audit.</p>`);}
function connectAPI(){
 if(busy)return;
 sheet('Connect parking API','Enter the access key for your Worker',`
  <form id="api-connect-form" autocomplete="off">
   <label for="api-key">API access key</label>
   <input id="api-key" type="password" autocomplete="off" data-sensitive required>
   <button id="api-submit" class="button primary wide" type="submit">Connect</button>
   <button id="api-cancel" class="button secondary wide" type="button">Cancel</button>
   <p id="api-status" class="small-note" role="status"></p>
  </form>
  <p class="small-note">Your browser remembers the key for this Worker on this device. Use Settings → Forget API key to remove it.</p>
 `);
 $('#api-cancel').onclick=closeSheet;
 $('#api-connect-form').onsubmit=async event=>{
  event.preventDefault();
  if(apiConnection)return;
  $('#sheet-error')?.remove();
  const input=$('#api-key'),submit=$('#api-submit'),status=$('#api-status');
  const key=input.value.trim();
  input.value='';
  submit.disabled=true;
  status.textContent='Checking your API key…';
  const attempt=new AbortController();
  apiConnection=attempt;
  const timeout=setTimeout(()=>attempt.abort(),10000);
  try{
   const remembered=await connectParkingAPI(key,attempt.signal);
   if(apiConnection!==attempt)return;
   apiConnection=null;
   closeSheet();
   toast(remembered?'Parking API connected. Key remembered on this device.':'Parking API connected for this tab. Browser storage is unavailable.');
  }catch(error){
   if(apiConnection===attempt)showError(attempt.signal.aborted?Error('The Worker took too long to respond. Try connecting again.'):error);
  }finally{
   clearTimeout(timeout);
   if(apiConnection===attempt){
    apiConnection=null;
    submit.disabled=false;
    status.textContent='';
   }
  }
 };
}
$('#edit-tickets').onclick=()=>{if(busy)return;editingTickets=!editingTickets;$('#ticket-list').dataset.editing=String(editingTickets);setTicketEditing($('#ticket-list'),editingTickets);$('#edit-tickets').textContent=editingTickets?'Done':'Edit';$('#edit-tickets').setAttribute('aria-pressed',String(editingTickets));};
$('#toolbar-left').onclick=()=>setView(currentView==='tickets'?'vault':'tickets');$('#toolbar-add').onclick=saveVaultForm;$('#settings-shortcut').onclick=()=>setView('settings');
const appearance=$('#appearance');appearance.value=window.ParkingAppearance.get();appearance.onchange=()=>window.ParkingAppearance.set(appearance.value);window.addEventListener('parking-appearance',()=>{appearance.value=window.ParkingAppearance.get();});
$('#close-sheet').onclick=closeSheet;$('#sheet').addEventListener('cancel',event=>{event.preventDefault();closeSheet();});$('#sheet').addEventListener('click',event=>{if(event.target===$('#sheet')){const r=$('#sheet').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeSheet();}});
all('.nav-item').forEach(button=>button.onclick=()=>setView(button.dataset.view));all('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter;all('[data-filter]').forEach(x=>x.classList.toggle('active',x===button));renderTickets();});$('#add-ticket').onclick=addTicket;$('#privacy-button').onclick=privacy;$('#api-connect').onclick=connectAPI;$('#autofill-help').onclick=()=>{sheet('Card AutoFill','Use the cards you already saved',`<div class="notice">Open the card number field at checkout. Choose the card suggestion, or touch and hold → AutoFill → Credit Card if iOS offers it.</div><p class="small-note">The card must be saved for AutoFill in Wallet / Safari settings; Apple Pay enrollment alone may not include the details needed for AutoFill. iOS decides when Face ID is required. Fill any missing fields and review the card before paying.</p><p class="small-note">Prefer a passcode? Add a card to the optional encrypted vault. One passcode protects every card: the app asks for it before filling or editing one. The security code is never stored by this app.</p>`);};
$('#forget-api-key').onclick=()=>operation(async()=>{
 disconnectAPI();
 toast('API key forgotten.');
});
$('#clear-data').onclick=()=>{if(confirm('Erase all local tickets, duplicate-payment safeguards, encrypted cards, the card passcode, and the saved API key? This cannot be undone.'))operation(async()=>{for(const store of ['tickets','vault','preferences'])await storeAction(store,'clear');await reload();renderVault();disconnectAPI();toast('Local data erased.');});};
document.addEventListener('input',event=>{const field=event.target;if(field instanceof HTMLInputElement&&field.id.endsWith('-expiration')&&event.isTrusted){const digits=field.value.replace(/[^0-9]/g,'').slice(0,6);field.value=digits.length>2?digits.slice(0,2)+' / '+digits.slice(2):digits;}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearSensitive();stopScan();}});window.addEventListener('pagehide',()=>{clearSensitive();stopScan();});
window.addEventListener('unhandledrejection',event=>{event.preventDefault();toast('The operation could not finish. If a payment was submitted, verify it before retrying.');});
async function boot(){try{await reload();}catch(e){$('#ticket-list').innerHTML='<div class="empty-state">Local storage is unavailable. Enable browser storage and reload. No payment can be made.</div>';showError(e);}}
// Keep scrolling and ticket swipes while suppressing multi-touch zoom.
for(const type of ['gesturestart','gesturechange']){
 document.addEventListener(type,event=>event.preventDefault(),{passive:false});
}
for(const type of ['touchstart','touchmove']){
 document.addEventListener(type,event=>{
  if(event.touches.length>1)event.preventDefault();
 },{passive:false});
}
hydrateIcons();
void boot();
})();
