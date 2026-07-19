/// <reference types="vite/client" />

import type { AnchorApi } from "./shared/anchor-api";

declare global {
  interface Window {
    anchor: AnchorApi;
  }
}

export {};
