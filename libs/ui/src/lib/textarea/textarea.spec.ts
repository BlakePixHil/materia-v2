import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { render, screen } from '@testing-library/angular';
import userEvent from '@testing-library/user-event';

import { MtTextarea } from './textarea';

describe('MtTextarea', () => {
  @Component({
    imports: [MtTextarea, ReactiveFormsModule],
    template: `<mt-textarea label="File note" [maxLength]="200" [formControl]="note" />`,
  })
  class Host {
    readonly note = new FormControl('', { nonNullable: true, validators: [Validators.required] });
  }

  it('is a labelled textbox that round-trips the value and counts characters', async () => {
    const { fixture } = await render(Host);
    const textarea = screen.getByRole('textbox', { name: 'File note' });
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveAttribute('maxlength', '200');
    expect(screen.getByText('0 of 200 characters')).toBeInTheDocument();

    await userEvent.type(textarea, 'Called the executor.');
    expect(fixture.componentInstance.note.value).toBe('Called the executor.');
    expect(screen.getByText('20 of 200 characters')).toBeInTheDocument();

    fixture.componentInstance.note.setValue('Original will received.');
    await fixture.whenStable();
    expect(textarea).toHaveValue('Original will received.');
  });

  it('shows the error once touched and renders data-disabled when disabled', async () => {
    const { fixture } = await render(Host);
    const textarea = screen.getByRole('textbox');
    await userEvent.click(textarea);
    await userEvent.tab();
    await fixture.whenStable();
    expect(screen.getByText('Fill in this field.')).toHaveClass('mt-error');
    expect(textarea.closest('.mt-input')).toHaveAttribute('data-invalid');

    fixture.componentInstance.note.disable();
    await fixture.whenStable();
    expect(textarea).toBeDisabled();
    expect(textarea.closest('.mt-input')).toHaveAttribute('data-disabled');
  });

  it('grows with its content up to 12 lines', async () => {
    const { fixture } = await render(Host);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 120 });
    fixture.componentInstance.note.setValue('one\ntwo\nthree\nfour\nfive\nsix');
    await fixture.whenStable();
    expect(textarea.style.height).toBe('120px');

    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 900 });
    fixture.componentInstance.note.setValue('a very long note');
    await fixture.whenStable();
    expect(textarea.style.height).toBe('240px');
  });

  it('keeps a fixed height when autoGrow is off', async () => {
    await render(`<mt-textarea label="Instructions" [autoGrow]="false" />`, { imports: [MtTextarea] });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).style.height).toBe('');
  });
});
