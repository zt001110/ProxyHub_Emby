import {connect} from 'cloudflare:sockets';
import {serveEmbySubscription} from './core.js';
export default {fetch(request,env,ctx){if(new URL(request.url).pathname==='/health')return Response.json({service:'emby-subscription',ready:!!(env.DB&&env.EMBY_SUB_TOKEN&&env.EMBY_TROJAN_HASH)});return serveEmbySubscription(request,{...env,SOCKET_CONNECT:connect},ctx)}};
