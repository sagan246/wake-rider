// Independent seeds vary both the driving style and its small individual
// preferences. Adding a numbered bot must not make the whole fleet synchronize.
export function botRandom(id,salt=''){
  let seed=0;for(const char of `${id}:${salt}`)seed=(Math.imul(seed,31)+char.charCodeAt(0))>>>0;
  seed=Math.imul(seed^(seed>>>16),0x7feb352d);
  seed=Math.imul(seed^(seed>>>15),0x846ca68b);
  return ((seed^(seed>>>16))>>>0)/4294967296;
}
export const BOT_STYLES=[
  {name:'Cruiser',speed:7.2,weave:7,period:23,spinDelay:135},
  {name:'Explorer',speed:9.4,weave:9,period:21,spinDelay:105},
  {name:'Carver',speed:8.4,weave:22,period:16,spinDelay:85},
  {name:'Spinner',speed:7.8,weave:13,period:18,spinDelay:45},
  {name:'Wanderer',speed:8.7,weave:16,period:20,spinDelay:110}
];
export function botPersonality(p){
  if(p.driver)return p.driver;
  const index=Number.isInteger(p.driverIndex)?(p.driverIndex+Math.floor(p.driverIndex/5))%BOT_STYLES.length:Math.floor(botRandom(p.id,'style')*BOT_STYLES.length);
  const style=BOT_STYLES[index];
  p.rideSeed=botRandom(p.id,'ride');
  p.driver={...style,speed:style.speed+botRandom(p.id,'speed')*.7,
    weave:style.weave*(.85+botRandom(p.id,'weave')*.3),period:style.period+botRandom(p.id,'period')*4,
    spinDelay:style.spinDelay*(.8+botRandom(p.id,'spin')*.4),phase:botRandom(p.id,'phase')*Math.PI*2};
  if(p.name?.startsWith('Bot '))p.name=`Bot ${style.name} ${p.name.slice(4)}`;
  return p.driver;
}
