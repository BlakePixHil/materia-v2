import '@angular/compiler';
import '@analogjs/vitest-angular/setup-snapshots';
// DOM matchers (toHaveAttribute, toBeDisabled, …) for the Testing Library specs (FND-08).
import '@testing-library/jest-dom/vitest';
import { setupTestBed } from '@analogjs/vitest-angular/setup-testbed';

setupTestBed();
