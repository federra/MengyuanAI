// Decorative artwork has no relationship to generated media or model output.
const artwork=[
'<rect width="480" height="90" fill="#203d50"/><path d="M0 90L170 0H300L130 90Z" fill="#52778a" opacity=".4"/><path d="M320 0v90M334 0v90M348 0v90M362 0v90" stroke="#cedecc" opacity=".18"/><circle cx="370" cy="26" r="42" fill="#d5decd" opacity=".8"/><path d="M0 74Q155 48 280 79T480 68V90H0Z" fill="#162e3f"/>',
'<rect width="480" height="90" fill="#32443d"/><path d="M0 0H240L150 90H0Z" fill="#6b8576" opacity=".45"/><rect x="300" y="15" width="90" height="70" rx="2" fill="#bac8ac" transform="rotate(-12 345 50)"/><path d="M310 41l65-14M313 50l65-14M316 59l41-9" stroke="#596e5c" opacity=".6"/><circle cx="150" cy="98" r="60" stroke="#e0e5d4" fill="none" opacity=".2"/>',
'<rect width="480" height="90" fill="#57483f"/><circle cx="300" cy="30" r="58" fill="#d6b589" opacity=".65"/><path d="M0 73L155 37L290 90H0Z" fill="#2e393e"/><path d="M233 90L362 0h29L270 90Z" fill="#e5d5b4" opacity=".22"/><path d="M400 0v90M412 0v90M424 0v90" stroke="#e5d5b4" opacity=".14"/>'
];
let motionContext,seen=new Set(),first=true;
export function polishStudio(){
  motionContext?.revert();document.querySelectorAll('.story-art').forEach((el,i)=>{el.innerHTML=`<svg viewBox="0 0 480 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${artwork[i%3]}</svg>`});
  document.querySelectorAll('.topic-card').forEach((card,i)=>{
    const art=document.createElement('span');art.className='topic-art';art.setAttribute('aria-hidden','true');art.innerHTML=`<svg viewBox="0 0 480 90" preserveAspectRatio="xMidYMid slice" focusable="false">${artwork[i%artwork.length]}</svg>`;card.prepend(art);
    card.classList.toggle('is-selected',card.querySelector('.card-tail')?.textContent.includes('已选定'));
  });
  const gsap=window.gsap,ST=window.ScrollTrigger;if(!gsap||!ST||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  gsap.registerPlugin(ST);
  motionContext=gsap.context(()=>{
    gsap.from('.page-heading p',{opacity:.55,duration:.5,scrollTrigger:{trigger:'.page-heading',start:'top 85%',end:'bottom 20%',scrub:true}});if(first){gsap.from('.studio .page-heading',{y:8,opacity:.6,duration:.4,clearProps:'transform,opacity'});first=false;}
    document.querySelectorAll('.story-choice,.project-card,.asset-card,.settings-card').forEach((card,i)=>{
      const key=card.textContent;if(seen.has(key))return;seen.add(key);
      gsap.from(card,{y:14,rotationX:2,opacity:.65,duration:.48,delay:(i%3)*.045,ease:'power2.out',clearProps:'transform,opacity',scrollTrigger:{trigger:card,start:'top 98%',once:true}});
      if(card.querySelector('.story-art,.project-cover,img'))gsap.from(card.querySelector('.story-art,.project-cover,img'),{scale:.96,opacity:.7,duration:.65,clearProps:'transform,opacity',scrollTrigger:{trigger:card,start:'top 98%',once:true}});
    });
  });
}
