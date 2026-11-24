import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {PoolClient} from 'pg';
import {archiveResource} from '../apps/api/src/modules/configuration/archive.js';

for (const blocker of ['sessions','tickets','payments']) {
  test('archive refuses '+blocker+' without writing',async()=>{
    const replies=[{name:'Haircut'},{[blocker]:true}];
    const client={query:async()=>{assert.ok(replies.length);return {rows:[replies.shift()]};}} as unknown as PoolClient;
    await assert.rejects(archiveResource(client,'business','service','owner','Haircut'),{status:409,code:'ARCHIVE_BLOCKED'});
    assert.equal(replies.length,0);
  });
}
test('stale confirmation fails before archiving',async()=>{
  const client={query:async()=>({rows:[{name:'Renamed'}]})} as unknown as PoolClient;
  await assert.rejects(archiveResource(client,'business',null,'owner','Original'),{status:409,code:'NAME_MISMATCH'});
});
