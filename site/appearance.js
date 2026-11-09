// Apply appearance before the stylesheet loads, including standalone / home-screen mode.
(function(){
 const key='parkingpocket-appearance',allowed=['system','light','dark'];
 let choice='system';try{const stored=localStorage.getItem(key);if(allowed.includes(stored))choice=stored;}catch{}
 const media=matchMedia('(prefers-color-scheme: dark)');
 function apply(){const theme=choice==='system'?(media.matches?'dark':'light'):choice;document.documentElement.dataset.theme=theme;const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=theme==='dark'?'#000000':'#f2f2f7';window.dispatchEvent(new CustomEvent('parking-appearance',{detail:{choice,theme}}));}
 window.ParkingAppearance={get:()=>choice,set(value){if(!allowed.includes(value))return;choice=value;try{localStorage.setItem(key,choice);}catch{}apply();}};
 media.addEventListener('change',()=>{if(choice==='system')apply();});
 window.addEventListener('storage',event=>{if(event.key===key){choice=allowed.includes(event.newValue)?event.newValue:'system';apply();}});
 apply();
})();
