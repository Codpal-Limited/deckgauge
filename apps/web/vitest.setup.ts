// The standard vitest entry. This used to import the matchers manually and call
// `expect.extend` because apps/web ran vitest 1.x while the workspace root ran
// 4.x: jest-dom's CJS entry does a bare `require('vitest')`, which resolved from
// its own place in the pnpm store up to the ROOT's 4.x, so the matchers extended
// a different `expect` than the one this app's runner used. Both are on the same
// major now, which is the condition that workaround named for its own removal.
//
// Keeping it would not have been merely redundant. With both on 4.x the manual
// extension bound `toBeInTheDocument` to a different realm than the runner's,
// and the failure was a liar: `findByText` located the element and the MATCHER
// then reported "element could not be found in the document" about a node that
// was demonstrably rendered.
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// This environment's jsdom exposes a `localStorage` object that is missing the
// full Storage API (e.g. `clear()` is not a function), which crashes any test
// whose setup calls localStorage.clear(). Install a complete in-memory Storage
// so persistence-backed hooks (useSidebarUiState, useCollapsedGroups, …) test
// cleanly.
function installMemoryStorage(): void {
  const create = (): Storage => {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      key: (i: number) => Array.from(map.keys())[i] ?? null,
    } as Storage;
  };
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const current = (globalThis as Record<string, unknown>)[name] as Storage | undefined;
    if (!current || typeof current.clear !== 'function') {
      const storage = create();
      Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
      if (typeof window !== 'undefined') {
        Object.defineProperty(window, name, { value: storage, configurable: true, writable: true });
      }
    }
  }
}
installMemoryStorage();

// jsdom ships an older Blob that lacks arrayBuffer(), stream(), and text().
// undici's FormData serialiser calls these methods when encoding File/Blob
// entries into a multipart body; without them the ReadableStream it produces
// never emits data, causing Request.formData() / .text() / .arrayBuffer() to
// hang indefinitely.  The polyfills below restore the missing APIs so that
// multipart requests containing File/Blob entries work correctly in tests.
if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

if (typeof Blob !== 'undefined' && !Blob.prototype.text) {
  Blob.prototype.text = function (this: Blob): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

if (typeof Blob !== 'undefined' && !Blob.prototype.stream) {
  Object.defineProperty(Blob.prototype, 'stream', {
    value: function (this: Blob): ReadableStream<Uint8Array> {
      const bufferPromise = this.arrayBuffer();
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          const buf = await bufferPromise;
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        },
      });
    },
    writable: true,
    configurable: true,
  });
}

// recharts ResponsiveContainer relies on ResizeObserver to set chart dimensions.
// jsdom does not implement ResizeObserver, so charts render at 0×0 and emit no SVG.
// This mock reports a fixed 800×400 size so recharts renders normally in unit tests.
global.ResizeObserver = class ResizeObserver {
  private callback: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
  }
  observe(_target: Element) {
    this.callback(
      [{ contentRect: { width: 800, height: 400 } } as ResizeObserverEntry],
      this,
    );
  }
  unobserve() {}
  disconnect() {}
};

// Mock next-auth/react for client component tests
vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
  useSession: () => ({ data: null, status: 'unauthenticated' }),
}));

// Mock SessionExpiredContext for components using useAuthFetch
vi.mock('./app/components/SessionExpiredContext', () => ({
  SessionExpiredProvider: ({ children }: { children: React.ReactNode }) => children,
  useSessionExpired: () => ({
    isSessionExpired: false,
    setSessionExpired: () => {},
  }),
}));

// Mock @/auth for server-side auth (used by api.ts)
vi.mock('@/auth', () => ({
  auth: () => Promise.resolve(null),
  signIn: () => Promise.resolve(),
  signOut: () => Promise.resolve(),
}));
