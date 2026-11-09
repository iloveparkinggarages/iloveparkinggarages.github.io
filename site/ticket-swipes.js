window.ParkingSwipes = (() => {
'use strict';
// Use the browser's native horizontal scrolling and scroll snapping for touch gestures.
// No touchmove interception: vertical page scrolling and Safari edge gestures stay native.
function closeTicketSwipes(root){
 for(const lane of root.querySelectorAll('.ticket-swipe'))lane.scrollTo({left:0,behavior:'auto'});
}
function setTicketEditing(root,editing){
 for(const lane of root.querySelectorAll('.ticket-swipe')){
  lane.classList.toggle('editing',editing);
  const button=lane.querySelector('.ticket-swipe-delete');
  // Editing also provides a visible, keyboard-accessible alternative to swiping.
  button.inert=!editing;
  lane.scrollTo({left:editing?lane.scrollWidth:0,behavior:'auto'});
 }
}
function wireTicketSwipes(root){
 const lanes=[...root.querySelectorAll('.ticket-swipe')];
 for(const lane of lanes){
  const button=lane.querySelector('.ticket-swipe-delete');
  const update=()=>{button.inert=!lane.classList.contains('editing')&&lane.scrollLeft<20;};
  lane.addEventListener('scroll',update,{passive:true});
  lane.addEventListener('pointerdown',()=>{
   if(root.dataset.editing==='true')return;
   for(const other of lanes)if(other!==lane&&other.scrollLeft>0)other.scrollTo({left:0,behavior:'auto'});
  },{passive:true});
  lane.addEventListener('keydown',event=>{
   if(event.key==='Escape'){lane.scrollTo({left:0,behavior:'auto'});button.inert=true;lane.querySelector('.ticket-row').focus();}
  });
  update();
 }
}
return { wireTicketSwipes, setTicketEditing, closeTicketSwipes };
})();
