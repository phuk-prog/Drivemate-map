import test from 'node:test';
import assert from 'node:assert/strict';
import {markRoundaboutEdges,FLAG_ROUNDABOUT} from './roundabouts.mjs';
const rb={geom:[[530000000,-20000000],[530001000,-20000000],[530001800,-19999800]]};
test('roundabout flag is attached to a matching source way only',()=>{
 const on={flags:1,points:rb.geom.map(x=>[...x])};
 const aside={flags:1,points:rb.geom.map(([lat,lon])=>[lat+1800,lon])};
 const cross={flags:1,points:[[530001000,-20000400],[530001000,-19999700]]};
 const result=markRoundaboutEdges([on,aside,cross],[rb]);
 assert.equal(result.marked,1);
 assert.equal(on.flags&FLAG_ROUNDABOUT,FLAG_ROUNDABOUT);
 assert.equal(aside.flags&FLAG_ROUNDABOUT,0);
 assert.equal(cross.flags&FLAG_ROUNDABOUT,0);
});
test('no OSM metadata means old flags are untouched',()=>{
 const edge={flags:3,points:rb.geom.map(x=>[...x])};
 assert.equal(markRoundaboutEdges([edge],[]).marked,0);
 assert.equal(edge.flags,3);
});
test('car-inaccessible roads are never tagged as a drivable circle',()=>{
 const edge={flags:16,points:rb.geom.map(x=>[...x])};
 assert.equal(markRoundaboutEdges([edge],[rb]).marked,0);
});
