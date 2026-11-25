import assert from 'node:assert/strict';
import { test } from 'node:test';
import { internshipRecommendationExclusion as exclude } from './compensation.ts';
const posting = (description: string, location = 'Bengaluru') => ({ title: 'Backend Intern', description, location });
test('unpaid internships are excluded even if remote', () => {
  assert.equal(exclude(posting('₹0/month', 'Fully remote')), 'unpaid');
  assert.equal(exclude(posting('Stipend: none', 'Fully remote')), 'unpaid');
  assert.equal(exclude({title:'Unpaid Backend Intern', location:'Remote'}), 'unpaid');
});
test('explicit paid monthly INR below the floor requires fully remote work', () => {
  assert.equal(exclude(posting('Stipend: ₹30,000 per month', 'Hybrid')), 'below-minimum');
  assert.equal(exclude(posting('Stipend: INR 30–45k/month')), 'below-minimum');
  assert.equal(exclude(posting('Stipend: ₹30,000–45k/month')), 'below-minimum');
  assert.equal(exclude(posting('Stipend: ₹25k/month', 'Remote (India)')), null);
  assert.equal(exclude(posting('₹25k/month; hybrid with office days', 'Remote')), 'below-minimum');
  assert.equal(exclude(posting('₹40,000/month')), null);
});
test('missing pay, other currencies and unclear periods are not treated as below floor', () => {
  for (const text of ['Competitive stipend', '$30,000 per month', '₹30,000 for the entire term', 'Paid internship; unpaid leave not offered']) assert.equal(exclude(posting(text)), null);
});
