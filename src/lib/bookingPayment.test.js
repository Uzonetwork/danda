import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAmountDue, validatePaymentSettings } from './bookingPayment.js';

test('pay_at_venue has no amount due', () => {
  assert.equal(computeAmountDue({ price: 50000, payment_mode: 'pay_at_venue' }), null);
});

test('full charges the whole price', () => {
  assert.deepEqual(computeAmountDue({ price: 50000, payment_mode: 'full' }), { dueNow: 50000, balance: 0 });
});

test('fixed deposit', () => {
  const svc = { price: 50000, payment_mode: 'deposit', deposit_type: 'fixed', deposit_value: 15000 };
  assert.deepEqual(computeAmountDue(svc), { dueNow: 15000, balance: 35000 });
});

test('percent deposit rounds to whole naira', () => {
  const svc = { price: 33333, payment_mode: 'deposit', deposit_type: 'percent', deposit_value: 30 };
  assert.deepEqual(computeAmountDue(svc), { dueNow: 10000, balance: 23333 });
});

test('invalid deposits are rejected', () => {
  assert.equal(computeAmountDue({ price: 5000, payment_mode: 'deposit', deposit_type: 'fixed', deposit_value: 9000 }), null);
  assert.equal(computeAmountDue({ price: 5000, payment_mode: 'deposit', deposit_type: 'percent', deposit_value: 101 }), null);
});

test('validation enforces the ₦1,000 floor', () => {
  assert.match(validatePaymentSettings({ payment_mode: 'deposit', deposit_type: 'fixed', deposit_value: 500 }, 20000), /at least/);
  assert.equal(validatePaymentSettings({ payment_mode: 'deposit', deposit_type: 'percent', deposit_value: 10 }, 20000), null);
  assert.match(validatePaymentSettings({ payment_mode: 'full' }, 800), /at least/);
  assert.equal(validatePaymentSettings({ payment_mode: 'pay_at_venue' }, 0), null);
});
