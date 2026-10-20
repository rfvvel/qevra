import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rootCertificates} from 'node:tls';
import pg from 'pg';
import {databaseOptions} from '../apps/api/src/config/database.js';
import {createDatabaseFailureLogger, databaseDiagnostic} from '../apps/api/src/db/diagnostics.js';

test('database diagnostics classify connection errors without their messages', () => {
  for (const [code, category] of [
    ['SELF_SIGNED_CERT_IN_CHAIN','tls_certificate'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE','tls_certificate'],
    ['ERR_TLS_CERT_ALTNAME_INVALID','tls_hostname'],
    ['ENOTFOUND','dns'], ['EAI_AGAIN','dns'], ['ECONNREFUSED','network'],
    ['ETIMEDOUT','timeout'], ['28P01','authentication'], ['28000','authentication'],
    ['53300','postgresql'], ['P0001','postgresql'], ['DATABASE_NOT_CONFIGURED','configuration'],
  ]) assert.deepEqual(databaseDiagnostic({code, message:'private'}), {category,code});
  assert.deepEqual(databaseDiagnostic(new Error('Query read timeout')), {category:'timeout'});
  assert.deepEqual(databaseDiagnostic(new Error('Connection terminated due to connection timeout')), {category:'timeout'});
  assert.deepEqual(databaseDiagnostic(new Error('timeout exceeded when trying to connect')), {category:'timeout'});
});

test('nested/aggregate errors and cycles are bounded; unknown details stay private', () => {
  assert.deepEqual(databaseDiagnostic(new Error('wrapper', {cause:{code:'ENOTFOUND'}})), {category:'dns',code:'ENOTFOUND'});
  assert.deepEqual(databaseDiagnostic(new AggregateError([{code:'ECONNREFUSED'}])), {category:'network',code:'ECONNREFUSED'});
  const cyclic: {cause?: unknown} = {};
  cyclic.cause = cyclic;
  assert.deepEqual(databaseDiagnostic(cyclic), {category:'unknown'});
  assert.deepEqual(databaseDiagnostic({code:'secret://credential',message:'private'}), {category:'unknown'});
  assert.deepEqual(databaseDiagnostic(null), {category:'unknown'});
});

test('logger outputs only safe fields, throttles repeats and immediately logs changed categories', () => {
  const lines: string[] = [];
  let now = 0;
  const log = createDatabaseFailureLogger(line => lines.push(line), () => now);
  const failure = {code:'ENOTFOUND',message:'postgresql://private:password@private-host/db',
    stack:'private stack',detail:'private customer',parameters:['private'],hostname:'private'};
  log('health', failure);
  log('health', failure);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {event:'database_operation_failed',source:'health',category:'dns',code:'ENOTFOUND'});
  log('worker', failure);
  log('health', {code:'ETIMEDOUT'});
  now = 60_000;
  log('health', {code:'ETIMEDOUT'});
  assert.equal(lines.length, 4);
  assert.ok(!lines.join('').includes('private'));
  assert.ok(!lines.join('').includes('password'));
});

test('installed pg preserves explicit production TLS and encoded Session Pooler identity offline', () => {
  for (const ca of [undefined, rootCertificates[0], rootCertificates[0].replace(/\n/g,'\\n')]) {
    const options = databaseOptions({NODE_ENV:'production',
      DATABASE_URL:'postgresql://postgres.example:p%40ss%3Aword@pooler.example.test:5432/postgres?sslmode=verify-full',
      DATABASE_CA_CERT:ca});
    // Construction parses options only; no connect/query/network calls.
    const client = new pg.Client(options);
    assert.equal(client.host, 'pooler.example.test');
    assert.equal(client.user, 'postgres.example');
    assert.equal(client.password, 'p@ss:word');
    assert.equal(client.port, 5432);
    assert.deepEqual(client.ssl, {rejectUnauthorized:true,...(ca ? {ca:rootCertificates[0].trim()} : {})});
    assert.ok(!options.connectionString?.includes('sslmode'));
  }
});
