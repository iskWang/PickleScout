import '@testing-library/jest-dom';
import { beforeEach } from 'vitest';

class TestStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(String(key)) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(String(key));
  }

  setItem(key: string, value: string) {
    this.values.set(String(key), String(value));
  }
}

const testStorage = new TestStorage();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: testStorage,
});
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: testStorage,
});

beforeEach(() => {
  testStorage.clear();
});
