// Three fixed public queries keep cache cardinality bounded and prevent callers
// from turning this endpoint into a generic TradingView proxy.
export const COLUMNS = ["name","description","close","SMA50","SMA150","SMA200","price_52_week_high","price_52_week_low","Perf.Y","earnings_per_share_diluted_yoy_growth_fq","earnings_per_share_diluted_qoq_growth_fq","total_revenue_qoq_growth_fq","total_revenue_yoy_growth_fq","return_on_equity_fq","net_margin","sector","market_cap_basic","volume","exchange","average_volume_10d_calc","earnings_release_next_date","Volatility.D","Volatility.M","Perf.3M","Perf.6M","EMA10","EMA20","Perf.W","average_volume_30d_calc","average_volume_90d_calc","earnings_per_share_diluted_ttm","earnings_per_share_forecast_next_fy","net_margin_fy","ADR"];
const COMMODITIES = ["GLD","SLV","COPX","WEAT","CORN","UNG","PALL","PPLT","UGA","USO","CANE","URA"];
function stable(value:unknown):string {
  if(Array.isArray(value)) return '['+value.map(stable).join(',')+']';
  if(value && typeof value==='object') return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
  const encoded=JSON.stringify(value);
  if(encoded===undefined) throw Error('unsupported scan query');
  return encoded;
}
function equity(type:string,primary:boolean){return {columns:COLUMNS,filter:[{left:'type',operation:'equal',right:type},...(primary?[{left:'is_primary',operation:'equal',right:true}]:[]),{left:'close',operation:'egreater',right:2},{left:'market_cap_basic',operation:'egreater',right:50000000},{left:'exchange',operation:'in_range',right:['AMEX','NASDAQ','NYSE']}],markets:['america'],sort:{sortBy:'market_cap_basic',sortOrder:'desc'},range:[0,8000]};}
const QUERIES={stocks:equity('stock',true),adrs:equity('dr',false),commodities:{columns:COLUMNS,filter:[{left:'name',operation:'in_range',right:COMMODITIES}],markets:['america'],range:[0,20]}};
function signature(body:unknown):string {
  if(!body || typeof body!=='object' || Array.isArray(body)) throw Error('unsupported scan query');
  const b=body as Record<string,unknown>;
  if(!Array.isArray(b.filter)) throw Error('unsupported scan query');
  return stable({...b,filter:[...b.filter].sort((a,b)=>stable(a).localeCompare(stable(b)))});
}
export function normalizeScanRequest(body:unknown){
  const sig=signature(body);
  for(const [kind,query] of Object.entries(QUERIES)) if(sig===signature(query)) return {key:'scan:v2:'+kind,body:query};
  throw Error('unsupported scan query');
}
export async function readScanRequest(req:Request,maxBytes=16384){
  if(Number(req.headers.get('content-length'))>maxBytes) throw new RangeError('request too large');
  const reader=req.body?.getReader(); if(!reader) throw Error('invalid JSON');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw new RangeError('request too large');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  return normalizeScanRequest(JSON.parse(new TextDecoder().decode(bytes)));
}
export function trimMap<T>(map:Map<string,T>,limit:number){while(map.size>limit)map.delete(map.keys().next().value!);}
