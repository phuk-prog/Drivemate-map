// Identifies original OSM junction=roundabout road ways within a vector-tile
// derived routable graph. Requires 4/5 positional+directional samples to agree;
// never marks a road merely because its curve happens to resemble a circle.
// This writes a reserved *flag bit*, not a guessed exit count.
export const FLAG_ROUNDABOUT=32;
const CELL=6000;
const MAX_DISTANCE=800; // fixed7 units: approximately 9 m latitude
const COS=Math.cos(Math.PI/4);
function key(i,j){return i+','+j;}
function near(sample,a,b) {
 const scale=Math.max(.3,Math.cos(sample.p[0]*1e-7*Math.PI/180));
 const dx=(b[0]-a[0]),dy=(b[1]-a[1])*scale;
 const ex=sample.d[0],ey=sample.d[1]*scale;
 const denom=Math.hypot(dx,dy)*Math.hypot(ex,ey);
 if(denom===0||Math.abs((dx*ex+dy*ey)/denom)<COS)return false;
 const lat=a[0],lon=a[1]*scale,x=sample.p[0],y=sample.p[1]*scale;
 const l2=dx*dx+dy*dy;
 const t=Math.max(0,Math.min(1,((x-lat)*dx+(y-lon)*dy)/l2));
 return Math.hypot(x-(lat+t*dx),y-(lon+t*dy))<=MAX_DISTANCE;
}
function sample(points,f){
 if(points.length<2)return null;
 const q=f*(points.length-1),i=Math.min(points.length-2,Math.floor(q)),t=q-i;
 const a=points[i],b=points[i+1];
 return {p:[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])],d:[b[0]-a[0],b[1]-a[1]]};
}
export function markRoundaboutEdges(edges,ways) {
 const grid=new Map(),segments=[];
 for(const way of ways||[]){
  for(let i=1;i<(way.geom||[]).length;i++){
   const a=way.geom[i-1],b=way.geom[i];
   if(!a||!b)continue;
   const index=segments.length;
   segments.push([a,b]);
   for(let x=Math.floor(Math.min(a[0],b[0])/CELL);x<=Math.floor(Math.max(a[0],b[0])/CELL);x++){
    for(let y=Math.floor(Math.min(a[1],b[1])/CELL);y<=Math.floor(Math.max(a[1],b[1])/CELL);y++){
     const k=key(x,y),entry=grid.get(k)||[];entry.push(index);grid.set(k,entry);
    }
   }
  }
 }
 let marked=0,skipped=0;
 for(const edge of edges||[]){
  if((edge.flags&16)||!edge.points||edge.points.length<2){skipped++;continue;}
  if(edge.flags&FLAG_ROUNDABOUT){marked++;continue;}
  let matched=0;
  for(const f of [.1,.3,.5,.7,.9]){
   const s=sample(edge.points,f);
   if(!s)continue;
   const ci=Math.floor(s.p[0]/CELL),cj=Math.floor(s.p[1]/CELL);
   let found=false;
   for(let di=-1;di<=1&&!found;di++)for(let dj=-1;dj<=1&&!found;dj++){
    for(const id of grid.get(key(ci+di,cj+dj))||[]){
     if(near(s,...segments[id])){found=true;break;}
    }
   }
   if(found)matched++;
  }
  if(matched>=4){edge.flags|=FLAG_ROUNDABOUT;marked++;}
  else skipped++;
 }
 return {marked,skipped,sourceWays:(ways||[]).length};
}
