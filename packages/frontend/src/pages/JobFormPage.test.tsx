import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import JobFormPage from './JobFormPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <JobFormPage />
    </MemoryRouter>,
  );
}

describe('JobFormPage custom provider validation', () => {
  it('blocks Enter/form submission when custom Base URL is blank', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderPage();

    fireEvent.change(screen.getByLabelText('LLM Provider'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'custom-model' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'secret' } });
    fireEvent.submit(screen.getByRole('button', { name: /Generate Tests/i }).closest('form')!);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
