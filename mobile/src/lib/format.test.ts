import { money, venueTypeLabel, getFactorTier, factorGlyph, factorLabel, riskAttentionLine } from './format';

describe('money', () => {
  it('formats a money string as rounded USD', () => {
    expect(money('12000.00')).toBe('$12,000');
    expect(money('999999.49')).toBe('$999,999');
    expect(money('0')).toBe('$0');
  });

  it('returns an em dash for null', () => {
    expect(money(null)).toBe('—');
  });

  it('returns the original string when not numeric', () => {
    expect(money('n/a')).toBe('n/a');
  });
});

describe('venueTypeLabel', () => {
  it('humanizes an internal venue_type', () => {
    expect(venueTypeLabel('night_club')).toBe('Night Club');
    expect(venueTypeLabel('bar')).toBe('Bar');
    expect(venueTypeLabel('live_music_venue')).toBe('Live Music Venue');
  });
});

describe('getFactorTier', () => {
  it('buckets scores at the 85 / 65 boundaries', () => {
    expect(getFactorTier(90)).toBe('good');
    expect(getFactorTier(85)).toBe('good');
    expect(getFactorTier(84)).toBe('moderate');
    expect(getFactorTier(65)).toBe('moderate');
    expect(getFactorTier(64)).toBe('poor');
    expect(getFactorTier(0)).toBe('poor');
  });
});

describe('factorGlyph', () => {
  it('maps each tier to its glyph', () => {
    expect(factorGlyph('good')).toBe('✓');
    expect(factorGlyph('moderate')).toBe('–');
    expect(factorGlyph('poor')).toBe('⚠');
  });
});

describe('factorLabel', () => {
  it('maps known factor keys to title-cased labels', () => {
    expect(factorLabel('incident_history')).toBe('Safety record');
    expect(factorLabel('operational')).toBe('Operational health');
    expect(factorLabel('business_profile')).toBe('Business profile');
  });

  it('falls back to a humanized key for unknown factors', () => {
    expect(factorLabel('crowd_density')).toBe('Crowd density');
  });
});

describe('riskAttentionLine', () => {
  it('names the lowest-scoring poor factor and prioritizes poor over moderate', () => {
    const r = riskAttentionLine({ incident_history: 100, operational: 24, business_profile: 70 });
    expect(r.tier).toBe('poor');
    expect(r.text).toBe('Operational health needs attention');
  });

  it('counts additional factors sharing the worst tier', () => {
    const r = riskAttentionLine({ operational: 24, compliance: 40, business_profile: 70 });
    expect(r.tier).toBe('poor');
    expect(r.text).toBe('Operational health needs attention · +1 more');
  });

  it('falls back to moderate language when nothing is poor', () => {
    const r = riskAttentionLine({ incident_history: 100, business_profile: 75 });
    expect(r.tier).toBe('moderate');
    expect(r.text).toBe('Business profile could be stronger');
  });

  it('reports all-healthy when every factor is good', () => {
    const r = riskAttentionLine({ incident_history: 100, compliance: 100, operational: 90 });
    expect(r).toEqual({ text: 'All factors healthy', tier: 'good' });
  });

  it('handles an empty factors map', () => {
    expect(riskAttentionLine({})).toEqual({ text: 'No risk factors yet', tier: 'good' });
  });
});
