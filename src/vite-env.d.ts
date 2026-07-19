/// <reference types="vite/client" />

import type { AnchorApi } from "./shared/anchor-api";

declare global {
  interface Window {
    anchor: AnchorApi;
  }

  // Monaco worker bootstrap (set in monacoSetup.ts)
  // eslint-disable-next-line no-var
  var MonacoEnvironment:
    | {
        getWorker: (moduleId: string, label: string) => Worker;
      }
    | undefined;
}

declare module "*?worker" {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

export {};
