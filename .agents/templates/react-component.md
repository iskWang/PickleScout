# React Component Template

```tsx
import React from 'react';
import './ComponentName.css';

interface ComponentNameProps {
  label: string;
  onClick?: () => void;
}

/**
 * ComponentName - Briefly describe the component purpose.
 */
export const ComponentName: React.FC<ComponentNameProps> = ({ label, onClick }) => {
  return (
    <div className="component-name-root" onClick={onClick}>
      {label}
    </div>
  );
};
```

## Associated Test Template

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { ComponentName } from './index';

describe('ComponentName', () => {
  it('renders labels correctly', () => {
    render(<ComponentName label="Test Label" />);
    expect(screen.getByText('Test Label')).toBeInTheDocument();
  });
});
```
