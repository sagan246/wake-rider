import { SHARED_LAKE_RULES } from '../simulation/defaults.js?v=28';
import { createPeerMotion } from './peer-motion.js';
import { IDLE_MESSAGE } from './inactivity.js';

const COLORS_FALLBACK='#62dcff';
const pose=b=>({x:b.x,y:b.y,vx:b.vx,vy:b.vy,angle:b.angle,z:b.z,pitch:b.pitch,roll:b.roll,riderOn:b.riderOn});
export function createLakeClient({read,onSpawn,onCorrection,onStatus,onWakes,onIdle,checkIdle=()=>false,fetcher=fetch,clock=()=>performance.now()}){
  let generation=0,session=null,timer=null,abort=null,joined=false,ready=false,resetWanted=false,resetRevision=0,seq=0,ack=0,lastSuccess=0;
  let status='Solo · Open Water',self=null,peers=createPeerMotion(),count=0,botCount=0;
  let wakeCursor=0;
  let waitingForSpace=false;
  function report(message){status=message;onStatus?.({message,ready,count,botCount,self});}
  function snapshot(data,started){
    const now=clock();
    peers.receive(data.players,{selfId:session.id,serverTime:data.serverTime,now,rtt:now-started});
    count=data.players.length;botCount=data.players.filter(p=>p.isBot).length;self=data.self;
  }
  async function request(input,signal){
    const response=await fetcher('/api/lake',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal,cache:'no-store'});
    const data=await response.json();
    if(!response.ok)throw Object.assign(new Error(data.error||'Reconnecting to the lake…'),{status:response.status,code:data.code});
    return data;
  }
  async function poll(run){
    if(run!==generation||!session||checkIdle())return;
    const started=clock(),state=read(),action=!joined?'join':resetWanted?'reset':'sync',sentReset=resetRevision;
    const sent={...session,action,physicsVersion:SHARED_LAKE_RULES.version,seq:++seq,ack,wakeSince:wakeCursor,name:state.name,botCount:state.botCount||0,fillBotsRequest:state.fillBotsRequest,paused:state.paused,activitySeq:state.activitySeq,boat:pose(state.boat),tube:pose(state.tube),wakeSamples:state.wakeSamples||[]};
    const controller=new AbortController();abort=controller;const timeout=setTimeout(()=>controller.abort(),4500);
    let delay=200;
    try{
      const data=await request(sent,abort.signal);
      if(run!==generation||checkIdle())return;
      waitingForSpace=false;
      snapshot(data,started);
      if(action==='join'||action==='reset'){
        joined=true;resetWanted=sentReset!==resetRevision;
        onSpawn(data.self.spawn);
      }
      onWakes?.(data.wakeEvents||[],data.serverTime,{source:data.self.wakeSource,ack:data.self.wakeAck||0});
      if(Number.isSafeInteger(data.wakeCursor))wakeCursor=data.wakeCursor;
      const event=data.self.correction;
      if(event&&event.seq>ack){onCorrection(event);ack=event.seq;}
      ready=!resetWanted;lastSuccess=clock();
      const humans=count-botCount;
      report(`${humans} player${humans===1?'':'s'}${botCount?` + ${botCount} bot${botCount===1?'':'s'}`:''} · ${self.name}`);
      delay=Math.max(0,200-(clock()-started)); // 5 Hz start-to-start, one request in flight.
    }catch(error){
      if(run!==generation)return;
      if(error.code==='idle'){leave();report(IDLE_MESSAGE);onIdle?.();return;}
      ready=false;delay=1000;
      waitingForSpace=error.code==='room_full';
      if(waitingForSpace){joined=false;ack=0;wakeCursor=0;peers.clear();}
      else if(error.status===410){joined=false;ack=0;peers.clear();}
      else if(error.status===409&&joined)resetWanted=true;
      report(error.status?error.message:'Connection interrupted · reconnecting…');
    }finally{
      clearTimeout(timeout);
      if(run===generation){abort=null;timer=setTimeout(()=>poll(run),delay);}
    }
  }
  function leave(){
    const old=session;
    generation++;clearTimeout(timer);abort?.abort();abort=null;session=null;joined=false;ready=false;peers.clear();count=0;botCount=0;self=null;wakeCursor=0;
    waitingForSpace=false;
    if(old)fetcher('/api/lake',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...old,action:'leave'}),keepalive:true}).catch(()=>{});
  }
  function setMap(id){
    leave();
    if(id!=='oswego'){report('Solo · Open Water');return;}
    session={id:crypto.randomUUID(),token:crypto.randomUUID()+crypto.randomUUID()};
    seq=0;ack=0;resetWanted=false;resetRevision=0;lastSuccess=0;
    report('Joining the shared lake…');void poll(generation);
  }
  function reset(){if(!session||waitingForSpace)return;resetRevision++;resetWanted=true;ready=false;report('Finding a clear starting spot…');}
  function getPeers(){
    return peers.get(clock());
  }
  return {setMap,leave,reset,getPeers,get self(){return self;},get ready(){return ready&&clock()-lastSuccess<3000;},get status(){return status;},get color(){return self?.color||COLORS_FALLBACK;}};
}
