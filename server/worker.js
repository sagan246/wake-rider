import { assets } from './assets.generated.js';
import { handleLake } from './lake.js';
export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    const realtime=env.LAKE_REALTIME_URL;
    if(path==='/api/lake-config'){
      const websocketUrl=realtime?new URL('/lake',realtime).href.replace(/^http/,'ws'):null;
      return Response.json({websocketUrl},{headers:{'Cache-Control':'no-store'}});
    }
    if(path==='/api/lake'){
      // Old game tabs must share the WebSocket players' room, not the D1 room.
      if(realtime)return fetch(new Request(new URL('/api/lake',realtime),request));
      return handleLake(request,env.DB);
    }
    if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
    const asset=assets[path==='/'?'/index.html':path];
    if(!asset)return new Response('Not found',{status:404});
    return new Response(request.method==='HEAD'?null:asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});
  }
};
