/* X owns its palette; utility surfaces follow its actual background. No private data. */
(()=>{const root=document.documentElement;let frame=0;
 function update(){frame=0;const color=getComputedStyle(document.body||root).backgroundColor,parts=color.match(/[\d.]+/g)||[],[r,g,b,a]=parts.map(Number);if(parts.length<3||a===0)return;root.dataset.xvTheme=(r*.2126+g*.7152+b*.0722)>150?'light':'dark'}
 const schedule=()=>{if(!frame)frame=requestAnimationFrame(update)};
 const observer=new MutationObserver(schedule);observer.observe(root,{attributes:true,attributeFilter:['class','style']});
 function mount(){if(document.body)observer.observe(document.body,{attributes:true,attributeFilter:['class','style']});schedule()}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();matchMedia('(prefers-color-scheme:dark)').addEventListener('change',schedule);
})();
