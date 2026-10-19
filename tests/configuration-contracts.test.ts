import assert from 'node:assert/strict';
import { test } from 'node:test';
import { businessCreateSchema, businessPatchSchema, branchCreateSchema, branchPatchSchema, serviceCreateSchema, servicePatchSchema, counterPatchSchema, assignmentsSchema, memberCreateSchema } from '@qevra/contracts';
const valid = { name: 'Haircut', price_amount: '80000', estimated_duration_minutes: 30, queue_prefix: 'A', payment_mode: 'NONE', deposit_amount: null };
test('money contracts preserve bigint amounts without rounding', () => {
  const result = serviceCreateSchema.parse({ ...valid, price_amount: '9007199254740993' });
  assert.equal(result.price_amount, '9007199254740993');
  for (const price_amount of [-1, 1.5, '1.5', '-1', '01', '9223372036854775808', 'not-money']) assert.equal(serviceCreateSchema.safeParse({ ...valid, price_amount }).success, false);
});
test('payment configuration accepts valid NONE, DEPOSIT and FULL modes', () => {
  assert.ok(serviceCreateSchema.safeParse(valid).success);
  assert.ok(serviceCreateSchema.safeParse({ ...valid, payment_mode: 'DEPOSIT', deposit_amount: '10000' }).success);
  assert.ok(serviceCreateSchema.safeParse({ ...valid, payment_mode: 'FULL' }).success);
});
test('invalid deposits and full-price combinations are rejected', () => {
  for (const patch of [
    { deposit_amount: '1' }, { payment_mode: 'FULL', price_amount: '0' },
    { payment_mode: 'FULL', deposit_amount: '1' }, { payment_mode: 'DEPOSIT', deposit_amount: null },
    { payment_mode: 'DEPOSIT', deposit_amount: '0' }, { payment_mode: 'DEPOSIT', deposit_amount: '80001' },
  ]) assert.equal(serviceCreateSchema.safeParse({ ...valid, ...patch }).success, false);
});
test('PATCH does not inject create defaults or accept empty updates', () => {
  for (const schema of [businessPatchSchema, branchPatchSchema, servicePatchSchema, counterPatchSchema]) {
    assert.deepEqual(schema.parse({ name: 'Updated' }), { name: 'Updated' });
    assert.equal(schema.safeParse({}).success, false);
  }
});
test('names, slugs, timezones and service units are validated', () => {
  assert.equal(businessCreateSchema.safeParse({ name: ' ', slug: 'valid' }).success, false);
  assert.equal(businessCreateSchema.safeParse({ name: 'A', slug: 'Bad Slug' }).success, false);
  assert.equal(branchCreateSchema.safeParse({ name: 'A', public_slug: 'valid', timezone: 'Made/Up' }).success, false);
  for (const patch of [{ currency: 'USD' }, { estimated_duration_minutes: 0 }, { estimated_duration_minutes: 1.5 }, { queue_prefix: 'lowercase' }]) assert.equal(serviceCreateSchema.safeParse({ ...valid, ...patch }).success, false);
});
test('request schemas reject role injection and invalid assignments', () => {
  assert.equal(businessCreateSchema.safeParse({ name: 'A', slug: 'valid', role: 'OWNER' }).success, false);
  assert.equal(memberCreateSchema.safeParse({ user_id: 'not-a-uuid', role: 'ADMIN' }).success, false);
  const uuid = '00000000-0000-4000-8000-000000000001';
  assert.equal(assignmentsSchema.safeParse({ branch_ids: [uuid, uuid], service_ids: [] }).success, false);
});
