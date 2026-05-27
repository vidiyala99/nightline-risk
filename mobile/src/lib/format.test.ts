import { money, venueTypeLabel, getFactorTier, factorGlyph } from './format';

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
