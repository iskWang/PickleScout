import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProviderSelector from './index';
import type { LLMConfig } from '../../types';

const customConfig: LLMConfig = { provider: 'custom', apiKey: 'secret', model: 'my-model' };

describe('ProviderSelector custom provider', () => {
  it('marks Base URL as required when custom provider is selected', () => {
    render(<ProviderSelector value={customConfig} onChange={() => {}} />);

    expect(screen.getByLabelText('Base URL')).toBeRequired();
  });
});
